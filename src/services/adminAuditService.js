const config = require('../../config/config')
const postgres = require('../models/postgres')
const logger = require('../utils/logger')

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  auth_method TEXT,
  device_id TEXT,
  device_name TEXT,
  client_name TEXT,
  client_version TEXT,
  client_ip TEXT,
  user_agent TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  resource_name TEXT,
  result TEXT NOT NULL,
  http_method TEXT,
  path TEXT,
  status_code INTEGER,
  changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_occurred_at
  ON admin_audit_logs (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_actor_id_occurred_at
  ON admin_audit_logs (actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_device_id_occurred_at
  ON admin_audit_logs (device_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_action_occurred_at
  ON admin_audit_logs (action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_resource_occurred_at
  ON admin_audit_logs (resource_type, resource_id, occurred_at DESC);
`

const SENSITIVE_FIELD_PATTERN =
  /^(authorization|cookie|password|token|access[-_]?token|refresh[-_]?token|api[-_]?key|management[-_]?key|secret|credential(?:s)?|private[-_]?key|proxy)$/i
const SECRET_VALUE_PATTERN = /\b(crsm|cr)_[a-f0-9]{16,}\b/gi

function normalizeText(value, maxLength = 500) {
  if (value === undefined || value === null) {
    return null
  }
  const normalized = [...String(value).replace(SECRET_VALUE_PATTERN, '$1_[REDACTED]')]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127 ? ' ' : character
    })
    .join('')
    .trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function sanitizeMetadata(value, depth = 0) {
  if (depth > 4) {
    return '[TRUNCATED]'
  }
  if (typeof value === 'string') {
    return value.replace(SECRET_VALUE_PATTERN, '$1_[REDACTED]').slice(0, 1000)
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeMetadata(item, depth + 1))
  }

  return Object.entries(value)
    .slice(0, 50)
    .reduce((result, [key, nestedValue]) => {
      result[key] = SENSITIVE_FIELD_PATTERN.test(key)
        ? '[REDACTED]'
        : sanitizeMetadata(nestedValue, depth + 1)
      return result
    }, {})
}

function mapAuditRow(row) {
  if (!row) {
    return null
  }
  return {
    id: String(row.id),
    requestId: row.request_id || '',
    occurredAt: row.occurred_at,
    actorType: row.actor_type,
    actorId: row.actor_id || '',
    actorName: row.actor_name || '',
    authMethod: row.auth_method || '',
    deviceId: row.device_id || '',
    deviceName: row.device_name || '',
    clientName: row.client_name || '',
    clientVersion: row.client_version || '',
    clientIp: row.client_ip || '',
    userAgent: row.user_agent || '',
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id || '',
    resourceName: row.resource_name || '',
    result: row.result,
    httpMethod: row.http_method || '',
    path: row.path || '',
    statusCode: row.status_code,
    changedFields: Array.isArray(row.changed_fields) ? row.changed_fields : [],
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    errorCode: row.error_code || ''
  }
}

class AdminAuditService {
  constructor(options = {}) {
    this.postgres = options.postgres || postgres
    this.schemaReady = false
    this.schemaPromise = null
    this.lastCleanupAt = 0
  }

  isEnabled() {
    return config.adminAudit?.enabled !== false
  }

  getRetentionDays() {
    return Math.max(1, Number(config.adminAudit?.retentionDays) || 180)
  }

  async ensureSchema() {
    if (!this.isEnabled()) {
      return false
    }
    if (this.schemaReady) {
      return true
    }
    if (!this.schemaPromise) {
      this.schemaPromise = this.postgres
        .query(SCHEMA_SQL)
        .then(() => {
          this.schemaReady = true
          return true
        })
        .catch((error) => {
          this.schemaPromise = null
          throw error
        })
    }
    return await this.schemaPromise
  }

  async initialize() {
    if (!(await this.ensureSchema())) {
      return false
    }
    await this.cleanupExpired()
    return true
  }

  async record(event = {}) {
    if (!(await this.ensureSchema())) {
      return null
    }

    const action = normalizeText(event.action, 120)
    const resourceType = normalizeText(event.resourceType, 120)
    if (!action || !resourceType) {
      throw new Error('Audit action and resource type are required')
    }

    const changedFields = Array.isArray(event.changedFields)
      ? [
          ...new Set(event.changedFields.map((field) => normalizeText(field, 120)).filter(Boolean))
        ].slice(0, 100)
      : []
    const metadata = sanitizeMetadata(event.metadata || {})
    const values = [
      normalizeText(event.requestId, 120),
      normalizeText(event.actorType, 60) || 'unknown',
      normalizeText(event.actorId, 160),
      normalizeText(event.actorName, 160),
      normalizeText(event.authMethod, 60),
      normalizeText(event.deviceId, 160),
      normalizeText(event.deviceName, 160),
      normalizeText(event.clientName, 100),
      normalizeText(event.clientVersion, 60),
      normalizeText(event.clientIp, 100),
      normalizeText(event.userAgent, 500),
      action,
      resourceType,
      normalizeText(event.resourceId, 200),
      normalizeText(event.resourceName, 200),
      event.result === 'success' ? 'success' : 'failure',
      normalizeText(event.httpMethod, 12),
      normalizeText(event.path, 500),
      Number.isInteger(event.statusCode) ? event.statusCode : null,
      JSON.stringify(changedFields),
      JSON.stringify(metadata),
      normalizeText(event.errorCode, 120)
    ]

    const result = await this.postgres.query(
      `
        INSERT INTO admin_audit_logs (
          request_id, actor_type, actor_id, actor_name, auth_method,
          device_id, device_name, client_name, client_version,
          client_ip, user_agent, action, resource_type, resource_id,
          resource_name, result, http_method, path, status_code,
          changed_fields, metadata, error_code
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19,
          $20::jsonb, $21::jsonb, $22
        )
        RETURNING *
      `,
      values
    )

    this.maybeCleanup()
    return mapAuditRow(result.rows[0])
  }

  async list(options = {}) {
    if (!(await this.ensureSchema())) {
      return {
        items: [],
        pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 }
      }
    }

    const page = Math.max(1, Number(options.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || 20))
    if (options.result && !['success', 'failure'].includes(options.result)) {
      throw Object.assign(new Error('result must be success or failure'), {
        code: 'INVALID_QUERY_PARAMETER',
        status: 400
      })
    }
    const conditions = []
    const values = []
    const addCondition = (sql, value) => {
      values.push(value)
      conditions.push(sql.replace('?', `$${values.length}`))
    }

    const exactFilters = [
      ['action', options.action],
      ['resource_type', options.resourceType],
      ['resource_id', options.resourceId],
      ['actor_id', options.actorId],
      ['device_id', options.deviceId],
      ['device_name', options.deviceName],
      ['result', options.result]
    ]
    for (const [column, rawValue] of exactFilters) {
      const value = normalizeText(rawValue, 200)
      if (value) {
        addCondition(`${column} = ?`, value)
      }
    }

    if (options.from) {
      const from = new Date(options.from)
      if (!Number.isFinite(from.getTime())) {
        throw Object.assign(new Error('from must be a valid ISO 8601 date'), {
          code: 'INVALID_QUERY_PARAMETER',
          status: 400
        })
      }
      addCondition('occurred_at >= ?', from.toISOString())
    }
    if (options.to) {
      const to = new Date(options.to)
      if (!Number.isFinite(to.getTime())) {
        throw Object.assign(new Error('to must be a valid ISO 8601 date'), {
          code: 'INVALID_QUERY_PARAMETER',
          status: 400
        })
      }
      addCondition('occurred_at <= ?', to.toISOString())
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const countResult = await this.postgres.query(
      `SELECT COUNT(*)::int AS total FROM admin_audit_logs ${whereClause}`,
      values
    )
    const total = Number(countResult.rows[0]?.total) || 0
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const safePage = Math.min(page, totalPages)
    const queryValues = [...values, pageSize, (safePage - 1) * pageSize]
    const rowsResult = await this.postgres.query(
      `
        SELECT *
        FROM admin_audit_logs
        ${whereClause}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${values.length + 1}
        OFFSET $${values.length + 2}
      `,
      queryValues
    )

    return {
      items: rowsResult.rows.map((row) => mapAuditRow(row)),
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

  async getById(id) {
    if (!(await this.ensureSchema())) {
      return null
    }
    if (!/^\d+$/.test(String(id || ''))) {
      return null
    }
    const result = await this.postgres.query('SELECT * FROM admin_audit_logs WHERE id = $1', [
      String(id)
    ])
    return mapAuditRow(result.rows[0])
  }

  async cleanupExpired() {
    if (!(await this.ensureSchema())) {
      return 0
    }
    const result = await this.postgres.query(
      `
        DELETE FROM admin_audit_logs
        WHERE occurred_at < NOW() - ($1::int * INTERVAL '1 day')
      `,
      [this.getRetentionDays()]
    )
    this.lastCleanupAt = Date.now()
    return result.rowCount || 0
  }

  maybeCleanup() {
    if (Date.now() - this.lastCleanupAt < 24 * 60 * 60 * 1000) {
      return
    }
    this.lastCleanupAt = Date.now()
    this.cleanupExpired().catch((error) => {
      logger.warn(`Failed to clean expired admin audit logs: ${error.message}`)
    })
  }
}

const adminAuditService = new AdminAuditService()

module.exports = adminAuditService
module.exports.AdminAuditService = AdminAuditService
module.exports.SCHEMA_SQL = SCHEMA_SQL
module.exports.mapAuditRow = mapAuditRow
module.exports.sanitizeMetadata = sanitizeMetadata
