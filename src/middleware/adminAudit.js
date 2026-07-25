const adminAuditService = require('../services/adminAuditService')
const logger = require('../utils/logger')

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const READ_ONLY_POST_PATTERNS = [
  /^\/admin\/api-keys\/(batch-stats|batch-last-usage)$/,
  /^\/admin\/[^/]*accounts\/batch-test-history$/,
  /^\/admin\/(generate-auth-url|poll-auth-status)$/,
  /^\/admin\/[^/]*accounts\/generate-(auth|setup-token)-url$/
]
const ACCOUNT_PREFIXES = [
  ['claude', '/admin/claude-accounts'],
  ['claude-console', '/admin/claude-console-accounts'],
  ['gemini', '/admin/gemini-accounts'],
  ['gemini-api', '/admin/gemini-api-accounts'],
  ['openai', '/admin/openai-accounts'],
  ['azure-openai', '/admin/azure-openai-accounts'],
  ['openai-responses', '/admin/openai-responses-accounts'],
  ['droid', '/admin/droid-accounts'],
  ['bedrock', '/admin/bedrock-accounts'],
  ['ccr', '/admin/ccr-accounts']
]

function normalizePath(value) {
  const path = String(value || '/').split('?')[0]
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function normalizeResourceType(value) {
  return String(value || 'admin')
    .replace(/-accounts?$/i, '')
    .replace(/-api-keys?$/i, '_key')
    .replace(/api-keys?$/i, 'api_key')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

function operationForRequest(method, path, resourceId) {
  if (/\/reveal(?:-secret)?$/i.test(path)) {
    return 'reveal'
  }
  if (/\/rotate$/i.test(path)) {
    return 'rotate'
  }
  if (/\/(test|health-check|health-check-all|test-sync)$/i.test(path)) {
    return 'test'
  }
  if (/\/(refresh|refresh-token|update-profile|update-all-profiles)$/i.test(path)) {
    return 'refresh'
  }
  if (/\/reset(?:-|_)?status$/i.test(path)) {
    return 'reset_status'
  }
  if (/\/restore$/i.test(path)) {
    return 'restore'
  }
  if (/\/(export|export-json|download)$/i.test(path)) {
    return 'export'
  }
  if (/\/(import|import-json)$/i.test(path)) {
    return 'import'
  }
  if (/\/sync-json$/i.test(path)) {
    return 'sync'
  }
  if (method === 'DELETE') {
    return /\/permanent/i.test(path) ? 'permanent_delete' : 'delete'
  }
  if (method === 'PUT' || method === 'PATCH') {
    return 'update'
  }
  if (method === 'POST') {
    return resourceId ? 'execute' : 'create'
  }
  return 'read_sensitive'
}

function classifyAdminOperation(req) {
  const method = String(req.method || 'GET').toUpperCase()
  const path = normalizePath(req.originalUrl || req.url)
  const isAdminPath = path === '/admin' || path.startsWith('/admin/')
  const isAuthPath = path.startsWith('/web/auth/')
  const userAdminMatch = path.match(/^\/users\/([^/]+)\/(status|role|disable-keys)$/)

  if (
    (!isAdminPath && !isAuthPath && !userAdminMatch) ||
    path.startsWith('/admin/management/v1/audit-logs') ||
    READ_ONLY_POST_PATTERNS.some((pattern) => pattern.test(path))
  ) {
    return null
  }
  const isSensitiveRead =
    method === 'GET' && /\/(reveal|secret|export|download)(?:\/|$)/i.test(path)
  if (!WRITE_METHODS.has(method) && !isSensitiveRead) {
    return null
  }

  if (path === '/web/auth/login') {
    return { action: 'auth.login', resourceType: 'admin_auth' }
  }
  if (path === '/web/auth/logout') {
    return { action: 'auth.logout', resourceType: 'admin_auth' }
  }
  if (path === '/web/auth/change-password') {
    return { action: 'auth.change_password', resourceType: 'admin_auth' }
  }
  if (userAdminMatch) {
    const operationMap = {
      status: 'update_status',
      role: 'update_role',
      'disable-keys': 'disable_keys'
    }
    return {
      action: `user.${operationMap[userAdminMatch[2]]}`,
      resourceType: 'user',
      resourceId: userAdminMatch[1],
      requiresAdmin: true
    }
  }

  const managementKeyMatch = path.match(
    /^\/admin\/management-api-keys(?:\/([^/]+))?(?:\/(rotate))?$/
  )
  if (managementKeyMatch) {
    const resourceId = managementKeyMatch[1] || null
    const operation = managementKeyMatch[2] || operationForRequest(method, path, resourceId)
    return {
      action: `management_key.${operation}`,
      resourceType: 'management_key',
      resourceId
    }
  }

  const v1ApiKeyMatch = path.match(
    /^\/admin\/management\/v1\/api-keys(?:\/([^/]+))?(?:\/(reveal))?$/
  )
  const legacyApiKeyMatch = path.match(/^\/admin\/api-keys(?:\/([^/]+))?(?:\/([^/]+))?$/)
  const apiKeyMatch = v1ApiKeyMatch || legacyApiKeyMatch
  if (apiKeyMatch) {
    const resourceId = apiKeyMatch[1] || null
    const suffix = apiKeyMatch[2] || ''
    const operation = operationForRequest(method, suffix ? `${path}/${suffix}` : path, resourceId)
    return {
      action: `api_key.${operation}`,
      resourceType: 'api_key',
      resourceId
    }
  }

  const v1AccountMatch = path.match(
    /^\/admin\/management\/v1\/accounts\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/
  )
  if (v1AccountMatch) {
    const accountType = v1AccountMatch[1]
    const resourceId = v1AccountMatch[2] || null
    const operation = operationForRequest(method, path, resourceId)
    return {
      action: `account.${operation}`,
      resourceType: 'account',
      resourceId,
      metadata: { accountType }
    }
  }

  for (const [accountType, prefix] of ACCOUNT_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      const segments = path.slice(prefix.length).split('/').filter(Boolean)
      const resourceId = segments[0] || null
      return {
        action: `account.${operationForRequest(method, path, resourceId)}`,
        resourceType: 'account',
        resourceId,
        metadata: { accountType }
      }
    }
  }

  const segments = path.split('/').filter(Boolean)
  const resourceSegment = segments[1] === 'management' ? segments[3] : segments[1] || 'admin'
  const resourceType = normalizeResourceType(resourceSegment)
  const resourceId = segments.length > 2 ? segments[segments.length - 1] : null
  const settingsLike = /(config|settings|rates|rules)/i.test(resourceType)
  const operation =
    settingsLike && method === 'POST'
      ? 'update'
      : operationForRequest(method, path, resourceId === resourceSegment ? null : resourceId)

  return {
    action: `${resourceType}.${operation}`,
    resourceType,
    resourceId: resourceId === resourceSegment ? null : resourceId
  }
}

function getHeader(req, name) {
  const value = req.get?.(name) || req.headers?.[name.toLowerCase()]
  return typeof value === 'string' ? value : ''
}

function decodeHeaderValue(value) {
  try {
    return decodeURIComponent(String(value || ''))
  } catch (_error) {
    return String(value || '')
  }
}

function parseClientHeader(value) {
  const [name, version = ''] = String(value || '').split('/', 2)
  return {
    clientName: name || '',
    clientVersion: version || ''
  }
}

function resolveActor(req, classification) {
  if (req.auditActor) {
    return req.auditActor
  }
  if (req.admin?.authType === 'management-api-key') {
    return {
      actorType: 'management-key',
      actorId: req.admin.managementApiKeyId || '',
      actorName: req.managementApiKey?.name || req.admin.username || '',
      authMethod: 'management-api-key'
    }
  }
  if (req.admin?.username) {
    return {
      actorType: 'admin-session',
      actorId: req.admin.username,
      actorName: req.admin.username,
      authMethod: 'admin-session'
    }
  }
  if (classification.resourceType === 'admin_auth') {
    const claimedUsername = req.body?.username || req.body?.newUsername || ''
    return {
      actorType: 'admin-session',
      actorId: claimedUsername,
      actorName: claimedUsername,
      authMethod: 'admin-session'
    }
  }
  return {
    actorType: 'unknown',
    actorId: '',
    actorName: '',
    authMethod: ''
  }
}

function resolveErrorCode(responseBody, statusCode) {
  if (statusCode < 400 || !responseBody || typeof responseBody !== 'object') {
    return ''
  }
  const { error } = responseBody
  if (error && typeof error === 'object' && error.code) {
    return String(error.code)
  }
  if (responseBody.code) {
    return String(responseBody.code)
  }
  if (typeof error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error)) {
    return error
  }
  return `HTTP_${statusCode}`
}

function createAdminAuditMiddleware(options = {}) {
  const service = options.service || adminAuditService

  return (req, res, next) => {
    const classification = classifyAdminOperation(req)
    if (!classification || !service.isEnabled()) {
      return next()
    }

    const originalJson = res.json.bind(res)
    res.json = (body) => {
      res._adminAuditResponseBody = body
      return originalJson(body)
    }

    let auditRecorded = false
    const recordAudit = (clientAborted = false) => {
      if (auditRecorded) {
        return
      }
      auditRecorded = true
      if (classification.requiresAdmin && !req.admin) {
        return
      }
      const responseBody = res._responseBody || res._adminAuditResponseBody
      const responseData =
        responseBody?.data && typeof responseBody.data === 'object' ? responseBody.data : {}
      const actor = resolveActor(req, classification)
      const client = parseClientHeader(getHeader(req, 'x-crs-client'))
      const changedFields =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? Object.keys(req.body)
          : []
      const resourceId =
        classification.resourceId || responseData.id || responseData.keyId || responseData.accountId
      const resourceName =
        req.body?.name || responseData.name || req.body?.newUsername || responseData.newUsername

      const statusCode = clientAborted ? 499 : res.statusCode
      service
        .record({
          requestId: req.requestId,
          ...actor,
          deviceId: getHeader(req, 'x-crs-device-id'),
          deviceName: decodeHeaderValue(getHeader(req, 'x-crs-device-name')),
          ...client,
          clientIp: req.ip || req.connection?.remoteAddress || '',
          userAgent: getHeader(req, 'user-agent'),
          action: classification.action,
          resourceType: classification.resourceType,
          resourceId,
          resourceName,
          result: !clientAborted && statusCode < 400 ? 'success' : 'failure',
          httpMethod: req.method,
          path: normalizePath(req.originalUrl || req.url),
          statusCode,
          changedFields,
          metadata: classification.metadata || {},
          errorCode: clientAborted ? 'CLIENT_ABORTED' : resolveErrorCode(responseBody, statusCode)
        })
        .catch((error) => {
          logger.warn(`Failed to record admin audit event: ${error.message}`)
        })
    }

    res.on('finish', () => recordAudit(false))
    res.on('close', () => {
      if (!res.writableEnded) {
        recordAudit(true)
      }
    })

    return next()
  }
}

const adminAuditMiddleware = createAdminAuditMiddleware()

module.exports = {
  adminAuditMiddleware,
  classifyAdminOperation,
  createAdminAuditMiddleware,
  parseClientHeader,
  resolveActor,
  resolveErrorCode
}
