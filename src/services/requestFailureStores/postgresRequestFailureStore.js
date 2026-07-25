const postgres = require('../../models/postgres')

const DEFAULT_CLEANUP_BATCH_SIZE = 5000
const MAX_CLEANUP_BATCH_SIZE = 50000

const REQUEST_FAILURE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS request_failure_details (
  request_id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  request_started_at TIMESTAMPTZ,
  response_completed_at TIMESTAMPTZ,
  api_key_id TEXT NOT NULL,
  api_key_name TEXT,
  user_id_at_request TEXT,
  account_id TEXT,
  account_type TEXT,
  endpoint TEXT,
  method TEXT,
  model TEXT,
  stream BOOLEAN NOT NULL DEFAULT false,
  http_status INTEGER,
  failure_origin TEXT,
  failure_phase TEXT,
  failure_type TEXT NOT NULL,
  error_code TEXT,
  error_summary TEXT,
  retryable BOOLEAN NOT NULL DEFAULT false,
  retry_after_seconds INTEGER,
  duration_ms INTEGER,
  time_to_first_byte_ms INTEGER,
  client_aborted BOOLEAN NOT NULL DEFAULT false,
  session_id TEXT,
  session_hash TEXT,
  user_agent TEXT,
  has_request_payload BOOLEAN NOT NULL DEFAULT false,
  has_response_payload BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS request_failure_payloads (
  request_id TEXT PRIMARY KEY REFERENCES request_failure_details(request_id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ NOT NULL,
  request_headers JSONB,
  request_body_snapshot JSONB,
  client_response_headers JSONB,
  client_error_body JSONB,
  upstream_error_body JSONB,
  admin_diagnostics JSONB,
  request_body_truncated BOOLEAN NOT NULL DEFAULT false,
  response_body_truncated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_request_failures_timestamp
  ON request_failure_details (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_failures_api_key_timestamp
  ON request_failure_details (api_key_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_failures_user_timestamp
  ON request_failure_details (user_id_at_request, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_failures_account_timestamp
  ON request_failure_details (account_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_failures_status_timestamp
  ON request_failure_details (http_status, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_failures_type_timestamp
  ON request_failure_details (failure_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_failures_endpoint_timestamp
  ON request_failure_details (endpoint, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_failures_session_timestamp
  ON request_failure_details (session_hash, timestamp DESC);
`

const MAIN_COLUMNS = [
  'request_id',
  'timestamp',
  'request_started_at',
  'response_completed_at',
  'api_key_id',
  'api_key_name',
  'user_id_at_request',
  'account_id',
  'account_type',
  'endpoint',
  'method',
  'model',
  'stream',
  'http_status',
  'failure_origin',
  'failure_phase',
  'failure_type',
  'error_code',
  'error_summary',
  'retryable',
  'retry_after_seconds',
  'duration_ms',
  'time_to_first_byte_ms',
  'client_aborted',
  'session_id',
  'session_hash',
  'user_agent',
  'has_request_payload',
  'has_response_payload'
]

const PAYLOAD_COLUMNS = [
  'request_id',
  'timestamp',
  'request_headers',
  'request_body_snapshot',
  'client_response_headers',
  'client_error_body',
  'upstream_error_body',
  'admin_diagnostics',
  'request_body_truncated',
  'response_body_truncated'
]

let schemaPromise = null

function normalizeText(value) {
  if (value === null || value === undefined) {
    return null
  }
  const normalized = String(value).split('\u0000').join('').trim()
  return normalized || null
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

function normalizeNullableInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
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

function sanitizeJson(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return value.split('\u0000').join('')
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return '[Circular]'
  }

  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJson(item, seen))
  }

  const sanitized = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[String(key).split('\u0000').join('')] = sanitizeJson(nestedValue, seen)
  }
  return sanitized
}

function jsonValue(value) {
  if (value === undefined || value === null) {
    return null
  }
  return JSON.stringify(sanitizeJson(value))
}

function hasValue(value) {
  return value !== null && value !== undefined
}

function hasRequestPayload(record = {}) {
  return hasValue(record.requestHeaders) || hasValue(record.requestBodySnapshot)
}

function hasResponsePayload(record = {}) {
  return (
    hasValue(record.clientResponseHeaders) ||
    hasValue(record.clientErrorBody) ||
    hasValue(record.upstreamErrorBody) ||
    hasValue(record.adminDiagnostics)
  )
}

function getMainValue(record, column) {
  switch (column) {
    case 'request_id':
      return normalizeText(record.requestId)
    case 'timestamp':
      return normalizeDate(record.timestamp, new Date())
    case 'request_started_at':
      return normalizeDate(record.requestStartedAt)
    case 'response_completed_at':
      return normalizeDate(record.responseCompletedAt)
    case 'api_key_id':
      return normalizeText(record.apiKeyId)
    case 'api_key_name':
      return normalizeText(record.apiKeyName)
    case 'user_id_at_request':
      return normalizeText(record.userIdAtRequest)
    case 'account_id':
      return normalizeText(record.accountId)
    case 'account_type':
      return normalizeText(record.accountType)
    case 'endpoint':
      return normalizeText(record.endpoint)
    case 'method':
      return normalizeText(record.method)
    case 'model':
      return normalizeText(record.model || 'unknown')
    case 'stream':
      return record.stream === true
    case 'http_status':
      return normalizeNullableInteger(record.httpStatus)
    case 'failure_origin':
      return normalizeText(record.failureOrigin)
    case 'failure_phase':
      return normalizeText(record.failurePhase)
    case 'failure_type':
      return normalizeText(record.failureType || 'request_failed')
    case 'error_code':
      return normalizeText(record.errorCode)
    case 'error_summary':
      return normalizeText(record.errorSummary)
    case 'retryable':
      return record.retryable === true
    case 'retry_after_seconds':
      return normalizeNullableInteger(record.retryAfterSeconds)
    case 'duration_ms':
      return normalizeNullableInteger(record.durationMs)
    case 'time_to_first_byte_ms':
      return normalizeNullableInteger(record.timeToFirstByteMs)
    case 'client_aborted':
      return record.clientAborted === true
    case 'session_id':
      return normalizeText(record.sessionId)
    case 'session_hash':
      return normalizeText(record.sessionHash)
    case 'user_agent':
      return normalizeText(record.userAgent)
    case 'has_request_payload':
      return hasRequestPayload(record)
    case 'has_response_payload':
      return hasResponsePayload(record)
    default:
      return null
  }
}

function getPayloadValue(record, column) {
  switch (column) {
    case 'request_id':
      return normalizeText(record.requestId)
    case 'timestamp':
      return normalizeDate(record.timestamp, new Date())
    case 'request_headers':
      return jsonValue(record.requestHeaders)
    case 'request_body_snapshot':
      return jsonValue(record.requestBodySnapshot)
    case 'client_response_headers':
      return jsonValue(record.clientResponseHeaders)
    case 'client_error_body':
      return jsonValue(record.clientErrorBody)
    case 'upstream_error_body':
      return jsonValue(record.upstreamErrorBody)
    case 'admin_diagnostics':
      return jsonValue(record.adminDiagnostics)
    case 'request_body_truncated':
      return record.requestBodyTruncated === true
    case 'response_body_truncated':
      return record.responseBodyTruncated === true
    default:
      return null
  }
}

function buildUpsertSql(tableName, columns) {
  const assignments = columns
    .filter((column) => column !== 'request_id')
    .map((column) => `${column} = EXCLUDED.${column}`)
    .concat('updated_at = now()')
    .join(', ')

  return (count) => {
    const rows = Array.from({ length: count }, (_value, rowIndex) => {
      const offset = rowIndex * columns.length
      const placeholders = columns.map((_column, columnIndex) => `$${offset + columnIndex + 1}`)
      return `(${placeholders.join(', ')})`
    })
    return `
      INSERT INTO ${tableName} (${columns.join(', ')})
      VALUES ${rows.join(', ')}
      ON CONFLICT (request_id) DO UPDATE SET ${assignments}
    `
  }
}

const buildMainUpsertSql = buildUpsertSql('request_failure_details', MAIN_COLUMNS)
const buildPayloadUpsertSql = buildUpsertSql('request_failure_payloads', PAYLOAD_COLUMNS)

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = postgres.query(REQUEST_FAILURE_SCHEMA_SQL).catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  await schemaPromise
}

async function upsertRequestFailures(records = []) {
  const validRecords = records.filter(
    (record) => normalizeText(record?.requestId) && normalizeText(record?.apiKeyId)
  )
  if (validRecords.length === 0) {
    return { upserted: 0 }
  }

  await ensureSchema()
  await postgres.transaction(async (client) => {
    const mainValues = validRecords.flatMap((record) =>
      MAIN_COLUMNS.map((column) => getMainValue(record, column))
    )
    await client.query(buildMainUpsertSql(validRecords.length), mainValues)

    const payloadRecords = validRecords.filter(
      (record) => hasRequestPayload(record) || hasResponsePayload(record)
    )
    if (payloadRecords.length > 0) {
      const payloadValues = payloadRecords.flatMap((record) =>
        PAYLOAD_COLUMNS.map((column) => getPayloadValue(record, column))
      )
      await client.query(buildPayloadUpsertSql(payloadRecords.length), payloadValues)
    }
  })

  return { upserted: validRecords.length }
}

function createTextSearch(value) {
  const normalized = normalizeText(value)
  return normalized ? `%${normalized.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null
}

function buildWhereClause(filters = {}) {
  const clauses = []
  const values = []
  const addValue = (value) => {
    values.push(value)
    return `$${values.length}`
  }

  const startDate = normalizeDate(filters.startDate)
  const endDate = normalizeDate(filters.endDate)
  if (startDate) {
    clauses.push(`d.timestamp >= ${addValue(startDate)}`)
  }
  if (endDate) {
    clauses.push(`d.timestamp <= ${addValue(endDate)}`)
  }

  for (const [filterKey, column] of [
    ['apiKeyId', 'd.api_key_id'],
    ['userId', 'd.user_id_at_request'],
    ['accountId', 'd.account_id'],
    ['model', 'd.model'],
    ['endpoint', 'd.endpoint'],
    ['failureType', 'd.failure_type'],
    ['failurePhase', 'd.failure_phase'],
    ['failureOrigin', 'd.failure_origin']
  ]) {
    const value = normalizeText(filters[filterKey])
    if (value) {
      clauses.push(`${column} = ${addValue(value)}`)
    }
  }

  const apiKeyIds = Array.isArray(filters.apiKeyIds)
    ? [...new Set(filters.apiKeyIds.map(normalizeText).filter(Boolean))]
    : []
  if (apiKeyIds.length > 0) {
    clauses.push(`d.api_key_id = ANY(${addValue(apiKeyIds)}::text[])`)
  }

  const statusCode = normalizeNullableInteger(filters.statusCode)
  if (statusCode !== null) {
    clauses.push(`d.http_status = ${addValue(statusCode)}`)
  }

  if (filters.includeClientAbort === false || filters.includeClientAbort === 'false') {
    clauses.push('d.client_aborted = false')
  }

  const keyword = createTextSearch(filters.keyword)
  if (keyword) {
    const placeholder = addValue(keyword)
    clauses.push(`(
      d.request_id ILIKE ${placeholder} ESCAPE '\\'
      OR d.api_key_name ILIKE ${placeholder} ESCAPE '\\'
      OR d.account_id ILIKE ${placeholder} ESCAPE '\\'
      OR d.model ILIKE ${placeholder} ESCAPE '\\'
      OR d.endpoint ILIKE ${placeholder} ESCAPE '\\'
      OR d.error_code ILIKE ${placeholder} ESCAPE '\\'
      OR d.error_summary ILIKE ${placeholder} ESCAPE '\\'
    )`)
  }

  return {
    whereSql: clauses.length > 0 ? clauses.join(' AND ') : 'TRUE',
    values
  }
}

function rowToRecord(row = {}, includePayload = false) {
  const record = {
    requestId: row.request_id,
    timestamp: toIsoString(row.timestamp),
    requestStartedAt: toIsoString(row.request_started_at),
    responseCompletedAt: toIsoString(row.response_completed_at),
    apiKeyId: row.api_key_id,
    apiKeyName: row.api_key_name || null,
    userIdAtRequest: row.user_id_at_request || null,
    accountId: row.account_id || null,
    accountType: row.account_type || null,
    endpoint: row.endpoint || null,
    method: row.method || null,
    model: row.model || 'unknown',
    stream: row.stream === true,
    httpStatus: normalizeNullableInteger(row.http_status),
    failureOrigin: row.failure_origin || null,
    failurePhase: row.failure_phase || null,
    failureType: row.failure_type || 'request_failed',
    errorCode: row.error_code || null,
    errorSummary: row.error_summary || null,
    retryable: row.retryable === true,
    retryAfterSeconds: normalizeNullableInteger(row.retry_after_seconds),
    durationMs: normalizeNullableInteger(row.duration_ms),
    timeToFirstByteMs: normalizeNullableInteger(row.time_to_first_byte_ms),
    clientAborted: row.client_aborted === true,
    sessionId: row.session_id || null,
    sessionHash: row.session_hash || null,
    userAgent: row.user_agent || null,
    hasRequestPayload: row.has_request_payload === true,
    hasResponsePayload: row.has_response_payload === true
  }

  if (includePayload) {
    record.requestHeaders = row.request_headers || null
    record.requestBodySnapshot = row.request_body_snapshot || null
    record.clientResponseHeaders = row.client_response_headers || null
    record.clientErrorBody = row.client_error_body || null
    record.upstreamErrorBody = row.upstream_error_body || null
    record.adminDiagnostics = row.admin_diagnostics || null
    record.requestBodyTruncated = row.request_body_truncated === true
    record.responseBodyTruncated = row.response_body_truncated === true
  }

  return record
}

async function listRequestFailures(filters = {}) {
  await ensureSchema()
  const where = buildWhereClause(filters)
  const page = Math.max(normalizeInteger(filters.page, 1), 1)
  const pageSize = Math.min(Math.max(normalizeInteger(filters.pageSize, 50), 1), 200)
  const offset = (page - 1) * pageSize
  const sortOrder = filters.sortOrder === 'asc' ? 'ASC' : 'DESC'
  const values = [...where.values, pageSize, offset]

  const result = await postgres.query(
    `
      SELECT d.*, COUNT(*) OVER()::int AS total_records
      FROM request_failure_details d
      WHERE ${where.whereSql}
      ORDER BY d.timestamp ${sortOrder}, d.request_id ${sortOrder}
      LIMIT $${values.length - 1}
      OFFSET $${values.length}
    `,
    values
  )

  const totalRecords = normalizeInteger(result.rows[0]?.total_records)
  return {
    records: result.rows.map((row) => rowToRecord(row)),
    pagination: {
      currentPage: page,
      pageSize,
      totalRecords,
      totalPages: totalRecords > 0 ? Math.ceil(totalRecords / pageSize) : 0
    }
  }
}

async function getRequestFailureSummary(filters = {}) {
  await ensureSchema()
  const where = buildWhereClause(filters)
  const result = await postgres.query(
    `
      SELECT
        COUNT(*)::int AS total_failures,
        COUNT(*) FILTER (WHERE d.http_status BETWEEN 400 AND 499 AND d.http_status <> 499)::int
          AS client_errors,
        COUNT(*) FILTER (WHERE d.http_status >= 500)::int AS server_errors,
        COUNT(*) FILTER (WHERE d.failure_type = 'rate_limit')::int AS rate_limited,
        COUNT(*) FILTER (WHERE d.failure_type = 'timeout')::int AS timeouts,
        COUNT(*) FILTER (WHERE d.failure_phase = 'stream')::int AS stream_failures,
        COUNT(*) FILTER (WHERE d.client_aborted = true)::int AS client_aborted,
        COALESCE(ROUND(AVG(d.duration_ms)), 0)::int AS avg_duration_ms
      FROM request_failure_details d
      WHERE ${where.whereSql}
    `,
    where.values
  )
  const row = result.rows[0] || {}
  return {
    totalFailures: normalizeInteger(row.total_failures),
    clientErrors: normalizeInteger(row.client_errors),
    serverErrors: normalizeInteger(row.server_errors),
    rateLimited: normalizeInteger(row.rate_limited),
    timeouts: normalizeInteger(row.timeouts),
    streamFailures: normalizeInteger(row.stream_failures),
    clientAborted: normalizeInteger(row.client_aborted),
    avgDurationMs: normalizeInteger(row.avg_duration_ms)
  }
}

async function getAvailableFilters(filters = {}) {
  await ensureSchema()
  const where = buildWhereClause({
    startDate: filters.startDate,
    endDate: filters.endDate,
    apiKeyId: filters.apiKeyId,
    apiKeyIds: filters.apiKeyIds,
    userId: filters.userId
  })
  const [result, apiKeysResult] = await Promise.all([
    postgres.query(
      `
      SELECT
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT d.model), NULL) AS models,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT d.endpoint), NULL) AS endpoints,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT d.failure_type), NULL) AS failure_types,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT d.http_status), NULL) AS status_codes,
        MIN(d.timestamp) AS earliest,
        MAX(d.timestamp) AS latest
      FROM request_failure_details d
      WHERE ${where.whereSql}
    `,
      where.values
    ),
    postgres.query(
      `
        SELECT d.api_key_id, MAX(d.api_key_name) AS api_key_name
        FROM request_failure_details d
        WHERE ${where.whereSql} AND d.api_key_id IS NOT NULL
        GROUP BY d.api_key_id
        ORDER BY COALESCE(MAX(d.api_key_name), d.api_key_id), d.api_key_id
      `,
      where.values
    )
  ])
  const row = result.rows[0] || {}
  return {
    apiKeys: apiKeysResult.rows.map((apiKeyRow) => ({
      id: apiKeyRow.api_key_id,
      name: apiKeyRow.api_key_name || apiKeyRow.api_key_id
    })),
    models: (row.models || []).sort(),
    endpoints: (row.endpoints || []).sort(),
    failureTypes: (row.failure_types || []).sort(),
    statusCodes: (row.status_codes || []).sort((a, b) => a - b),
    dateRange: {
      earliest: toIsoString(row.earliest),
      latest: toIsoString(row.latest)
    }
  }
}

async function getRequestFailure(requestId, filters = {}) {
  await ensureSchema()
  const normalizedRequestId = normalizeText(requestId)
  if (!normalizedRequestId) {
    return null
  }

  const where = buildWhereClause(filters)
  const values = [normalizedRequestId, ...where.values]
  const shiftedWhereSql = where.whereSql.replace(
    /\$(\d+)/g,
    (_match, value) => `$${Number(value) + 1}`
  )
  const result = await postgres.query(
    `
      SELECT
        d.*,
        p.request_headers,
        p.request_body_snapshot,
        p.client_response_headers,
        p.client_error_body,
        p.upstream_error_body,
        p.admin_diagnostics,
        p.request_body_truncated,
        p.response_body_truncated
      FROM request_failure_details d
      LEFT JOIN request_failure_payloads p ON p.request_id = d.request_id
      WHERE d.request_id = $1 AND ${shiftedWhereSql}
      LIMIT 1
    `,
    values
  )
  return result.rows[0] ? rowToRecord(result.rows[0], true) : null
}

async function cleanupExpiredRequestFailures({ retentionHours, batchSize } = {}) {
  await ensureSchema()
  const hours = normalizeInteger(retentionHours)
  if (hours < 1) {
    return { deletedRecords: 0, skipped: true, reason: 'invalid_retention' }
  }

  const limit = Math.min(
    Math.max(normalizeInteger(batchSize, DEFAULT_CLEANUP_BATCH_SIZE), 1),
    MAX_CLEANUP_BATCH_SIZE
  )
  let deletedRecords = 0
  let batches = 0
  let hasMore = true

  while (hasMore) {
    const result = await postgres.query(
      `
        WITH expired AS (
          SELECT request_id
          FROM request_failure_details
          WHERE timestamp < now() - ($1::int * interval '1 hour')
          ORDER BY timestamp ASC
          LIMIT $2
        )
        DELETE FROM request_failure_details d
        USING expired
        WHERE d.request_id = expired.request_id
      `,
      [hours, limit]
    )
    const deleted = Number(result.rowCount || 0)
    if (deleted === 0) {
      hasMore = false
      continue
    }
    deletedRecords += deleted
    batches += 1
    if (deleted < limit) {
      hasMore = false
    }
  }

  return {
    deletedRecords,
    retentionHours: hours,
    batchSize: limit,
    batches,
    skipped: false
  }
}

module.exports = {
  REQUEST_FAILURE_SCHEMA_SQL,
  ensureSchema,
  upsertRequestFailures,
  listRequestFailures,
  getRequestFailureSummary,
  getAvailableFilters,
  getRequestFailure,
  cleanupExpiredRequestFailures,
  rowToRecord
}
