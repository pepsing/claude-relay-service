const mockRouter = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock('../src/services/apiKeyService', () => ({
  getApiKeySecretInfoMap: jest.fn(),
  revealApiKeySecret: jest.fn()
}))
jest.mock('../src/models/redis', () => ({
  getApiKeysPaginated: jest.fn()
}))
jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (_req, _res, next) => next()
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/utils/costCalculator', () => ({
  formatCost: jest.fn()
}))
jest.mock('../src/services/requestBodyRuleService', () => ({
  validateAndNormalizeRules: jest.fn()
}))
jest.mock('../src/services/usageStatsService', () => ({}))
jest.mock('../src/services/userService', () => ({
  getUserById: jest.fn()
}))
jest.mock('../config/config', () => ({
  system: {
    timezoneOffset: 8
  },
  security: {
    apiKeyPrefix: 'cr_'
  }
}))

const apiKeyService = require('../src/services/apiKeyService')
const redis = require('../src/models/redis')
require('../src/routes/admin/apiKeys')

function findHandler(method, path) {
  const route = mockRouter[method].mock.calls.find((call) => call[0] === path)
  return route?.[2]
}

function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    json: jest.fn((payload) => {
      res.body = payload
      return res
    }),
    set: jest.fn((name, value) => {
      res.headers[name.toLowerCase()] = value
      return res
    }),
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    })
  }

  return res
}

describe('admin API key list response security', () => {
  test('removes the persisted key hash and returns only a preview', async () => {
    redis.getApiKeysPaginated.mockResolvedValue({
      items: [
        {
          id: 'key-1',
          name: 'Example',
          apiKey: 'persisted-sha256-hash',
          userId: '',
          createdBy: 'admin'
        }
      ],
      pagination: {
        page: 1,
        pageSize: 20,
        total: 1,
        totalPages: 1
      },
      availableTags: []
    })
    apiKeyService.getApiKeySecretInfoMap.mockResolvedValue(
      new Map([
        [
          'key-1',
          {
            keyPreview: 'cr_abcd...123456',
            capturedAt: '2026-01-01T00:00:00.000Z',
            lastVerifiedAt: '2026-01-02T00:00:00.000Z'
          }
        ]
      ])
    )
    const handler = findHandler('get', '/api-keys')
    const res = createResponse()

    await handler({ query: {} }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body.data.items[0]).toEqual(
      expect.objectContaining({
        id: 'key-1',
        keyPreview: 'cr_abcd...123456',
        secretCaptured: true
      })
    )
    expect(res.body.data.items[0]).not.toHaveProperty('apiKey')
  })

  test('prevents caching when revealing a plaintext key', async () => {
    apiKeyService.revealApiKeySecret.mockResolvedValue({
      apiKey: `cr_${'a'.repeat(64)}`,
      keyPreview: 'cr_aaaa...aaaaaa',
      capturedAt: '2026-01-01T00:00:00.000Z',
      lastVerifiedAt: '2026-01-02T00:00:00.000Z'
    })
    const handler = findHandler('post', '/api-keys/:keyId/reveal-secret')
    const res = createResponse()

    await handler(
      {
        params: { keyId: 'key-1' },
        admin: { username: 'admin' },
        ip: '127.0.0.1',
        get: jest.fn(() => 'jest')
      },
      res
    )

    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body.data.apiKey).toMatch(/^cr_[a-f0-9]{64}$/)
  })
})
