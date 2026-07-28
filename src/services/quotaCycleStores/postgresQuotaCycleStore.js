const { randomUUID } = require('crypto')
const postgres = require('../../models/postgres')

const QUOTA_CYCLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS quota_cycle_metadata (
  metadata_key TEXT PRIMARY KEY,
  metadata_value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO quota_cycle_metadata (metadata_key, metadata_value)
VALUES ('tracking_started_at', jsonb_build_object('startedAt', now()))
ON CONFLICT (metadata_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS quota_limit_cycles (
  cycle_id TEXT PRIMARY KEY,
  cycle_key TEXT NOT NULL,
  quota_group_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  window_type TEXT NOT NULL,
  window_start_at TIMESTAMPTZ,
  first_exceeded_at TIMESTAMPTZ NOT NULL,
  last_exceeded_at TIMESTAMPTZ NOT NULL,
  reset_at TIMESTAMPTZ,
  recovered_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'exceeded',
  boundary_source TEXT NOT NULL DEFAULT 'unknown',
  is_partial BOOLEAN NOT NULL DEFAULT false,
  provider_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  account_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  usage_summary JSONB,
  usage_finalized_at TIMESTAMPTZ,
  export_status TEXT NOT NULL DEFAULT 'waiting_usage',
  export_attempts INTEGER NOT NULL DEFAULT 0,
  export_claim_token TEXT,
  export_claimed_at TIMESTAMPTZ,
  export_next_attempt_at TIMESTAMPTZ,
  exported_at TIMESTAMPTZ,
  export_trace_id TEXT,
  export_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quota_group_id, provider, window_type, cycle_key)
);

CREATE INDEX IF NOT EXISTS idx_quota_limit_cycles_group_time
  ON quota_limit_cycles (quota_group_id, first_exceeded_at DESC);
CREATE INDEX IF NOT EXISTS idx_quota_limit_cycles_provider_time
  ON quota_limit_cycles (provider, first_exceeded_at DESC);
CREATE INDEX IF NOT EXISTS idx_quota_limit_cycles_status_time
  ON quota_limit_cycles (status, first_exceeded_at DESC);
CREATE INDEX IF NOT EXISTS idx_quota_limit_cycles_export_queue
  ON quota_limit_cycles (export_status, export_next_attempt_at, usage_finalized_at)
  WHERE usage_summary IS NOT NULL;
`

let schemaPromise = null

function normalizeText(value, fallback = null) {
  if (value === null || value === undefined) {
    return fallback
  }
  const normalized = String(value).split('\u0000').join('').trim()
  return normalized || fallback
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeDate(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date
}

function toIsoString(value) {
  const date = normalizeDate(value)
  return date ? date.toISOString() : null
}

function normalizeJson(value, fallback) {
  if (value === null || value === undefined) {
    return fallback
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch (_error) {
      return fallback
    }
  }
  return value
}

function jsonParam(value, fallback) {
  return JSON.stringify(value === undefined || value === null ? fallback : value)
}

function mapCycleRow(row) {
  if (!row) {
    return null
  }

  return {
    cycleId: row.cycle_id,
    cycleKey: row.cycle_key,
    quotaGroupId: row.quota_group_id,
    provider: row.provider,
    windowType: row.window_type,
    windowStartAt: toIsoString(row.window_start_at),
    firstExceededAt: toIsoString(row.first_exceeded_at),
    lastExceededAt: toIsoString(row.last_exceeded_at),
    resetAt: toIsoString(row.reset_at),
    recoveredAt: toIsoString(row.recovered_at),
    status: row.status,
    boundarySource: row.boundary_source,
    isPartial: row.is_partial === true,
    providerSnapshot: normalizeJson(row.provider_snapshot, {}),
    accountRefs: normalizeJson(row.account_refs, []),
    usageSummary: normalizeJson(row.usage_summary, null),
    usageFinalizedAt: toIsoString(row.usage_finalized_at),
    exportStatus: row.export_status,
    exportAttempts: normalizeInteger(row.export_attempts),
    exportClaimedAt: toIsoString(row.export_claimed_at),
    exportNextAttemptAt: toIsoString(row.export_next_attempt_at),
    exportedAt: toIsoString(row.exported_at),
    exportTraceId: row.export_trace_id || null,
    exportError: row.export_error || null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  }
}

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = postgres.query(QUOTA_CYCLE_SCHEMA_SQL).catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  await schemaPromise
}

async function upsertExceededCycle(cycle, database = postgres) {
  const result = await database.query(
    `
      INSERT INTO quota_limit_cycles (
        cycle_id,
        cycle_key,
        quota_group_id,
        provider,
        window_type,
        window_start_at,
        first_exceeded_at,
        last_exceeded_at,
        reset_at,
        status,
        boundary_source,
        is_partial,
        provider_snapshot,
        account_refs
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $7, $8,
        'exceeded', $9, $10, $11::jsonb, $12::jsonb
      )
      ON CONFLICT (quota_group_id, provider, window_type, cycle_key)
      DO UPDATE SET
        window_start_at = COALESCE(
          quota_limit_cycles.window_start_at,
          EXCLUDED.window_start_at
        ),
        first_exceeded_at = LEAST(
          quota_limit_cycles.first_exceeded_at,
          EXCLUDED.first_exceeded_at
        ),
        last_exceeded_at = GREATEST(
          quota_limit_cycles.last_exceeded_at,
          EXCLUDED.last_exceeded_at
        ),
        reset_at = COALESCE(EXCLUDED.reset_at, quota_limit_cycles.reset_at),
        status = CASE
          WHEN quota_limit_cycles.status = 'recovered'
            AND EXCLUDED.provider = 'zhipu'
            AND EXCLUDED.reset_at IS NOT NULL
            AND EXCLUDED.first_exceeded_at < EXCLUDED.reset_at
            AND EXCLUDED.first_exceeded_at >= quota_limit_cycles.recovered_at
            THEN 'exceeded'
          WHEN quota_limit_cycles.status = 'recovered'
            THEN quota_limit_cycles.status
          ELSE 'exceeded'
        END,
        recovered_at = CASE
          WHEN quota_limit_cycles.status = 'recovered'
            AND EXCLUDED.provider = 'zhipu'
            AND EXCLUDED.reset_at IS NOT NULL
            AND EXCLUDED.first_exceeded_at < EXCLUDED.reset_at
            AND EXCLUDED.first_exceeded_at >= quota_limit_cycles.recovered_at
            THEN NULL
          ELSE quota_limit_cycles.recovered_at
        END,
        boundary_source = CASE
          WHEN EXCLUDED.boundary_source = 'unknown'
            THEN quota_limit_cycles.boundary_source
          ELSE EXCLUDED.boundary_source
        END,
        is_partial = quota_limit_cycles.is_partial OR EXCLUDED.is_partial,
        provider_snapshot = CASE
          WHEN EXCLUDED.provider_snapshot = '{}'::jsonb
            THEN quota_limit_cycles.provider_snapshot
          ELSE EXCLUDED.provider_snapshot
        END,
        usage_summary = CASE
          WHEN quota_limit_cycles.export_status IN ('waiting_usage', 'pending', 'failed')
            AND EXCLUDED.account_refs <> '[]'::jsonb
            AND NOT (quota_limit_cycles.account_refs @> EXCLUDED.account_refs)
            THEN NULL
          ELSE quota_limit_cycles.usage_summary
        END,
        usage_finalized_at = CASE
          WHEN quota_limit_cycles.export_status IN ('waiting_usage', 'pending', 'failed')
            AND EXCLUDED.account_refs <> '[]'::jsonb
            AND NOT (quota_limit_cycles.account_refs @> EXCLUDED.account_refs)
            THEN NULL
          ELSE quota_limit_cycles.usage_finalized_at
        END,
        export_status = CASE
          WHEN quota_limit_cycles.export_status IN ('waiting_usage', 'pending', 'failed')
            AND EXCLUDED.account_refs <> '[]'::jsonb
            AND NOT (quota_limit_cycles.account_refs @> EXCLUDED.account_refs)
            THEN 'waiting_usage'
          ELSE quota_limit_cycles.export_status
        END,
        export_claim_token = CASE
          WHEN quota_limit_cycles.export_status IN ('waiting_usage', 'pending', 'failed')
            AND EXCLUDED.account_refs <> '[]'::jsonb
            AND NOT (quota_limit_cycles.account_refs @> EXCLUDED.account_refs)
            THEN NULL
          ELSE quota_limit_cycles.export_claim_token
        END,
        export_claimed_at = CASE
          WHEN quota_limit_cycles.export_status IN ('waiting_usage', 'pending', 'failed')
            AND EXCLUDED.account_refs <> '[]'::jsonb
            AND NOT (quota_limit_cycles.account_refs @> EXCLUDED.account_refs)
            THEN NULL
          ELSE quota_limit_cycles.export_claimed_at
        END,
        export_next_attempt_at = CASE
          WHEN quota_limit_cycles.export_status IN ('waiting_usage', 'pending', 'failed')
            AND EXCLUDED.account_refs <> '[]'::jsonb
            AND NOT (quota_limit_cycles.account_refs @> EXCLUDED.account_refs)
            THEN NULL
          ELSE quota_limit_cycles.export_next_attempt_at
        END,
        export_error = CASE
          WHEN quota_limit_cycles.export_status IN ('waiting_usage', 'pending', 'failed')
            AND EXCLUDED.account_refs <> '[]'::jsonb
            AND NOT (quota_limit_cycles.account_refs @> EXCLUDED.account_refs)
            THEN NULL
          ELSE quota_limit_cycles.export_error
        END,
        account_refs = CASE
          WHEN EXCLUDED.account_refs = '[]'::jsonb THEN quota_limit_cycles.account_refs
          ELSE (
            SELECT COALESCE(jsonb_agg(merged.account_ref ORDER BY merged.account_key), '[]'::jsonb)
            FROM (
              SELECT DISTINCT ON (candidate.account_key)
                candidate.account_key,
                candidate.account_ref
              FROM (
                SELECT
                  CONCAT_WS(
                    ':',
                    COALESCE(
                      account_ref->>'accountType',
                      account_ref->>'type',
                      '*'
                    ),
                    COALESCE(account_ref->>'accountId', account_ref->>'id')
                  ) AS account_key,
                  COALESCE(account_ref->>'accountId', account_ref->>'id') AS account_id,
                  account_ref,
                  ordinality
                FROM jsonb_array_elements(
                  quota_limit_cycles.account_refs || EXCLUDED.account_refs
                ) WITH ORDINALITY AS refs(account_ref, ordinality)
              ) AS candidate
              WHERE candidate.account_id IS NOT NULL
              ORDER BY candidate.account_key, candidate.ordinality DESC
            ) AS merged
          )
        END,
        updated_at = now()
      RETURNING *
    `,
    [
      cycle.cycleId,
      cycle.cycleKey,
      cycle.quotaGroupId,
      cycle.provider,
      cycle.windowType,
      normalizeDate(cycle.windowStartAt),
      normalizeDate(cycle.firstExceededAt, new Date()),
      normalizeDate(cycle.resetAt),
      normalizeText(cycle.boundarySource, 'unknown'),
      cycle.isPartial === true,
      jsonParam(cycle.providerSnapshot, {}),
      jsonParam(cycle.accountRefs, [])
    ]
  )
  return mapCycleRow(result.rows[0])
}

async function markExceeded(cycle) {
  await ensureSchema()
  if (!cycle.reuseOpenCycle) {
    return upsertExceededCycle(cycle)
  }

  return postgres.transaction(async (client) => {
    const lockKey = [cycle.quotaGroupId, cycle.provider, cycle.windowType].join('\u001f')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey])
    const existing = await client.query(
      `
        SELECT cycle_id, cycle_key
        FROM quota_limit_cycles
        WHERE quota_group_id = $1
          AND provider = $2
          AND window_type = $3
          AND status = 'exceeded'
        ORDER BY first_exceeded_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [cycle.quotaGroupId, cycle.provider, cycle.windowType]
    )
    const openCycle = existing.rows[0]
    return upsertExceededCycle(
      openCycle
        ? {
            ...cycle,
            cycleId: openCycle.cycle_id,
            cycleKey: openCycle.cycle_key
          }
        : cycle,
      client
    )
  })
}

async function getCycle(cycleId) {
  await ensureSchema()
  const result = await postgres.query('SELECT * FROM quota_limit_cycles WHERE cycle_id = $1', [
    normalizeText(cycleId)
  ])
  return mapCycleRow(result.rows[0])
}

async function getLatestOpenCycle({ quotaGroupId, provider, windowType = null }) {
  await ensureSchema()
  const values = [normalizeText(quotaGroupId), normalizeText(provider)]
  const windowCondition = windowType ? `AND window_type = $${values.push(windowType)}` : ''
  const result = await postgres.query(
    `
      SELECT *
      FROM quota_limit_cycles
      WHERE quota_group_id = $1
        AND provider = $2
        AND status = 'exceeded'
        ${windowCondition}
      ORDER BY first_exceeded_at DESC
      LIMIT 1
    `,
    values
  )
  return mapCycleRow(result.rows[0])
}

async function getLatestRecoveredCycle({ quotaGroupId, provider, windowType = null }) {
  await ensureSchema()
  const values = [normalizeText(quotaGroupId), normalizeText(provider)]
  const windowCondition = windowType ? `AND window_type = $${values.push(windowType)}` : ''
  const result = await postgres.query(
    `
      SELECT *
      FROM quota_limit_cycles
      WHERE quota_group_id = $1
        AND provider = $2
        AND status = 'recovered'
        AND recovered_at IS NOT NULL
        ${windowCondition}
      ORDER BY recovered_at DESC
      LIMIT 1
    `,
    values
  )
  return mapCycleRow(result.rows[0])
}

async function getTrackingStartedAt() {
  await ensureSchema()
  const result = await postgres.query(
    `
      SELECT metadata_value->>'startedAt' AS started_at
      FROM quota_cycle_metadata
      WHERE metadata_key = 'tracking_started_at'
    `
  )
  return toIsoString(result.rows[0]?.started_at)
}

async function markRecovered({ cycleId, recoveredAt = new Date() }) {
  await ensureSchema()
  const result = await postgres.query(
    `
      UPDATE quota_limit_cycles
      SET status = 'recovered',
        recovered_at = CASE
          WHEN recovered_at IS NULL THEN $2
          ELSE LEAST(recovered_at, $2)
        END,
        updated_at = now()
      WHERE cycle_id = $1
        AND $2 >= last_exceeded_at
      RETURNING *
    `,
    [normalizeText(cycleId), normalizeDate(recoveredAt, new Date())]
  )
  return mapCycleRow(result.rows[0])
}

function buildUsageSummary(rows, scope) {
  const totals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    ephemeral5mTokens: 0,
    ephemeral1hTokens: 0,
    totalTokens: 0,
    cost: 0,
    realCost: 0
  }
  let observedFromAt = null
  let observedThroughAt = null

  const models = rows.map((row) => {
    const usage = {
      model: row.model || 'unknown',
      requests: normalizeInteger(row.request_count),
      inputTokens: normalizeInteger(row.input_tokens),
      outputTokens: normalizeInteger(row.output_tokens),
      cacheCreateTokens: normalizeInteger(row.cache_create_tokens),
      cacheReadTokens: normalizeInteger(row.cache_read_tokens),
      ephemeral5mTokens: normalizeInteger(row.ephemeral_5m_tokens),
      ephemeral1hTokens: normalizeInteger(row.ephemeral_1h_tokens),
      totalTokens: normalizeInteger(row.total_tokens),
      cost: normalizeNumber(row.cost),
      realCost: normalizeNumber(row.real_cost)
    }

    for (const key of Object.keys(totals)) {
      totals[key] += usage[key]
    }

    const firstAt = toIsoString(row.first_observed_at)
    const lastAt = toIsoString(row.last_observed_at)
    if (firstAt && (!observedFromAt || firstAt < observedFromAt)) {
      observedFromAt = firstAt
    }
    if (lastAt && (!observedThroughAt || lastAt > observedThroughAt)) {
      observedThroughAt = lastAt
    }
    return usage
  })

  totals.cost = Number(totals.cost.toFixed(8))
  totals.realCost = Number(totals.realCost.toFixed(8))

  return {
    version: 1,
    source: 'usage_events',
    semantics: 'crs_observed_usage',
    scope: {
      quotaGroupId: scope.quotaGroupId,
      accountRefs: scope.accountRefs,
      accountIds: scope.accountRefs.map((ref) => ref.accountId),
      startAt: toIsoString(scope.startAt),
      endAt: toIsoString(scope.endAt)
    },
    observedFromAt,
    observedThroughAt,
    totals,
    models
  }
}

async function aggregateUsage({ quotaGroupId, accountRefs, startAt = null, endAt }) {
  await ensureSchema()
  const normalizedAccountRefs = []
  const seenAccountRefs = new Set()
  for (const rawRef of Array.isArray(accountRefs) ? accountRefs : []) {
    const accountId = normalizeText(rawRef?.accountId || rawRef?.id)
    const accountType = normalizeText(rawRef?.accountType || rawRef?.type)
    const accountKey = `${accountType || '*'}:${accountId}`
    if (!accountId || seenAccountRefs.has(accountKey)) {
      continue
    }
    seenAccountRefs.add(accountKey)
    normalizedAccountRefs.push({ accountId, accountType })
  }
  if (normalizedAccountRefs.length === 0) {
    throw new Error('At least one account reference is required to aggregate quota cycle usage')
  }

  const normalizedEndAt = normalizeDate(endAt)
  if (!normalizedEndAt) {
    throw new Error('A valid usage aggregation end time is required')
  }
  const normalizedStartAt = normalizeDate(startAt)
  if (normalizedStartAt && normalizedStartAt > normalizedEndAt) {
    throw new Error('Usage aggregation start time must not be after end time')
  }

  const result = await postgres.query(
    `
      SELECT
        COALESCE(NULLIF(event.normalized_model, ''), NULLIF(event.model, ''), 'unknown') AS model,
        COUNT(*)::bigint AS request_count,
        COALESCE(SUM(event.input_tokens), 0)::bigint AS input_tokens,
        COALESCE(SUM(event.output_tokens), 0)::bigint AS output_tokens,
        COALESCE(SUM(event.cache_create_tokens), 0)::bigint AS cache_create_tokens,
        COALESCE(SUM(event.cache_read_tokens), 0)::bigint AS cache_read_tokens,
        COALESCE(SUM(event.ephemeral_5m_tokens), 0)::bigint AS ephemeral_5m_tokens,
        COALESCE(SUM(event.ephemeral_1h_tokens), 0)::bigint AS ephemeral_1h_tokens,
        COALESCE(SUM(event.total_tokens), 0)::bigint AS total_tokens,
        COALESCE(SUM(event.cost), 0)::numeric(18,8) AS cost,
        COALESCE(SUM(event.real_cost), 0)::numeric(18,8) AS real_cost,
        MIN(event.timestamp) AS first_observed_at,
        MAX(event.timestamp) AS last_observed_at
      FROM usage_events AS event
      WHERE EXISTS (
          SELECT 1
          FROM jsonb_to_recordset($1::jsonb)
            AS requested_account("accountId" text, "accountType" text)
          WHERE requested_account."accountId" = event.account_id
            AND (
              requested_account."accountType" IS NULL
              OR requested_account."accountType" = event.account_type
            )
        )
        AND ($2::timestamptz IS NULL OR event.timestamp >= $2)
        AND event.timestamp <= $3
      GROUP BY COALESCE(
        NULLIF(event.normalized_model, ''),
        NULLIF(event.model, ''),
        'unknown'
      )
      ORDER BY total_tokens DESC, model ASC
    `,
    [jsonParam(normalizedAccountRefs, []), normalizedStartAt, normalizedEndAt]
  )

  return buildUsageSummary(result.rows, {
    quotaGroupId: normalizeText(quotaGroupId),
    accountRefs: normalizedAccountRefs,
    startAt: normalizedStartAt,
    endAt: normalizedEndAt
  })
}

async function finalizeUsage(cycleId, usageSummary, finalizedAt = new Date()) {
  await ensureSchema()
  const result = await postgres.query(
    `
      UPDATE quota_limit_cycles
      SET usage_summary = $2::jsonb,
        usage_finalized_at = $3,
        export_status = CASE
          WHEN export_status = 'exported' THEN export_status
          ELSE 'pending'
        END,
        export_next_attempt_at = CASE
          WHEN export_status = 'exported' THEN export_next_attempt_at
          ELSE $3
        END,
        export_error = CASE
          WHEN export_status = 'exported' THEN export_error
          ELSE NULL
        END,
        updated_at = now()
      WHERE cycle_id = $1
        AND usage_summary IS NULL
      RETURNING *
    `,
    [normalizeText(cycleId), jsonParam(usageSummary, {}), normalizeDate(finalizedAt, new Date())]
  )
  return result.rows[0] ? mapCycleRow(result.rows[0]) : getCycle(cycleId)
}

function buildListWhere(filters = {}) {
  const conditions = []
  const values = []
  const add = (condition, value) => {
    values.push(value)
    conditions.push(condition.replace('?', `$${values.length}`))
  }

  for (const [filter, column] of [
    ['quotaGroupId', 'quota_group_id'],
    ['provider', 'provider'],
    ['windowType', 'window_type'],
    ['status', 'status'],
    ['exportStatus', 'export_status']
  ]) {
    const value = normalizeText(filters[filter])
    if (value) {
      add(`${column} = ?`, value)
    }
  }

  const from = normalizeDate(filters.from)
  const to = normalizeDate(filters.to)
  if (from) {
    add('first_exceeded_at >= ?', from)
  }
  if (to) {
    add('first_exceeded_at <= ?', to)
  }

  const accountId = normalizeText(filters.accountId)
  if (accountId) {
    add(
      `EXISTS (
        SELECT 1
        FROM jsonb_array_elements(account_refs) AS account_ref
        WHERE COALESCE(account_ref->>'accountId', account_ref->>'id') = ?
      )`,
      accountId
    )
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    values
  }
}

async function listCycles(filters = {}) {
  await ensureSchema()
  const page = Math.max(1, normalizeInteger(filters.page, 1))
  const pageSize = Math.min(100, Math.max(1, normalizeInteger(filters.pageSize, 20)))
  const { whereClause, values } = buildListWhere(filters)
  const countResult = await postgres.query(
    `SELECT COUNT(*)::int AS total FROM quota_limit_cycles ${whereClause}`,
    values
  )
  const total = normalizeInteger(countResult.rows[0]?.total)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, totalPages)
  const queryValues = [...values, pageSize, (safePage - 1) * pageSize]
  const rowsResult = await postgres.query(
    `
      SELECT *
      FROM quota_limit_cycles
      ${whereClause}
      ORDER BY first_exceeded_at DESC, created_at DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    queryValues
  )

  return {
    items: rowsResult.rows.map(mapCycleRow),
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrevious: safePage > 1
    }
  }
}

async function claimPendingExports({
  limit = 20,
  now = new Date(),
  claimTtlMs = 5 * 60 * 1000
} = {}) {
  await ensureSchema()
  const safeLimit = Math.min(100, Math.max(1, normalizeInteger(limit, 20)))
  const claimAt = normalizeDate(now, new Date())
  const staleBefore = new Date(claimAt.getTime() - Math.max(1000, normalizeInteger(claimTtlMs)))
  const claimToken = randomUUID()
  const result = await postgres.query(
    `
      WITH candidates AS (
        SELECT cycle_id
        FROM quota_limit_cycles
        WHERE usage_summary IS NOT NULL
          AND (
            (
              export_status IN ('pending', 'failed')
              AND (
                export_next_attempt_at IS NULL
                OR export_next_attempt_at <= $1
              )
            )
            OR (
              export_status = 'processing'
              AND export_claimed_at < $2
            )
          )
        ORDER BY COALESCE(export_next_attempt_at, usage_finalized_at), created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $3
      )
      UPDATE quota_limit_cycles AS cycle
      SET export_status = 'processing',
        export_attempts = cycle.export_attempts + 1,
        export_claim_token = $4,
        export_claimed_at = $1,
        export_error = NULL,
        updated_at = now()
      FROM candidates
      WHERE cycle.cycle_id = candidates.cycle_id
      RETURNING cycle.*
    `,
    [claimAt, staleBefore, safeLimit, claimToken]
  )
  return {
    claimToken,
    cycles: result.rows.map(mapCycleRow)
  }
}

async function markExported({ cycleId, claimToken, traceId, exportedAt = new Date() }) {
  await ensureSchema()
  const result = await postgres.query(
    `
      UPDATE quota_limit_cycles
      SET export_status = 'exported',
        exported_at = $3,
        export_trace_id = $4,
        export_claim_token = NULL,
        export_claimed_at = NULL,
        export_next_attempt_at = NULL,
        export_error = NULL,
        updated_at = now()
      WHERE cycle_id = $1
        AND export_status = 'processing'
        AND export_claim_token = $2
      RETURNING *
    `,
    [
      normalizeText(cycleId),
      normalizeText(claimToken),
      normalizeDate(exportedAt, new Date()),
      normalizeText(traceId)
    ]
  )
  return mapCycleRow(result.rows[0])
}

async function markExportFailed({ cycleId, claimToken, error, nextAttemptAt = new Date() }) {
  await ensureSchema()
  const result = await postgres.query(
    `
      UPDATE quota_limit_cycles
      SET export_status = 'failed',
        export_claim_token = NULL,
        export_claimed_at = NULL,
        export_next_attempt_at = $3,
        export_error = $4,
        updated_at = now()
      WHERE cycle_id = $1
        AND export_status = 'processing'
        AND export_claim_token = $2
      RETURNING *
    `,
    [
      normalizeText(cycleId),
      normalizeText(claimToken),
      normalizeDate(nextAttemptAt, new Date()),
      normalizeText(error?.message || error, 'Unknown Langfuse export failure')
    ]
  )
  return mapCycleRow(result.rows[0])
}

module.exports = {
  QUOTA_CYCLE_SCHEMA_SQL,
  ensureSchema,
  markExceeded,
  getCycle,
  getLatestOpenCycle,
  getLatestRecoveredCycle,
  getTrackingStartedAt,
  markRecovered,
  aggregateUsage,
  finalizeUsage,
  listCycles,
  claimPendingExports,
  markExported,
  markExportFailed,
  mapCycleRow,
  buildUsageSummary
}
