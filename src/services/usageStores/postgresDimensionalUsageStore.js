const postgres = require('../../models/postgres')

const GRANULARITIES = new Set(['minute', 'hour', 'day'])
const DIMENSIONS = new Set(['account', 'apiKey', 'model'])
const COST_TOLERANCE = 0.000001
const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const LOCK_KEYS = {
  minute: 17361001,
  hour: 17361002,
  day: 17361003
}

const DIMENSIONAL_USAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_dimensional_rollups (
  granularity TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'usage_events',
  account_type TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  api_key_id TEXT NOT NULL,
  normalized_model TEXT NOT NULL DEFAULT 'unknown',
  usage_request_count BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_create_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  ephemeral_5m_tokens BIGINT NOT NULL DEFAULT 0,
  ephemeral_1h_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  long_context_requests BIGINT NOT NULL DEFAULT 0,
  cost NUMERIC(20,8) NOT NULL DEFAULT 0,
  real_cost NUMERIC(20,8) NOT NULL DEFAULT 0,
  input_cost NUMERIC(20,8) NOT NULL DEFAULT 0,
  output_cost NUMERIC(20,8) NOT NULL DEFAULT 0,
  cache_create_cost NUMERIC(20,8) NOT NULL DEFAULT 0,
  cache_read_cost NUMERIC(20,8) NOT NULL DEFAULT 0,
  ephemeral_5m_cost NUMERIC(20,8) NOT NULL DEFAULT 0,
  ephemeral_1h_cost NUMERIC(20,8) NOT NULL DEFAULT 0,
  first_event_at TIMESTAMPTZ,
  last_event_at TIMESTAMPTZ,
  source_event_count BIGINT NOT NULL DEFAULT 0,
  aggregated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (
    granularity,
    bucket_start,
    account_type,
    account_id,
    api_key_id,
    normalized_model
  ),
  CHECK (granularity IN ('minute', 'hour', 'day'))
) PARTITION BY LIST (granularity);

ALTER TABLE usage_dimensional_rollups
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'usage_events';

CREATE TABLE IF NOT EXISTS usage_dimensional_rollups_minute
  PARTITION OF usage_dimensional_rollups FOR VALUES IN ('minute');
CREATE TABLE IF NOT EXISTS usage_dimensional_rollups_hour
  PARTITION OF usage_dimensional_rollups FOR VALUES IN ('hour');
CREATE TABLE IF NOT EXISTS usage_dimensional_rollups_day
  PARTITION OF usage_dimensional_rollups FOR VALUES IN ('day');

CREATE INDEX IF NOT EXISTS idx_usage_dimensional_bucket
  ON usage_dimensional_rollups (granularity, bucket_start DESC);
CREATE INDEX IF NOT EXISTS idx_usage_dimensional_account_bucket
  ON usage_dimensional_rollups (
    granularity,
    account_type,
    account_id,
    bucket_start DESC
  );
CREATE INDEX IF NOT EXISTS idx_usage_dimensional_api_key_bucket
  ON usage_dimensional_rollups (granularity, api_key_id, bucket_start DESC);
CREATE INDEX IF NOT EXISTS idx_usage_dimensional_model_bucket
  ON usage_dimensional_rollups (granularity, normalized_model, bucket_start DESC);

CREATE TABLE IF NOT EXISTS usage_rollup_validation (
  business_timezone TEXT NOT NULL,
  usage_date DATE NOT NULL,
  source_event_count BIGINT NOT NULL DEFAULT 0,
  rollup_request_count BIGINT NOT NULL DEFAULT 0,
  source_total_tokens BIGINT NOT NULL DEFAULT 0,
  rollup_total_tokens BIGINT NOT NULL DEFAULT 0,
  source_cost NUMERIC(20,8) NOT NULL DEFAULT 0,
  rollup_cost NUMERIC(20,8) NOT NULL DEFAULT 0,
  source_real_cost NUMERIC(20,8) NOT NULL DEFAULT 0,
  rollup_real_cost NUMERIC(20,8) NOT NULL DEFAULT 0,
  unknown_account_count BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_timezone, usage_date),
  CHECK (status IN ('verified', 'mismatch'))
);

CREATE INDEX IF NOT EXISTS idx_usage_rollup_validation_status_date
  ON usage_rollup_validation (status, usage_date DESC);
`

let schemaPromise = null

function normalizeGranularity(value) {
  const normalized = String(value || '').toLowerCase()
  if (!GRANULARITIES.has(normalized)) {
    throw new Error(`Unsupported usage rollup granularity: ${value}`)
  }
  return normalized
}

function normalizeDate(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date
}

function normalizeInteger(value, fallback = 0) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : fallback
}

function normalizeNumber(value, precision = null) {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) {
    return 0
  }
  return precision === null ? numberValue : Number(numberValue.toFixed(precision))
}

function normalizeText(value, fallback = '') {
  if (value === null || value === undefined) {
    return fallback
  }
  const normalized = String(value).split('\u0000').join('').trim()
  return normalized || fallback
}

function toBigInt(value) {
  try {
    return BigInt(value || 0)
  } catch (_error) {
    return 0n
  }
}

function intervalForGranularity(granularity) {
  if (granularity === 'minute') {
    return '1 minute'
  }
  if (granularity === 'hour') {
    return '1 hour'
  }
  return '1 day'
}

function buildBucketExpression(granularity, timestampColumn, timezoneParameter) {
  return `date_trunc(
    '${granularity}',
    ${timestampColumn} AT TIME ZONE ${timezoneParameter}
  ) AT TIME ZONE ${timezoneParameter}`
}

function costPartExpression(field) {
  return `COALESCE(
    NULLIF(real_cost_breakdown ->> '${field}', '')::numeric,
    NULLIF(cost_breakdown ->> '${field}', '')::numeric,
    0
  )`
}

function optionalCostPartExpression(field) {
  return `COALESCE(
    NULLIF(real_cost_breakdown ->> '${field}', '')::numeric,
    NULLIF(cost_breakdown ->> '${field}', '')::numeric
  )`
}

function rowToUsageMetrics(row = {}) {
  return {
    requests: normalizeInteger(row.requests ?? row.usage_request_count ?? row.request_count),
    inputTokens: normalizeInteger(row.inputTokens ?? row.input_tokens),
    outputTokens: normalizeInteger(row.outputTokens ?? row.output_tokens),
    cacheCreateTokens: normalizeInteger(row.cacheCreateTokens ?? row.cache_create_tokens),
    cacheReadTokens: normalizeInteger(row.cacheReadTokens ?? row.cache_read_tokens),
    ephemeral5mTokens: normalizeInteger(row.ephemeral5mTokens ?? row.ephemeral_5m_tokens),
    ephemeral1hTokens: normalizeInteger(row.ephemeral1hTokens ?? row.ephemeral_1h_tokens),
    totalTokens: normalizeInteger(row.totalTokens ?? row.total_tokens),
    allTokens: normalizeInteger(row.allTokens ?? row.totalTokens ?? row.total_tokens),
    longContextRequests: normalizeInteger(row.longContextRequests ?? row.long_context_requests),
    cost: normalizeNumber(row.cost, 8),
    realCost: normalizeNumber(row.realCost ?? row.real_cost, 8),
    inputCost: normalizeNumber(row.inputCost ?? row.input_cost, 8),
    outputCost: normalizeNumber(row.outputCost ?? row.output_cost, 8),
    cacheCreateCost: normalizeNumber(row.cacheCreateCost ?? row.cache_create_cost, 8),
    cacheReadCost: normalizeNumber(row.cacheReadCost ?? row.cache_read_cost, 8),
    ephemeral5mCost: normalizeNumber(row.ephemeral5mCost ?? row.ephemeral_5m_cost, 8),
    ephemeral1hCost: normalizeNumber(row.ephemeral1hCost ?? row.ephemeral_1h_cost, 8)
  }
}

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = postgres.query(DIMENSIONAL_USAGE_SCHEMA_SQL).catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  await schemaPromise
}

async function materializeRange({
  granularity,
  startDate,
  endDate,
  businessTimezone = DEFAULT_TIMEZONE
} = {}) {
  const normalizedGranularity = normalizeGranularity(granularity)
  const start = normalizeDate(startDate)
  const end = normalizeDate(endDate)
  if (!start || !end || start >= end) {
    throw new Error('Valid startDate and endDate are required for usage materialization')
  }

  await ensureSchema()
  const bucketExpression = buildBucketExpression(normalizedGranularity, 'timestamp', '$3')

  return postgres.transaction(async (client) => {
    const lockResult = await client.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [
      LOCK_KEYS[normalizedGranularity]
    ])
    if (lockResult.rows[0]?.acquired !== true) {
      return {
        materialized: false,
        reason: 'locked',
        granularity: normalizedGranularity,
        rows: 0
      }
    }

    const deletedResult = await client.query(
      `
        DELETE FROM usage_dimensional_rollups
        WHERE granularity = $1
          AND bucket_start >= $2
          AND bucket_start < $3
      `,
      [normalizedGranularity, start, end]
    )
    const result = await client.query(
      `
        INSERT INTO usage_dimensional_rollups (
          granularity,
          bucket_start,
          source_type,
          account_type,
          account_id,
          api_key_id,
          normalized_model,
          usage_request_count,
          input_tokens,
          output_tokens,
          cache_create_tokens,
          cache_read_tokens,
          ephemeral_5m_tokens,
          ephemeral_1h_tokens,
          total_tokens,
          long_context_requests,
          cost,
          real_cost,
          input_cost,
          output_cost,
          cache_create_cost,
          cache_read_cost,
          ephemeral_5m_cost,
          ephemeral_1h_cost,
          first_event_at,
          last_event_at,
          source_event_count,
          aggregated_at
        )
        SELECT
          $4,
          ${bucketExpression},
          'usage_events',
          COALESCE(NULLIF(account_type, ''), ''),
          COALESCE(NULLIF(account_id, ''), ''),
          api_key_id,
          COALESCE(NULLIF(normalized_model, ''), 'unknown'),
          COUNT(*)::bigint,
          COALESCE(SUM(input_tokens), 0)::bigint,
          COALESCE(SUM(output_tokens), 0)::bigint,
          COALESCE(SUM(cache_create_tokens), 0)::bigint,
          COALESCE(SUM(cache_read_tokens), 0)::bigint,
          COALESCE(SUM(ephemeral_5m_tokens), 0)::bigint,
          COALESCE(SUM(ephemeral_1h_tokens), 0)::bigint,
          COALESCE(SUM(total_tokens), 0)::bigint,
          COALESCE(
            SUM(CASE WHEN is_long_context_request THEN 1 ELSE 0 END),
            0
          )::bigint,
          COALESCE(SUM(cost), 0)::numeric,
          COALESCE(SUM(real_cost), 0)::numeric,
          COALESCE(SUM(${costPartExpression('input')}), 0)::numeric,
          COALESCE(SUM(${costPartExpression('output')}), 0)::numeric,
          COALESCE(
            SUM(
              COALESCE(
                ${optionalCostPartExpression('cacheCreate')},
                ${optionalCostPartExpression('cacheWrite')},
                0
              )
            ),
            0
          )::numeric,
          COALESCE(SUM(${costPartExpression('cacheRead')}), 0)::numeric,
          COALESCE(SUM(${costPartExpression('ephemeral5m')}), 0)::numeric,
          COALESCE(SUM(${costPartExpression('ephemeral1h')}), 0)::numeric,
          MIN(timestamp),
          MAX(timestamp),
          COUNT(*)::bigint,
          now()
        FROM usage_events
        WHERE timestamp >= $1
          AND timestamp < $2
        GROUP BY
          ${bucketExpression},
          COALESCE(NULLIF(account_type, ''), ''),
          COALESCE(NULLIF(account_id, ''), ''),
          api_key_id,
          COALESCE(NULLIF(normalized_model, ''), 'unknown')
        ON CONFLICT (
          granularity,
          bucket_start,
          account_type,
          account_id,
          api_key_id,
          normalized_model
        )
        DO UPDATE SET
          usage_request_count = EXCLUDED.usage_request_count,
          source_type = EXCLUDED.source_type,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cache_create_tokens = EXCLUDED.cache_create_tokens,
          cache_read_tokens = EXCLUDED.cache_read_tokens,
          ephemeral_5m_tokens = EXCLUDED.ephemeral_5m_tokens,
          ephemeral_1h_tokens = EXCLUDED.ephemeral_1h_tokens,
          total_tokens = EXCLUDED.total_tokens,
          long_context_requests = EXCLUDED.long_context_requests,
          cost = EXCLUDED.cost,
          real_cost = EXCLUDED.real_cost,
          input_cost = EXCLUDED.input_cost,
          output_cost = EXCLUDED.output_cost,
          cache_create_cost = EXCLUDED.cache_create_cost,
          cache_read_cost = EXCLUDED.cache_read_cost,
          ephemeral_5m_cost = EXCLUDED.ephemeral_5m_cost,
          ephemeral_1h_cost = EXCLUDED.ephemeral_1h_cost,
          first_event_at = EXCLUDED.first_event_at,
          last_event_at = EXCLUDED.last_event_at,
          source_event_count = EXCLUDED.source_event_count,
          aggregated_at = now()
      `,
      [start, end, businessTimezone, normalizedGranularity]
    )

    return {
      materialized: true,
      granularity: normalizedGranularity,
      rows: result.rowCount,
      replacedRows: deletedResult.rowCount,
      startDate: start.toISOString(),
      endDate: end.toISOString()
    }
  })
}

function normalizeAggregateRow(row = {}, sourceType = 'langfuse') {
  const granularity = normalizeGranularity(row.granularity || 'day')
  const bucketStart = normalizeDate(row.bucketStart || row.bucket_start)
  if (!bucketStart) {
    throw new Error('Aggregated usage row requires bucketStart')
  }
  const inputTokens = normalizeInteger(row.inputTokens ?? row.input_tokens)
  const outputTokens = normalizeInteger(row.outputTokens ?? row.output_tokens)
  const cacheCreateTokens = normalizeInteger(row.cacheCreateTokens ?? row.cache_create_tokens)
  const cacheReadTokens = normalizeInteger(row.cacheReadTokens ?? row.cache_read_tokens)
  const cost = normalizeNumber(row.cost, 8)
  return {
    granularity,
    bucketStart: bucketStart.toISOString(),
    sourceType: normalizeText(row.sourceType || row.source_type, sourceType),
    accountType: normalizeText(row.accountType || row.account_type),
    accountId: normalizeText(row.accountId || row.account_id),
    apiKeyId: normalizeText(row.apiKeyId || row.api_key_id, 'unknown'),
    normalizedModel: normalizeText(
      row.normalizedModel || row.normalized_model || row.model,
      'unknown'
    ),
    usageRequestCount: normalizeInteger(
      row.usageRequestCount ?? row.usage_request_count ?? row.requests
    ),
    inputTokens,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    ephemeral5mTokens: normalizeInteger(row.ephemeral5mTokens ?? row.ephemeral_5m_tokens),
    ephemeral1hTokens: normalizeInteger(row.ephemeral1hTokens ?? row.ephemeral_1h_tokens),
    totalTokens:
      normalizeInteger(row.totalTokens ?? row.total_tokens) ||
      inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens,
    longContextRequests: normalizeInteger(row.longContextRequests ?? row.long_context_requests),
    cost,
    realCost: normalizeNumber(row.realCost ?? row.real_cost ?? cost, 8),
    inputCost: normalizeNumber(row.inputCost ?? row.input_cost, 8),
    outputCost: normalizeNumber(row.outputCost ?? row.output_cost, 8),
    cacheCreateCost: normalizeNumber(row.cacheCreateCost ?? row.cache_create_cost, 8),
    cacheReadCost: normalizeNumber(row.cacheReadCost ?? row.cache_read_cost, 8),
    ephemeral5mCost: normalizeNumber(row.ephemeral5mCost ?? row.ephemeral_5m_cost, 8),
    ephemeral1hCost: normalizeNumber(row.ephemeral1hCost ?? row.ephemeral_1h_cost, 8),
    sourceEventCount: normalizeInteger(
      row.sourceEventCount ?? row.source_event_count ?? row.requests
    )
  }
}

async function upsertAggregatedRows(rows = [], options = {}) {
  await ensureSchema()
  const sourceType = normalizeText(options.sourceType, 'langfuse')
  const normalizedRows = rows.map((row) => normalizeAggregateRow(row, sourceType))
  if (normalizedRows.length === 0) {
    return { upserted: 0 }
  }

  const result = await postgres.query(
    `
      INSERT INTO usage_dimensional_rollups (
        granularity,
        bucket_start,
        source_type,
        account_type,
        account_id,
        api_key_id,
        normalized_model,
        usage_request_count,
        input_tokens,
        output_tokens,
        cache_create_tokens,
        cache_read_tokens,
        ephemeral_5m_tokens,
        ephemeral_1h_tokens,
        total_tokens,
        long_context_requests,
        cost,
        real_cost,
        input_cost,
        output_cost,
        cache_create_cost,
        cache_read_cost,
        ephemeral_5m_cost,
        ephemeral_1h_cost,
        source_event_count,
        aggregated_at
      )
      SELECT
        payload.granularity,
        payload.bucket_start,
        payload.source_type,
        payload.account_type,
        payload.account_id,
        payload.api_key_id,
        payload.normalized_model,
        payload.usage_request_count,
        payload.input_tokens,
        payload.output_tokens,
        payload.cache_create_tokens,
        payload.cache_read_tokens,
        payload.ephemeral_5m_tokens,
        payload.ephemeral_1h_tokens,
        payload.total_tokens,
        payload.long_context_requests,
        payload.cost,
        payload.real_cost,
        payload.input_cost,
        payload.output_cost,
        payload.cache_create_cost,
        payload.cache_read_cost,
        payload.ephemeral_5m_cost,
        payload.ephemeral_1h_cost,
        payload.source_event_count,
        now()
      FROM jsonb_to_recordset($1::jsonb) AS payload(
        granularity text,
        bucket_start timestamptz,
        source_type text,
        account_type text,
        account_id text,
        api_key_id text,
        normalized_model text,
        usage_request_count bigint,
        input_tokens bigint,
        output_tokens bigint,
        cache_create_tokens bigint,
        cache_read_tokens bigint,
        ephemeral_5m_tokens bigint,
        ephemeral_1h_tokens bigint,
        total_tokens bigint,
        long_context_requests bigint,
        cost numeric,
        real_cost numeric,
        input_cost numeric,
        output_cost numeric,
        cache_create_cost numeric,
        cache_read_cost numeric,
        ephemeral_5m_cost numeric,
        ephemeral_1h_cost numeric,
        source_event_count bigint
      )
      ON CONFLICT (
        granularity,
        bucket_start,
        account_type,
        account_id,
        api_key_id,
        normalized_model
      )
      DO UPDATE SET
        source_type = EXCLUDED.source_type,
        usage_request_count = EXCLUDED.usage_request_count,
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        cache_create_tokens = EXCLUDED.cache_create_tokens,
        cache_read_tokens = EXCLUDED.cache_read_tokens,
        ephemeral_5m_tokens = EXCLUDED.ephemeral_5m_tokens,
        ephemeral_1h_tokens = EXCLUDED.ephemeral_1h_tokens,
        total_tokens = EXCLUDED.total_tokens,
        long_context_requests = EXCLUDED.long_context_requests,
        cost = EXCLUDED.cost,
        real_cost = EXCLUDED.real_cost,
        input_cost = EXCLUDED.input_cost,
        output_cost = EXCLUDED.output_cost,
        cache_create_cost = EXCLUDED.cache_create_cost,
        cache_read_cost = EXCLUDED.cache_read_cost,
        ephemeral_5m_cost = EXCLUDED.ephemeral_5m_cost,
        ephemeral_1h_cost = EXCLUDED.ephemeral_1h_cost,
        source_event_count = EXCLUDED.source_event_count,
        aggregated_at = now()
    `,
    [
      JSON.stringify(
        normalizedRows.map((row) => ({
          granularity: row.granularity,
          bucket_start: row.bucketStart,
          source_type: row.sourceType,
          account_type: row.accountType,
          account_id: row.accountId,
          api_key_id: row.apiKeyId,
          normalized_model: row.normalizedModel,
          usage_request_count: row.usageRequestCount,
          input_tokens: row.inputTokens,
          output_tokens: row.outputTokens,
          cache_create_tokens: row.cacheCreateTokens,
          cache_read_tokens: row.cacheReadTokens,
          ephemeral_5m_tokens: row.ephemeral5mTokens,
          ephemeral_1h_tokens: row.ephemeral1hTokens,
          total_tokens: row.totalTokens,
          long_context_requests: row.longContextRequests,
          cost: row.cost,
          real_cost: row.realCost,
          input_cost: row.inputCost,
          output_cost: row.outputCost,
          cache_create_cost: row.cacheCreateCost,
          cache_read_cost: row.cacheReadCost,
          ephemeral_5m_cost: row.ephemeral5mCost,
          ephemeral_1h_cost: row.ephemeral1hCost,
          source_event_count: row.sourceEventCount
        }))
      )
    ]
  )

  return { upserted: result.rowCount }
}

async function resolveBusinessDayRange(usageDate, businessTimezone = DEFAULT_TIMEZONE) {
  const dateText =
    usageDate instanceof Date ? usageDate.toISOString().slice(0, 10) : String(usageDate || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    throw new Error(`Invalid usage date: ${usageDate}`)
  }

  const result = await postgres.query(
    `
      SELECT
        $1::date AS usage_date,
        $1::date::timestamp AT TIME ZONE $2 AS start_at,
        ($1::date + 1)::timestamp AT TIME ZONE $2 AS end_at
    `,
    [dateText, businessTimezone]
  )

  return {
    usageDate: dateText,
    startDate: normalizeDate(result.rows[0].start_at),
    endDate: normalizeDate(result.rows[0].end_at)
  }
}

async function validateDay(usageDate, businessTimezone = DEFAULT_TIMEZONE) {
  await ensureSchema()
  const range = await resolveBusinessDayRange(usageDate, businessTimezone)
  const [sourceResult, rollupResult] = await Promise.all([
    postgres.query(
      `
        SELECT
          COUNT(*)::bigint AS event_count,
          COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
          COALESCE(SUM(cost), 0)::numeric AS cost,
          COALESCE(SUM(real_cost), 0)::numeric AS real_cost,
          COUNT(*) FILTER (
            WHERE account_id IS NULL OR account_id = ''
          )::bigint AS unknown_account_count
        FROM usage_events
        WHERE timestamp >= $1
          AND timestamp < $2
      `,
      [range.startDate, range.endDate]
    ),
    postgres.query(
      `
        SELECT
          COALESCE(SUM(usage_request_count), 0)::bigint AS request_count,
          COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
          COALESCE(SUM(cost), 0)::numeric AS cost,
          COALESCE(SUM(real_cost), 0)::numeric AS real_cost
        FROM usage_dimensional_rollups
        WHERE granularity = 'day'
          AND bucket_start = $1
      `,
      [range.startDate]
    )
  ])

  const source = sourceResult.rows[0] || {}
  const rollup = rollupResult.rows[0] || {}
  const requestCountMatches = toBigInt(source.event_count) === toBigInt(rollup.request_count)
  const tokenCountMatches = toBigInt(source.total_tokens) === toBigInt(rollup.total_tokens)
  const costDifference = Math.abs(normalizeNumber(source.cost) - normalizeNumber(rollup.cost))
  const realCostDifference = Math.abs(
    normalizeNumber(source.real_cost) - normalizeNumber(rollup.real_cost)
  )
  const accountDimensionComplete = toBigInt(source.unknown_account_count) === 0n
  const verified =
    requestCountMatches &&
    tokenCountMatches &&
    accountDimensionComplete &&
    costDifference <= COST_TOLERANCE &&
    realCostDifference <= COST_TOLERANCE
  const status = verified ? 'verified' : 'mismatch'
  const details = {
    requestCountMatches,
    tokenCountMatches,
    accountDimensionComplete,
    costDifference,
    realCostDifference,
    tolerance: COST_TOLERANCE
  }

  await postgres.query(
    `
      INSERT INTO usage_rollup_validation (
        business_timezone,
        usage_date,
        source_event_count,
        rollup_request_count,
        source_total_tokens,
        rollup_total_tokens,
        source_cost,
        rollup_cost,
        source_real_cost,
        rollup_real_cost,
        unknown_account_count,
        status,
        details,
        checked_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, now()
      )
      ON CONFLICT (business_timezone, usage_date)
      DO UPDATE SET
        source_event_count = EXCLUDED.source_event_count,
        rollup_request_count = EXCLUDED.rollup_request_count,
        source_total_tokens = EXCLUDED.source_total_tokens,
        rollup_total_tokens = EXCLUDED.rollup_total_tokens,
        source_cost = EXCLUDED.source_cost,
        rollup_cost = EXCLUDED.rollup_cost,
        source_real_cost = EXCLUDED.source_real_cost,
        rollup_real_cost = EXCLUDED.rollup_real_cost,
        unknown_account_count = EXCLUDED.unknown_account_count,
        status = EXCLUDED.status,
        details = EXCLUDED.details,
        checked_at = now()
    `,
    [
      businessTimezone,
      range.usageDate,
      source.event_count || 0,
      rollup.request_count || 0,
      source.total_tokens || 0,
      rollup.total_tokens || 0,
      source.cost || 0,
      rollup.cost || 0,
      source.real_cost || 0,
      rollup.real_cost || 0,
      source.unknown_account_count || 0,
      status,
      JSON.stringify(details)
    ]
  )

  return {
    businessTimezone,
    usageDate: range.usageDate,
    status,
    verified,
    sourceEventCount: normalizeInteger(source.event_count),
    rollupRequestCount: normalizeInteger(rollup.request_count),
    sourceTotalTokens: normalizeInteger(source.total_tokens),
    rollupTotalTokens: normalizeInteger(rollup.total_tokens),
    sourceCost: normalizeNumber(source.cost, 8),
    rollupCost: normalizeNumber(rollup.cost, 8),
    sourceRealCost: normalizeNumber(source.real_cost, 8),
    rollupRealCost: normalizeNumber(rollup.real_cost, 8),
    unknownAccountCount: normalizeInteger(source.unknown_account_count),
    details
  }
}

async function cleanupExpiredRollups({
  minuteRetentionHours,
  hourlyRetentionDays,
  now = new Date()
} = {}) {
  await ensureSchema()
  const minuteHours = Math.max(1, normalizeInteger(minuteRetentionHours, 48))
  const hourDays = Math.max(1, normalizeInteger(hourlyRetentionDays, 30))
  const minuteCutoff = new Date(now.getTime() - minuteHours * 3600000)
  const hourCutoff = new Date(now.getTime() - hourDays * 86400000)
  const [minuteResult, hourResult] = await Promise.all([
    postgres.query(
      `
        DELETE FROM usage_dimensional_rollups
        WHERE granularity = 'minute'
          AND bucket_start < $1
      `,
      [minuteCutoff]
    ),
    postgres.query(
      `
        DELETE FROM usage_dimensional_rollups
        WHERE granularity = 'hour'
          AND bucket_start < $1
      `,
      [hourCutoff]
    )
  ])

  return {
    minuteDeleted: minuteResult.rowCount,
    hourDeleted: hourResult.rowCount,
    minuteCutoff: minuteCutoff.toISOString(),
    hourCutoff: hourCutoff.toISOString()
  }
}

async function cleanupVerifiedUsageEvents({
  retentionDays,
  batchSize = 5000,
  businessTimezone = DEFAULT_TIMEZONE,
  now = new Date()
} = {}) {
  await ensureSchema()
  const days = Math.max(1, normalizeInteger(retentionDays, 14))
  const limit = Math.min(50000, Math.max(100, normalizeInteger(batchSize, 5000)))
  const cutoff = new Date(now.getTime() - days * 86400000)
  const result = await postgres.query(
    `
      WITH deletable AS (
        SELECT e.ctid
        FROM usage_events e
        INNER JOIN usage_rollup_validation v
          ON v.business_timezone = $1
          AND v.usage_date = (e.timestamp AT TIME ZONE $1)::date
          AND v.status = 'verified'
        WHERE e.timestamp < $2
        ORDER BY e.timestamp
        LIMIT $3
      )
      DELETE FROM usage_events e
      USING deletable d
      WHERE e.ctid = d.ctid
    `,
    [businessTimezone, cutoff, limit]
  )

  return {
    deletedRecords: result.rowCount,
    retentionDays: days,
    cutoff: cutoff.toISOString(),
    batchSize: limit
  }
}

function normalizeGroupBy(groupBy) {
  if (Array.isArray(groupBy) && groupBy.length === 0) {
    return []
  }
  const values = Array.isArray(groupBy)
    ? groupBy
    : String(groupBy || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
  const normalized = values.filter((item) => DIMENSIONS.has(item))
  return normalized.length > 0 ? [...new Set(normalized)] : ['account', 'apiKey', 'model']
}

function addArrayFilter(clauses, values, column, filterValues) {
  const normalized = Array.isArray(filterValues)
    ? filterValues.map((value) => normalizeText(value)).filter(Boolean)
    : []
  if (normalized.length === 0) {
    return
  }
  values.push(normalized)
  clauses.push(`${column} = ANY($${values.length}::text[])`)
}

async function queryDimensionalUsage({
  granularity = 'day',
  startDate,
  endDate,
  accountIds = [],
  accountTypes = [],
  apiKeyIds = [],
  models = [],
  groupBy = ['account', 'apiKey', 'model'],
  limit = 2000
} = {}) {
  await ensureSchema()
  const normalizedGranularity = normalizeGranularity(granularity)
  const start = normalizeDate(startDate)
  const end = normalizeDate(endDate)
  if (!start || !end || start >= end) {
    throw new Error('Valid startDate and endDate are required')
  }

  const normalizedGroupBy = normalizeGroupBy(groupBy)
  const dimensionDefinitions = {
    account: [
      ['account_type', 'account_type'],
      ['account_id', 'account_id']
    ],
    apiKey: [['api_key_id', 'api_key_id']],
    model: [['normalized_model', 'normalized_model']]
  }
  const dimensions = normalizedGroupBy.flatMap((dimension) => dimensionDefinitions[dimension])
  const selectDimensions = dimensions.map(([column, alias]) => `${column} AS ${alias}`)
  const groupDimensions = dimensions.map(([column]) => column)
  const values = [normalizedGranularity, start, end]
  const clauses = ['granularity = $1', 'bucket_start >= $2', 'bucket_start < $3']
  addArrayFilter(clauses, values, 'account_id', accountIds)
  addArrayFilter(clauses, values, 'account_type', accountTypes)
  addArrayFilter(clauses, values, 'api_key_id', apiKeyIds)
  addArrayFilter(clauses, values, 'normalized_model', models)
  values.push(Math.min(10000, Math.max(1, normalizeInteger(limit, 2000))))

  const result = await postgres.query(
    `
      SELECT
        bucket_start,
        ${selectDimensions.length > 0 ? `${selectDimensions.join(',\n        ')},` : ''}
        SUM(usage_request_count)::bigint AS usage_request_count,
        SUM(input_tokens)::bigint AS input_tokens,
        SUM(output_tokens)::bigint AS output_tokens,
        SUM(cache_create_tokens)::bigint AS cache_create_tokens,
        SUM(cache_read_tokens)::bigint AS cache_read_tokens,
        SUM(ephemeral_5m_tokens)::bigint AS ephemeral_5m_tokens,
        SUM(ephemeral_1h_tokens)::bigint AS ephemeral_1h_tokens,
        SUM(total_tokens)::bigint AS total_tokens,
        SUM(long_context_requests)::bigint AS long_context_requests,
        SUM(cost)::numeric AS cost,
        SUM(real_cost)::numeric AS real_cost,
        SUM(input_cost)::numeric AS input_cost,
        SUM(output_cost)::numeric AS output_cost,
        SUM(cache_create_cost)::numeric AS cache_create_cost,
        SUM(cache_read_cost)::numeric AS cache_read_cost,
        SUM(ephemeral_5m_cost)::numeric AS ephemeral_5m_cost,
        SUM(ephemeral_1h_cost)::numeric AS ephemeral_1h_cost
      FROM usage_dimensional_rollups
      WHERE ${clauses.join('\n        AND ')}
      GROUP BY bucket_start${groupDimensions.length > 0 ? `, ${groupDimensions.join(', ')}` : ''}
      ORDER BY bucket_start ASC${groupDimensions.length > 0 ? `, ${groupDimensions.join(', ')}` : ''}
      LIMIT $${values.length}
    `,
    values
  )

  return result.rows.map((row) => ({
    bucketStart: normalizeDate(row.bucket_start)?.toISOString() || null,
    ...(normalizedGroupBy.includes('account')
      ? {
          accountType: row.account_type || '',
          accountId: row.account_id || ''
        }
      : {}),
    ...(normalizedGroupBy.includes('apiKey') ? { apiKeyId: row.api_key_id || '' } : {}),
    ...(normalizedGroupBy.includes('model') ? { model: row.normalized_model || 'unknown' } : {}),
    ...rowToUsageMetrics(row)
  }))
}

function formatDateInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function normalizeBusinessDateText(value, fallbackDate, timezone) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim()
  }
  return formatDateInTimezone(normalizeDate(value, fallbackDate), timezone)
}

function formatTimeLabel(date, timezone, includeMinutes = false) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return includeMinutes
    ? `${values.month}/${values.day} ${values.hour}:${values.minute}`
    : `${values.month}/${values.day} ${values.hour}:00`
}

function shiftDateText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function floorToInterval(date, intervalMs) {
  return new Date(Math.floor(date.getTime() / intervalMs) * intervalMs)
}

async function buildTrendPeriods({
  granularity = 'day',
  days = 7,
  startDate = null,
  endDate = null,
  businessTimezone = DEFAULT_TIMEZONE,
  now = new Date()
} = {}) {
  const normalizedGranularity = normalizeGranularity(granularity)
  const intervalMs =
    normalizedGranularity === 'minute'
      ? 60000
      : normalizedGranularity === 'hour'
        ? 3600000
        : 86400000

  if (normalizedGranularity !== 'day') {
    const defaultPoints = normalizedGranularity === 'minute' ? 120 : 24
    const end = floorToInterval(normalizeDate(endDate, now), intervalMs)
    const start = floorToInterval(
      normalizeDate(startDate, new Date(end.getTime() - (defaultPoints - 1) * intervalMs)),
      intervalMs
    )
    if (start > end) {
      return { granularity: normalizedGranularity, periods: [], start, endExclusive: end }
    }

    const periods = []
    for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + intervalMs)) {
      periods.push({
        bucketStart: cursor,
        ...(normalizedGranularity === 'minute'
          ? {
              minute: cursor.toISOString(),
              label: formatTimeLabel(cursor, businessTimezone, true)
            }
          : {
              hour: cursor.toISOString(),
              label: formatTimeLabel(cursor, businessTimezone)
            })
      })
    }
    return {
      granularity: normalizedGranularity,
      periods,
      start,
      endExclusive: new Date(end.getTime() + intervalMs)
    }
  }

  const today = formatDateInTimezone(now, businessTimezone)
  const daysCount = Math.min(3660, Math.max(1, normalizeInteger(days, 7)))
  const startText = startDate
    ? normalizeBusinessDateText(startDate, now, businessTimezone)
    : shiftDateText(today, -(daysCount - 1))
  const endText = endDate ? normalizeBusinessDateText(endDate, now, businessTimezone) : today
  if (startText > endText) {
    return { granularity: normalizedGranularity, periods: [], start: null, endExclusive: null }
  }

  const startRange = await resolveBusinessDayRange(startText, businessTimezone)
  const endRange = await resolveBusinessDayRange(endText, businessTimezone)
  const periods = []
  let dateText = startText
  let bucketStart = startRange.startDate
  while (dateText <= endText && periods.length < 3660) {
    periods.push({
      bucketStart,
      date: dateText
    })
    dateText = shiftDateText(dateText, 1)
    bucketStart = new Date(bucketStart.getTime() + 86400000)
  }
  return {
    granularity: normalizedGranularity,
    periods,
    start: startRange.startDate,
    endExclusive: endRange.endDate
  }
}

function buildUsageTrendPoint(period, row = {}) {
  const metrics = rowToUsageMetrics(row)
  return {
    ...(period.minute ? { minute: period.minute, label: period.label } : {}),
    ...(period.hour ? { hour: period.hour, label: period.label } : {}),
    ...(period.date ? { date: period.date } : {}),
    requests: metrics.requests,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cacheCreateTokens: metrics.cacheCreateTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    ephemeral5mTokens: metrics.ephemeral5mTokens,
    ephemeral1hTokens: metrics.ephemeral1hTokens,
    allTokens: metrics.allTokens,
    totalTokens: metrics.totalTokens,
    cost: metrics.cost,
    realCost: metrics.realCost
  }
}

function rowsByBucket(rows = []) {
  return new Map(rows.map((row) => [row.bucketStart, row]))
}

async function getUsageTrend(options = {}) {
  const trend = await buildTrendPeriods(options)
  if (trend.periods.length === 0) {
    return []
  }
  const rows = await queryDimensionalUsage({
    granularity: trend.granularity,
    startDate: trend.start,
    endDate: trend.endExclusive,
    groupBy: [],
    limit: trend.periods.length
  })
  const byBucket = rowsByBucket(rows)
  return trend.periods.map((period) =>
    buildUsageTrendPoint(period, byBucket.get(period.bucketStart.toISOString()))
  )
}

async function getApiKeysUsageTrend({ apiKeys = [], ...options } = {}) {
  const trend = await buildTrendPeriods(options)
  const apiKeyIds = apiKeys.map((key) => key.id).filter(Boolean)
  const apiKeyMap = new Map(apiKeys.map((key) => [key.id, key]))
  const data = trend.periods.map((period) => ({
    ...(period.minute ? { minute: period.minute, label: period.label } : {}),
    ...(period.hour ? { hour: period.hour, label: period.label } : {}),
    ...(period.date ? { date: period.date } : {}),
    apiKeys: {}
  }))
  if (trend.periods.length === 0 || apiKeyIds.length === 0) {
    return { data, topApiKeys: [], totalApiKeys: apiKeyIds.length }
  }

  const rows = await queryDimensionalUsage({
    granularity: trend.granularity,
    startDate: trend.start,
    endDate: trend.endExclusive,
    apiKeyIds,
    groupBy: ['apiKey'],
    limit: Math.min(10000, trend.periods.length * apiKeyIds.length)
  })
  const points = new Map(
    trend.periods.map((period, index) => [period.bucketStart.toISOString(), data[index]])
  )
  const totals = new Map()
  for (const row of rows) {
    const point = points.get(row.bucketStart)
    if (!point || !apiKeyMap.has(row.apiKeyId)) {
      continue
    }
    point.apiKeys[row.apiKeyId] = {
      name: apiKeyMap.get(row.apiKeyId).name || `API Key ${row.apiKeyId}`,
      tokens: row.totalTokens,
      requests: row.requests,
      cost: row.cost,
      formattedCost: `$${row.cost.toFixed(6)}`
    }
    totals.set(row.apiKeyId, (totals.get(row.apiKeyId) || 0) + row.totalTokens)
  }

  return {
    data,
    topApiKeys: Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([apiKeyId]) => apiKeyId),
    totalApiKeys: apiKeyIds.length
  }
}

async function getModelUsageTrend({ metric = 'requests', limit = 10, ...options } = {}) {
  const trend = await buildTrendPeriods(options)
  const data = trend.periods.map((period) => ({
    ...(period.minute ? { minute: period.minute, label: period.label } : {}),
    ...(period.hour ? { hour: period.hour, label: period.label } : {}),
    ...(period.date ? { date: period.date } : {}),
    models: {}
  }))
  if (trend.periods.length === 0) {
    return { data, topModels: [], totalModels: 0 }
  }

  const rows = await queryDimensionalUsage({
    granularity: trend.granularity,
    startDate: trend.start,
    endDate: trend.endExclusive,
    groupBy: ['model'],
    limit: 10000
  })
  const points = new Map(
    trend.periods.map((period, index) => [period.bucketStart.toISOString(), data[index]])
  )
  const totals = new Map()
  const models = new Set()
  const normalizedMetric = ['requests', 'cost', 'tokens'].includes(metric) ? metric : 'requests'
  for (const row of rows) {
    const point = points.get(row.bucketStart)
    if (!point) {
      continue
    }
    point.models[row.model] = {
      requests: row.requests,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheCreateTokens: row.cacheCreateTokens,
      cacheReadTokens: row.cacheReadTokens,
      ephemeral5mTokens: row.ephemeral5mTokens,
      ephemeral1hTokens: row.ephemeral1hTokens,
      allTokens: row.totalTokens,
      tokens: row.totalTokens,
      cost: row.cost,
      realCost: row.realCost,
      formattedCost: `$${row.cost.toFixed(6)}`
    }
    const value =
      normalizedMetric === 'cost'
        ? row.cost
        : normalizedMetric === 'tokens'
          ? row.totalTokens
          : row.requests
    totals.set(row.model, (totals.get(row.model) || 0) + value)
    models.add(row.model)
  }
  const safeLimit = Math.max(1, Math.min(normalizeInteger(limit, 10), 20))
  return {
    data,
    topModels: Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, safeLimit)
      .map(([model]) => model),
    totalModels: models.size
  }
}

async function getAccountUsageTrend({ accounts = [], ...options } = {}) {
  const trend = await buildTrendPeriods(options)
  const accountIds = accounts.map((account) => account.id).filter(Boolean)
  const accountTypes = [...new Set(accounts.map((account) => account.platform).filter(Boolean))]
  const accountMap = new Map(accounts.map((account) => [account.id, account]))
  const data = trend.periods.map((period) => ({
    ...(period.minute ? { minute: period.minute, label: period.label } : {}),
    ...(period.hour ? { hour: period.hour, label: period.label } : {}),
    ...(period.date ? { date: period.date } : {}),
    accounts: {}
  }))
  if (trend.periods.length === 0 || (accountIds.length === 0 && accountTypes.length === 0)) {
    return { data, topAccounts: [], totalAccounts: accountIds.length }
  }

  const rows = await queryDimensionalUsage({
    granularity: trend.granularity,
    startDate: trend.start,
    endDate: trend.endExclusive,
    accountIds,
    accountTypes,
    groupBy: ['account'],
    limit: 10000
  })
  const points = new Map(
    trend.periods.map((period, index) => [period.bucketStart.toISOString(), data[index]])
  )
  const totals = new Map()
  const usedAccounts = new Set()
  for (const row of rows) {
    const point = points.get(row.bucketStart)
    if (!point || !row.accountId) {
      continue
    }
    const account = accountMap.get(row.accountId) || {}
    point.accounts[row.accountId] = {
      name: account.name || `账号 ${row.accountId.slice(0, 8)}`,
      platform: account.platform || row.accountType,
      cost: row.cost,
      formattedCost: `$${row.cost.toFixed(6)}`,
      requests: row.requests,
      allTokens: row.totalTokens
    }
    totals.set(row.accountId, (totals.get(row.accountId) || 0) + row.cost)
    usedAccounts.add(row.accountId)
  }

  return {
    data,
    topAccounts: Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([accountId]) => accountId),
    totalAccounts: new Set([...accountIds, ...usedAccounts]).size
  }
}

function buildAccountHistoryPoint(period, row = {}) {
  const metrics = rowToUsageMetrics(row)
  return {
    date: period.date,
    label: period.date ? period.date.slice(5).replace('-', '/') : '',
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    requests: metrics.requests,
    cacheCreateTokens: metrics.cacheCreateTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    totalTokens: metrics.totalTokens,
    tokens: metrics.totalTokens,
    cost: metrics.cost,
    formattedCost: `$${metrics.cost.toFixed(6)}`
  }
}

function buildAccountHistorySummary(history = [], daysCount = 30, accountCreatedAt = null) {
  const totalCost = normalizeNumber(
    history.reduce((sum, item) => sum + normalizeNumber(item.cost), 0),
    6
  )
  const totalRequests = history.reduce((sum, item) => sum + normalizeInteger(item.requests), 0)
  const totalTokens = history.reduce(
    (sum, item) => sum + normalizeInteger(item.tokens || item.totalTokens),
    0
  )
  let actualDaysForAvg = daysCount
  const createdAt = normalizeDate(accountCreatedAt)
  if (createdAt) {
    const diffDays = Math.ceil(Math.abs(Date.now() - createdAt.getTime()) / 86400000)
    actualDaysForAvg = Math.max(Math.min(diffDays, daysCount), 1)
  }
  const highestCostDay = history.reduce(
    (highest, item) => (!highest || item.cost > highest.cost ? item : highest),
    null
  )
  const highestRequestDay = history.reduce(
    (highest, item) => (!highest || item.requests > highest.requests ? item : highest),
    null
  )
  const today = history.at(-1) || null
  const avgDailyCost = actualDaysForAvg > 0 ? totalCost / actualDaysForAvg : 0

  return {
    days: daysCount,
    actualDaysUsed: actualDaysForAvg,
    accountCreatedAt: createdAt?.toISOString() || null,
    totalCost,
    totalCostFormatted: `$${totalCost.toFixed(6)}`,
    totalRequests,
    totalTokens,
    avgDailyCost,
    avgDailyCostFormatted: `$${avgDailyCost.toFixed(6)}`,
    avgDailyRequests: actualDaysForAvg > 0 ? totalRequests / actualDaysForAvg : 0,
    avgDailyTokens: actualDaysForAvg > 0 ? totalTokens / actualDaysForAvg : 0,
    today: today
      ? {
          date: today.date,
          cost: today.cost,
          costFormatted: today.formattedCost,
          requests: today.requests,
          tokens: today.tokens
        }
      : null,
    highestCostDay: highestCostDay
      ? {
          date: highestCostDay.date,
          label: highestCostDay.label,
          cost: highestCostDay.cost,
          formattedCost: highestCostDay.formattedCost
        }
      : null,
    highestRequestDay: highestRequestDay
      ? {
          date: highestRequestDay.date,
          label: highestRequestDay.label,
          requests: highestRequestDay.requests
        }
      : null
  }
}

function buildAccountOverviewUsage(row = {}, prefix = 'total') {
  const inputTokens = normalizeInteger(row[`${prefix}_input_tokens`])
  const outputTokens = normalizeInteger(row[`${prefix}_output_tokens`])
  const cacheCreateTokens = normalizeInteger(row[`${prefix}_cache_create_tokens`])
  const cacheReadTokens = normalizeInteger(row[`${prefix}_cache_read_tokens`])
  const allTokens =
    normalizeInteger(row[`${prefix}_total_tokens`]) ||
    inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
  return {
    tokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    ephemeral5mTokens: normalizeInteger(row[`${prefix}_ephemeral_5m_tokens`]),
    ephemeral1hTokens: normalizeInteger(row[`${prefix}_ephemeral_1h_tokens`]),
    allTokens,
    requests: normalizeInteger(row[`${prefix}_request_count`]),
    cost: normalizeNumber(row[`${prefix}_cost`])
  }
}

function buildAccountOverview(row = {}, accountCreatedAt = null) {
  const total = buildAccountOverviewUsage(row, 'total')
  const daily = buildAccountOverviewUsage(row, 'daily')
  const monthly = buildAccountOverviewUsage(row, 'monthly')
  const createdAt = normalizeDate(accountCreatedAt)
  const daysSinceCreated = createdAt
    ? Math.max(1, Math.ceil((Date.now() - createdAt.getTime()) / 86400000))
    : 1
  const totalMinutes = Math.max(1, daysSinceCreated * 24 * 60)
  return {
    total,
    daily,
    monthly,
    averages: {
      rpm: Math.round((total.requests / totalMinutes) * 100) / 100,
      tpm: Math.round((total.allTokens / totalMinutes) * 100) / 100,
      dailyRequests: Math.round((total.requests / daysSinceCreated) * 100) / 100,
      dailyTokens: Math.round((total.allTokens / daysSinceCreated) * 100) / 100
    }
  }
}

async function getAccountUsageOverviewRows(accountId, businessTimezone = DEFAULT_TIMEZONE) {
  await ensureSchema()
  const today = formatDateInTimezone(new Date(), businessTimezone)
  const todayRange = await resolveBusinessDayRange(today, businessTimezone)
  const monthRange = await resolveBusinessDayRange(`${today.slice(0, 7)}-01`, businessTimezone)
  const result = await postgres.query(
    `
      SELECT
        SUM(usage_request_count)::bigint AS total_request_count,
        SUM(input_tokens)::bigint AS total_input_tokens,
        SUM(output_tokens)::bigint AS total_output_tokens,
        SUM(cache_create_tokens)::bigint AS total_cache_create_tokens,
        SUM(cache_read_tokens)::bigint AS total_cache_read_tokens,
        SUM(ephemeral_5m_tokens)::bigint AS total_ephemeral_5m_tokens,
        SUM(ephemeral_1h_tokens)::bigint AS total_ephemeral_1h_tokens,
        SUM(total_tokens)::bigint AS total_total_tokens,
        SUM(cost)::numeric AS total_cost,
        SUM(usage_request_count) FILTER (
          WHERE bucket_start = $2
        )::bigint AS daily_request_count,
        SUM(input_tokens) FILTER (WHERE bucket_start = $2)::bigint AS daily_input_tokens,
        SUM(output_tokens) FILTER (WHERE bucket_start = $2)::bigint AS daily_output_tokens,
        SUM(cache_create_tokens) FILTER (
          WHERE bucket_start = $2
        )::bigint AS daily_cache_create_tokens,
        SUM(cache_read_tokens) FILTER (
          WHERE bucket_start = $2
        )::bigint AS daily_cache_read_tokens,
        SUM(ephemeral_5m_tokens) FILTER (
          WHERE bucket_start = $2
        )::bigint AS daily_ephemeral_5m_tokens,
        SUM(ephemeral_1h_tokens) FILTER (
          WHERE bucket_start = $2
        )::bigint AS daily_ephemeral_1h_tokens,
        SUM(total_tokens) FILTER (WHERE bucket_start = $2)::bigint AS daily_total_tokens,
        SUM(cost) FILTER (WHERE bucket_start = $2)::numeric AS daily_cost,
        SUM(usage_request_count) FILTER (
          WHERE bucket_start >= $3
        )::bigint AS monthly_request_count,
        SUM(input_tokens) FILTER (WHERE bucket_start >= $3)::bigint AS monthly_input_tokens,
        SUM(output_tokens) FILTER (WHERE bucket_start >= $3)::bigint AS monthly_output_tokens,
        SUM(cache_create_tokens) FILTER (
          WHERE bucket_start >= $3
        )::bigint AS monthly_cache_create_tokens,
        SUM(cache_read_tokens) FILTER (
          WHERE bucket_start >= $3
        )::bigint AS monthly_cache_read_tokens,
        SUM(ephemeral_5m_tokens) FILTER (
          WHERE bucket_start >= $3
        )::bigint AS monthly_ephemeral_5m_tokens,
        SUM(ephemeral_1h_tokens) FILTER (
          WHERE bucket_start >= $3
        )::bigint AS monthly_ephemeral_1h_tokens,
        SUM(total_tokens) FILTER (WHERE bucket_start >= $3)::bigint AS monthly_total_tokens,
        SUM(cost) FILTER (WHERE bucket_start >= $3)::numeric AS monthly_cost
      FROM usage_dimensional_rollups
      WHERE granularity = 'day'
        AND account_id = $1
    `,
    [accountId, todayRange.startDate, monthRange.startDate]
  )
  return result.rows[0] || {}
}

async function getAccountUsageHistory({
  accountId,
  days = 30,
  accountCreatedAt = null,
  businessTimezone = DEFAULT_TIMEZONE
} = {}) {
  const daysCount = Math.min(Math.max(normalizeInteger(days, 30), 1), 60)
  const trend = await buildTrendPeriods({
    granularity: 'day',
    days: daysCount,
    businessTimezone
  })
  const emptyHistory = trend.periods.map((period) => buildAccountHistoryPoint(period))
  if (!accountId || trend.periods.length === 0) {
    return {
      history: emptyHistory,
      summary: buildAccountHistorySummary(emptyHistory, daysCount, accountCreatedAt),
      overview: buildAccountOverview({}, accountCreatedAt),
      hasData: false
    }
  }

  const [rows, overviewRows] = await Promise.all([
    queryDimensionalUsage({
      granularity: 'day',
      startDate: trend.start,
      endDate: trend.endExclusive,
      accountIds: [accountId],
      groupBy: [],
      limit: daysCount
    }),
    getAccountUsageOverviewRows(accountId, businessTimezone)
  ])
  const byBucket = rowsByBucket(rows)
  const history = trend.periods.map((period) =>
    buildAccountHistoryPoint(period, byBucket.get(period.bucketStart.toISOString()))
  )
  const overview = buildAccountOverview(overviewRows, accountCreatedAt)
  return {
    history,
    summary: buildAccountHistorySummary(history, daysCount, accountCreatedAt),
    overview,
    hasData: rows.length > 0 || overview.total.requests > 0
  }
}

async function getAccountUsageSummary(accountId, businessTimezone = DEFAULT_TIMEZONE) {
  if (!accountId) {
    return {
      totalCost: 0,
      dailyCost: 0,
      monthlyCost: 0,
      totalRequests: 0,
      dailyRequests: 0,
      monthlyRequests: 0
    }
  }
  const overview = buildAccountOverview(
    await getAccountUsageOverviewRows(accountId, businessTimezone)
  )
  return {
    totalCost: overview.total.cost,
    dailyCost: overview.daily.cost,
    monthlyCost: overview.monthly.cost,
    totalRequests: overview.total.requests,
    dailyRequests: overview.daily.requests,
    monthlyRequests: overview.monthly.requests
  }
}

async function getCoverage() {
  await ensureSchema()
  const result = await postgres.query(
    `
      SELECT
        granularity,
        MIN(bucket_start) AS earliest,
        MAX(bucket_start) AS latest,
        COUNT(*)::bigint AS row_count,
        MAX(aggregated_at) AS last_aggregated_at
      FROM usage_dimensional_rollups
      GROUP BY granularity
      ORDER BY granularity
    `
  )
  const validationResult = await postgres.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE status = 'verified')::bigint AS verified_days,
        COUNT(*) FILTER (WHERE status = 'mismatch')::bigint AS mismatched_days,
        COALESCE(SUM(unknown_account_count), 0)::bigint AS unknown_account_events,
        MAX(checked_at) AS last_checked_at
      FROM usage_rollup_validation
    `
  )
  const recentValidationResult = await postgres.query(
    `
      SELECT
        business_timezone,
        usage_date,
        source_event_count,
        rollup_request_count,
        source_total_tokens,
        rollup_total_tokens,
        source_cost,
        rollup_cost,
        source_real_cost,
        rollup_real_cost,
        unknown_account_count,
        status,
        details,
        checked_at
      FROM usage_rollup_validation
      ORDER BY usage_date DESC
      LIMIT 30
    `
  )

  return {
    granularities: result.rows.map((row) => ({
      granularity: row.granularity,
      earliest: normalizeDate(row.earliest)?.toISOString() || null,
      latest: normalizeDate(row.latest)?.toISOString() || null,
      rowCount: normalizeInteger(row.row_count),
      lastAggregatedAt: normalizeDate(row.last_aggregated_at)?.toISOString() || null
    })),
    validation: {
      verifiedDays: normalizeInteger(validationResult.rows[0]?.verified_days),
      mismatchedDays: normalizeInteger(validationResult.rows[0]?.mismatched_days),
      unknownAccountEvents: normalizeInteger(validationResult.rows[0]?.unknown_account_events),
      lastCheckedAt: normalizeDate(validationResult.rows[0]?.last_checked_at)?.toISOString() || null
    },
    recentValidations: recentValidationResult.rows.map((row) => ({
      businessTimezone: row.business_timezone,
      usageDate:
        row.usage_date instanceof Date
          ? row.usage_date.toISOString().slice(0, 10)
          : String(row.usage_date),
      sourceEventCount: normalizeInteger(row.source_event_count),
      rollupRequestCount: normalizeInteger(row.rollup_request_count),
      sourceTotalTokens: normalizeInteger(row.source_total_tokens),
      rollupTotalTokens: normalizeInteger(row.rollup_total_tokens),
      sourceCost: normalizeNumber(row.source_cost, 8),
      rollupCost: normalizeNumber(row.rollup_cost, 8),
      sourceRealCost: normalizeNumber(row.source_real_cost, 8),
      rollupRealCost: normalizeNumber(row.rollup_real_cost, 8),
      unknownAccountCount: normalizeInteger(row.unknown_account_count),
      status: row.status,
      details: row.details || {},
      checkedAt: normalizeDate(row.checked_at)?.toISOString() || null
    }))
  }
}

module.exports = {
  DIMENSIONAL_USAGE_SCHEMA_SQL,
  ensureSchema,
  materializeRange,
  validateDay,
  cleanupExpiredRollups,
  cleanupVerifiedUsageEvents,
  upsertAggregatedRows,
  queryDimensionalUsage,
  getUsageTrend,
  getApiKeysUsageTrend,
  getModelUsageTrend,
  getAccountUsageTrend,
  getAccountUsageHistory,
  getAccountUsageSummary,
  getCoverage,
  resolveBusinessDayRange,
  buildTrendPeriods,
  normalizeGranularity,
  intervalForGranularity,
  rowToUsageMetrics
}
