jest.mock('../config/config', () => ({
  security: {
    encryptionKey: 'test-encryption-key-32-characters'
  },
  system: {}
}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/services/userService', () => ({}))
jest.mock('../src/services/managementApiKeyService', () => ({
  resolveRequiredScope: jest.fn(),
  validateKey: jest.fn()
}))
jest.mock('../src/services/claudeRelayConfigService', () => ({}))
jest.mock('../src/services/requestFailureDetailService', () => ({}))
jest.mock('../src/models/redis', () => ({
  getSession: jest.fn(),
  setSession: jest.fn().mockResolvedValue(),
  deleteSession: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  security: jest.fn(),
  error: jest.fn(),
  api: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}))
jest.mock('../src/validators/clientValidator', () => jest.fn())
jest.mock('../src/validators/clients/claudeCodeValidator', () => jest.fn())
jest.mock('../src/utils/statsHelper', () => ({
  calculateWaitTimeStats: jest.fn()
}))
jest.mock('../src/utils/modelHelper', () => ({
  isClaudeFamilyModel: jest.fn()
}))
jest.mock('../src/utils/responsePayloadCapture', () => ({
  createResponsePayloadCapture: jest.fn()
}))
jest.mock('../src/utils/metadataUserIdHelper', () => ({}))
jest.mock('../src/utils/requestDetailHelper', () => ({
  hashRequestDetailIdentifier: jest.fn()
}))
jest.mock('../src/utils/requestFailureHelper', () => ({
  markRequestFailure: jest.fn(),
  extractSseFailure: jest.fn()
}))

const managementApiKeyService = require('../src/services/managementApiKeyService')
const redis = require('../src/models/redis')
const logger = require('../src/utils/logger')
const express = require('express')
const request = require('supertest')
const { authenticateAdmin, requestLogger, sanitizeLogPayload } = require('../src/middleware/auth')

function createResponse() {
  const response = {
    statusCode: 200,
    body: null,
    status: jest.fn((statusCode) => {
      response.statusCode = statusCode
      return response
    }),
    json: jest.fn((body) => {
      response.body = body
      return response
    })
  }
  return response
}

describe('management API key authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('authenticates a crsm_ bearer token with the endpoint scope', async () => {
    const managementKey = `crsm_${'a'.repeat(64)}`
    managementApiKeyService.resolveRequiredScope.mockReturnValue('stats:read')
    managementApiKeyService.validateKey.mockResolvedValue({
      valid: true,
      keyData: {
        id: 'key-1',
        name: 'Local MCP',
        scopes: ['stats:read']
      }
    })
    const req = {
      headers: { authorization: `Bearer ${managementKey}` },
      method: 'GET',
      originalUrl: '/admin/dashboard',
      ip: '127.0.0.1'
    }
    const res = createResponse()
    const next = jest.fn()

    await authenticateAdmin(req, res, next)

    expect(managementApiKeyService.validateKey).toHaveBeenCalledWith(managementKey, 'stats:read', {
      ip: '127.0.0.1'
    })
    expect(req.admin).toEqual({
      username: 'management-key:Local MCP',
      authType: 'management-api-key',
      managementApiKeyId: 'key-1',
      scopes: ['stats:read']
    })
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('returns 403 when a management key cannot access the route', async () => {
    const managementKey = `crsm_${'b'.repeat(64)}`
    managementApiKeyService.resolveRequiredScope.mockReturnValue(null)
    managementApiKeyService.validateKey.mockResolvedValue({
      valid: false,
      status: 403,
      error: 'Management API key is not permitted for this endpoint'
    })
    const req = {
      headers: { 'x-management-api-key': managementKey },
      method: 'GET',
      originalUrl: '/admin/management-api-keys',
      ip: '127.0.0.1'
    }
    const res = createResponse()
    const next = jest.fn()

    await authenticateAdmin(req, res, next)

    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  test('keeps the existing admin session path for non-crsm_ tokens', async () => {
    const token = 's'.repeat(64)
    redis.getSession.mockResolvedValue({
      username: 'admin',
      loginTime: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    })
    const req = {
      headers: { authorization: `Bearer ${token}` },
      cookies: {},
      method: 'GET',
      originalUrl: '/admin/dashboard',
      ip: '127.0.0.1',
      get: jest.fn()
    }
    const res = createResponse()
    const next = jest.fn()

    await authenticateAdmin(req, res, next)

    expect(redis.getSession).toHaveBeenCalledWith(token)
    expect(managementApiKeyService.validateKey).not.toHaveBeenCalled()
    expect(req.admin.username).toBe('admin')
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('redacts credentials and plaintext CRS keys from request logs', () => {
    const sanitized = sanitizeLogPayload({
      username: 'admin',
      password: 'secret-password',
      token: 'session-token',
      data: {
        apiKey: `cr_${'a'.repeat(64)}`,
        managementKey: `crsm_${'b'.repeat(64)}`,
        keyPreview: 'crsm_abcd...123456',
        message: `created cr_${'c'.repeat(64)}`
      }
    })

    expect(sanitized).toEqual({
      username: 'admin',
      password: '[REDACTED]',
      token: '[REDACTED]',
      data: {
        apiKey: '[REDACTED]',
        managementKey: '[REDACTED]',
        keyPreview: 'crsm_abcd...123456',
        message: 'created cr_cccc***'
      }
    })
  })

  test('request logger never writes plaintext credentials or CRS keys', async () => {
    const app = express()
    app.use(requestLogger)
    app.use(express.json())
    app.post('/log-redaction-test', (_req, res) =>
      res.json({
        success: true,
        token: 'session-token',
        data: {
          apiKey: `cr_${'d'.repeat(64)}`,
          managementKey: `crsm_${'e'.repeat(64)}`
        }
      })
    )

    await request(app).post('/log-redaction-test').send({
      username: 'admin',
      password: 'secret-password'
    })

    const completionCall = logger.info.mock.calls.find(
      ([message]) => typeof message === 'string' && message.includes('POST /log-redaction-test')
    )
    expect(completionCall).toBeDefined()
    expect(completionCall[1]).toEqual(
      expect.objectContaining({
        req: {
          username: 'admin',
          password: '[REDACTED]'
        },
        res: {
          success: true,
          token: '[REDACTED]',
          data: {
            apiKey: '[REDACTED]',
            managementKey: '[REDACTED]'
          }
        }
      })
    )
  })
})
