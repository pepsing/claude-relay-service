const express = require('express')
const { authenticateAdmin } = require('../../middleware/auth')
const adminAuditService = require('../../services/adminAuditService')
const managementApiService = require('../../services/managementApiService')

const SENSITIVE_RESPONSE_FIELDS = new Set([
  'accesstoken',
  'apikey',
  'apikeys',
  'accesskeyid',
  'authorization',
  'bearertoken',
  'clientsecret',
  'cookie',
  'credentials',
  'password',
  'privatekey',
  'proxy',
  'proxyconfig',
  'refreshtoken',
  'secret',
  'sessionkey',
  'token',
  'oauth',
  'openaioauth',
  'awsaccesskeyid'
])

function loadDefaultLegacyRouters() {
  return {
    apiKeys: require('./apiKeys'),
    dashboard: require('./dashboard'),
    usageStats: require('./usageStats'),
    accounts: {
      claude: {
        router: require('./claudeAccounts'),
        basePath: '/claude-accounts',
        testSuffix: 'test',
        refreshSuffix: 'refresh'
      },
      'claude-console': {
        router: require('./claudeConsoleAccounts'),
        basePath: '/claude-console-accounts',
        testSuffix: 'test'
      },
      gemini: {
        router: require('./geminiAccounts'),
        basePath: '/',
        testSuffix: 'test',
        refreshSuffix: 'refresh'
      },
      'gemini-api': {
        router: require('./geminiApiAccounts'),
        basePath: '/gemini-api-accounts',
        testSuffix: 'test'
      },
      openai: {
        router: require('./openaiAccounts'),
        basePath: '/'
      },
      'azure-openai': {
        router: require('./azureOpenaiAccounts'),
        basePath: '/azure-openai-accounts',
        testSuffix: 'test'
      },
      'openai-responses': {
        router: require('./openaiResponsesAccounts'),
        basePath: '/openai-responses-accounts',
        testSuffix: 'test'
      },
      droid: {
        router: require('./droidAccounts'),
        basePath: '/droid-accounts',
        testSuffix: 'test',
        refreshSuffix: 'refresh-token'
      },
      bedrock: {
        router: require('./bedrockAccounts'),
        basePath: '/',
        testSuffix: 'test'
      },
      ccr: {
        router: require('./ccrAccounts'),
        basePath: '/',
        testSuffix: 'test'
      }
    }
  }
}

function buildQueryString(query = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue
    }
    if (Array.isArray(value)) {
      value.forEach((item) => params.append(key, String(item)))
      continue
    }
    params.set(key, String(value))
  }
  const result = params.toString()
  return result ? `?${result}` : ''
}

function joinLegacyPath(basePath, accountId = null, suffix = null) {
  const normalizedBase = basePath === '/' ? '' : String(basePath).replace(/\/+$/, '')
  const segments = [
    normalizedBase,
    accountId ? encodeURIComponent(accountId) : '',
    suffix ? encodeURIComponent(suffix) : ''
  ].filter(Boolean)
  return segments.length > 0 ? segments.join('/') : '/'
}

function redactSecretText(value) {
  return String(value || '')
    .replace(/crsm_[a-f0-9]{64}/gi, 'crsm_[REDACTED]')
    .replace(/cr_[a-f0-9]{64}/gi, 'cr_[REDACTED]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
}

function sanitizeSensitiveData(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSensitiveData(item))
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactSecretText(value) : value
  }

  return Object.entries(value).reduce((result, [key, item]) => {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (
      SENSITIVE_RESPONSE_FIELDS.has(normalizedKey) ||
      normalizedKey.endsWith('token') ||
      normalizedKey.endsWith('secret') ||
      normalizedKey.endsWith('password') ||
      normalizedKey.endsWith('apikey') ||
      normalizedKey.startsWith('credentials') ||
      normalizedKey.startsWith('proxy')
    ) {
      return result
    }
    result[key] = sanitizeSensitiveData(item)
    return result
  }, {})
}

function errorCodeForStatus(statusCode) {
  if (statusCode === 400) {
    return 'BAD_REQUEST'
  }
  if (statusCode === 401) {
    return 'UNAUTHORIZED'
  }
  if (statusCode === 403) {
    return 'FORBIDDEN'
  }
  if (statusCode === 404) {
    return 'NOT_FOUND'
  }
  if (statusCode === 409) {
    return 'CONFLICT'
  }
  if (statusCode === 429) {
    return 'RATE_LIMITED'
  }
  return statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'
}

function normalizeErrorPayload(payload, statusCode) {
  const rawError = payload?.error
  const message = redactSecretText(
    payload?.message ||
      (typeof rawError === 'string' ? rawError : rawError?.message) ||
      'Management API request failed'
  )
  const explicitCode =
    payload?.code ||
    (typeof rawError === 'object' ? rawError?.code : null) ||
    (typeof rawError === 'string' && /^[A-Z][A-Z0-9_]+$/.test(rawError) ? rawError : null)

  return {
    success: false,
    apiVersion: 'v1',
    error: {
      code: explicitCode || errorCodeForStatus(statusCode),
      message
    },
    message
  }
}

function normalizeSuccessPayload(payload, options = {}) {
  const normalized =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...payload }
      : { data: payload }

  normalized.success = normalized.success !== false
  normalized.apiVersion = 'v1'
  if (options.sanitize && normalized.data !== undefined) {
    normalized.data = sanitizeSensitiveData(normalized.data)
  }
  return normalized
}

function normalizeLegacyPayload(payload, statusCode, options = {}) {
  if (statusCode >= 400 || payload?.success === false || (payload?.error && !payload?.success)) {
    return normalizeErrorPayload(payload, statusCode)
  }

  const transformed = options.transform ? options.transform(payload) : payload
  return normalizeSuccessPayload(transformed, options)
}

function sendError(res, error) {
  const statusCode = error.status || 500
  return res.status(statusCode).json(
    normalizeErrorPayload(
      {
        code: error.code,
        message: error.message
      },
      statusCode
    )
  )
}

function delegateToLegacyRouter(legacyRouter, targetBuilder, options = {}) {
  return (req, res, next) => {
    const originalUrl = req.url
    const originalJson = res.json
    let restored = false

    const restore = () => {
      if (restored) {
        return
      }
      restored = true
      req.url = originalUrl
      res.json = originalJson
    }

    res.json = function sendNormalizedJson(payload) {
      try {
        const normalized = normalizeLegacyPayload(payload, res.statusCode, options)
        restore()
        return originalJson.call(this, normalized)
      } catch (error) {
        restore()
        return sendError(res, error)
      }
    }

    try {
      req.url = targetBuilder(req)
      legacyRouter.handle(req, res, (error) => {
        restore()
        if (error) {
          return next(error)
        }
        if (!res.headersSent) {
          return sendError(
            res,
            Object.assign(new Error('Management API operation is not available'), {
              code: 'OPERATION_NOT_AVAILABLE',
              status: 404
            })
          )
        }
        return undefined
      })
    } catch (error) {
      restore()
      return next(error)
    }
    return undefined
  }
}

function createManagementV1Router(options = {}) {
  const router = express.Router()
  const service = options.service || managementApiService
  const auditService = options.auditService || adminAuditService
  const authenticate = options.authenticate || authenticateAdmin
  const legacyRouters = options.legacyRouters || loadDefaultLegacyRouters()

  const getAccountLegacyRoute = (accountType, operation) => {
    service.getAccountDefinition(accountType)
    const definition = legacyRouters.accounts[accountType]
    if (!definition) {
      throw Object.assign(new Error(`Account operation is not available for ${accountType}`), {
        code: 'OPERATION_NOT_AVAILABLE',
        status: 404
      })
    }
    if (operation === 'test' && !definition.testSuffix) {
      throw Object.assign(new Error(`Account testing is not available for ${accountType}`), {
        code: 'OPERATION_NOT_AVAILABLE',
        status: 400
      })
    }
    if (operation === 'refresh' && !definition.refreshSuffix) {
      throw Object.assign(new Error(`Account refresh is not available for ${accountType}`), {
        code: 'OPERATION_NOT_AVAILABLE',
        status: 400
      })
    }
    return definition
  }

  const delegateAccount = (operation) =>
    delegateToLegacyRouter(
      {
        handle: (req, res, next) => {
          try {
            const definition = getAccountLegacyRoute(req.params.accountType, operation)
            return definition.router.handle(req, res, next)
          } catch (error) {
            return next(error)
          }
        }
      },
      (req) => {
        const definition = getAccountLegacyRoute(req.params.accountType, operation)
        if (operation === 'create') {
          return joinLegacyPath(definition.basePath)
        }
        if (operation === 'test') {
          return joinLegacyPath(definition.basePath, req.params.accountId, definition.testSuffix)
        }
        if (operation === 'refresh') {
          return joinLegacyPath(definition.basePath, req.params.accountId, definition.refreshSuffix)
        }
        return joinLegacyPath(definition.basePath, req.params.accountId)
      },
      { sanitize: true }
    )

  router.get('/capabilities', authenticate, (req, res) =>
    res.json(
      normalizeSuccessPayload({
        success: true,
        data: service.getCapabilities(req.admin?.scopes)
      })
    )
  )

  router.get('/api-keys', authenticate, (req, res, next) => {
    try {
      const pagination = service.parsePagination(req.query, {
        defaultPageSize: 10,
        maxPageSize: 100
      })
      const view = req.query.view || 'summary'
      const legacyQuery = {
        ...req.query,
        ...pagination
      }
      delete legacyQuery.view

      return delegateToLegacyRouter(
        legacyRouters.apiKeys,
        () => `/api-keys${buildQueryString(legacyQuery)}`,
        {
          transform: (payload) => service.summarizeApiKeyResponse(payload, view)
        }
      )(req, res, next)
    } catch (error) {
      return next(error)
    }
  })

  router.post(
    '/api-keys',
    authenticate,
    delegateToLegacyRouter(legacyRouters.apiKeys, () => '/api-keys')
  )
  router.put(
    '/api-keys/:keyId',
    authenticate,
    delegateToLegacyRouter(
      legacyRouters.apiKeys,
      (req) => `/api-keys/${encodeURIComponent(req.params.keyId)}`
    )
  )
  router.post(
    '/api-keys/:keyId/reveal',
    authenticate,
    delegateToLegacyRouter(
      legacyRouters.apiKeys,
      (req) => `/api-keys/${encodeURIComponent(req.params.keyId)}/reveal-secret`
    )
  )
  router.delete(
    '/api-keys/:keyId',
    authenticate,
    delegateToLegacyRouter(
      legacyRouters.apiKeys,
      (req) => `/api-keys/${encodeURIComponent(req.params.keyId)}`
    )
  )

  router.get('/accounts/:accountType', authenticate, async (req, res, next) => {
    try {
      const data = await service.listAccounts(req.params.accountType, req.query)
      return res.json(
        normalizeSuccessPayload({
          success: true,
          data
        })
      )
    } catch (error) {
      return next(error)
    }
  })
  router.post('/accounts/:accountType', authenticate, delegateAccount('create'))
  router.put('/accounts/:accountType/:accountId', authenticate, delegateAccount('update'))
  router.delete('/accounts/:accountType/:accountId', authenticate, delegateAccount('delete'))
  router.post('/accounts/:accountType/:accountId/test', authenticate, delegateAccount('test'))
  router.post('/accounts/:accountType/:accountId/refresh', authenticate, delegateAccount('refresh'))

  router.get(
    '/stats/summary',
    authenticate,
    delegateToLegacyRouter(legacyRouters.dashboard, () => '/dashboard', { sanitize: true })
  )
  router.get(
    '/stats/api-keys/:keyId',
    authenticate,
    delegateToLegacyRouter(
      legacyRouters.usageStats,
      (req) =>
        `/api-keys/${encodeURIComponent(req.params.keyId)}/model-stats${buildQueryString(req.query)}`,
      { sanitize: true }
    )
  )
  router.get('/stats/accounts/:accountType/:accountId', authenticate, (req, res, next) => {
    try {
      const definition = service.getAccountDefinition(req.params.accountType)
      if (!definition.stats) {
        throw Object.assign(
          new Error(`Account statistics are not available for ${req.params.accountType}`),
          {
            code: 'OPERATION_NOT_AVAILABLE',
            status: 400
          }
        )
      }
      return delegateToLegacyRouter(
        legacyRouters.usageStats,
        () =>
          `/accounts/${encodeURIComponent(req.params.accountId)}/usage-history${buildQueryString({
            ...req.query,
            platform: req.params.accountType
          })}`,
        { sanitize: true }
      )(req, res, next)
    } catch (error) {
      return next(error)
    }
  })

  router.get('/audit-logs', authenticate, async (req, res, next) => {
    try {
      const pagination = service.parsePagination(req.query, {
        defaultPageSize: 20,
        maxPageSize: 100
      })
      const data = await auditService.list({
        ...pagination,
        action: req.query.action,
        resourceType: req.query.resourceType,
        resourceId: req.query.resourceId,
        actorId: req.query.actorId,
        deviceId: req.query.deviceId,
        deviceName: req.query.deviceName,
        result: req.query.result,
        from: req.query.from,
        to: req.query.to
      })
      return res.json(normalizeSuccessPayload({ success: true, data }))
    } catch (error) {
      return next(error)
    }
  })

  router.get('/audit-logs/:auditId', authenticate, async (req, res, next) => {
    try {
      const auditLog = await auditService.getById(req.params.auditId)
      if (!auditLog) {
        throw Object.assign(new Error('Audit log not found'), {
          code: 'AUDIT_LOG_NOT_FOUND',
          status: 404
        })
      }
      return res.json(normalizeSuccessPayload({ success: true, data: auditLog }))
    } catch (error) {
      return next(error)
    }
  })

  router.use((error, _req, res, _next) => sendError(res, error))

  return router
}

module.exports = createManagementV1Router
module.exports.buildQueryString = buildQueryString
module.exports.createManagementV1Router = createManagementV1Router
module.exports.delegateToLegacyRouter = delegateToLegacyRouter
module.exports.joinLegacyPath = joinLegacyPath
module.exports.normalizeLegacyPayload = normalizeLegacyPayload
module.exports.sanitizeSensitiveData = sanitizeSensitiveData
