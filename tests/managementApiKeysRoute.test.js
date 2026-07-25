jest.mock('../src/middleware/auth', () => ({
  authenticateAdminSession: (req, _res, next) => {
    req.admin = { username: 'admin' }
    next()
  }
}))

jest.mock('../src/services/managementApiKeyService', () => ({
  getSupportedScopes: jest.fn(),
  listKeys: jest.fn(),
  createKey: jest.fn(),
  updateKey: jest.fn(),
  rotateKey: jest.fn(),
  deleteKey: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  error: jest.fn()
}))

const express = require('express')
const request = require('supertest')
const managementApiKeyService = require('../src/services/managementApiKeyService')
const managementApiKeysRouter = require('../src/routes/admin/managementApiKeys')

describe('management API key admin routes', () => {
  let app

  beforeEach(() => {
    jest.clearAllMocks()
    app = express()
    app.use(express.json())
    app.use('/admin', managementApiKeysRouter)
  })

  test('creates a management key and prevents response caching', async () => {
    managementApiKeyService.createKey.mockResolvedValue({
      id: 'key-1',
      name: 'Local MCP',
      managementKey: `crsm_${'a'.repeat(64)}`
    })

    const response = await request(app)
      .post('/admin/management-api-keys')
      .send({
        name: 'Local MCP',
        scopes: ['stats:read']
      })

    expect(response.status).toBe(201)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.data.managementKey).toMatch(/^crsm_/)
    expect(managementApiKeyService.createKey).toHaveBeenCalledWith({
      name: 'Local MCP',
      description: undefined,
      scopes: ['stats:read'],
      expiresAt: undefined,
      createdBy: 'admin'
    })
  })

  test('rejects a past expiry before calling the service', async () => {
    const response = await request(app).post('/admin/management-api-keys').send({
      name: 'Expired',
      expiresAt: '2020-01-01T00:00:00.000Z'
    })

    expect(response.status).toBe(400)
    expect(response.body.message).toBe('expiresAt must be in the future')
    expect(managementApiKeyService.createKey).not.toHaveBeenCalled()
  })

  test('returns the supported scopes', async () => {
    managementApiKeyService.getSupportedScopes.mockReturnValue(['api-keys:read', 'stats:read'])

    const response = await request(app).get('/admin/management-api-keys/scopes')

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual(['api-keys:read', 'stats:read'])
  })
})
