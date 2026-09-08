jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(),
  getConcurrency: jest.fn().mockResolvedValue(0),
  addToIndex: jest.fn(),
  getAllIdsByIndex: jest.fn(),
  getDateStringInTimezone: jest.fn(() => '2026-09-08')
}))
jest.mock('../config/config', () => ({ security: { encryptionKey: 'a'.repeat(32) } }))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/services/tokenRefreshService', () => ({}))
jest.mock('../src/services/quotaCycleIntegrationService', () => ({}))
jest.mock('../src/services/quotaIdentityService', () => ({}))

let redis, records, client
beforeEach(() => {
  jest.resetModules()
  jest.useFakeTimers()
  redis = require('../src/models/redis')
  records = new Map()
  client = {
    hset: jest.fn(async (key, data) => records.set(key, { ...records.get(key), ...data })),
    hgetall: jest.fn(async (key) => ({ ...records.get(key) })),
    sadd: jest.fn(),
    srem: jest.fn(),
    pipeline: () => {
      const keys = []
      const pipeline = {
        hgetall: (key) => {
          keys.push(key)
          return pipeline
        },
        exec: async () => keys.map((key) => [null, { ...records.get(key) }])
      }
      return pipeline
    }
  }
  redis.getClientSafe.mockReturnValue(client)
})
afterEach(() => {
  jest.clearAllMocks()
  jest.clearAllTimers()
  jest.useRealTimers()
})

test.each(['openai', 'openaiResponses'])(
  '%s account persists mode flags and preserves them across unrelated updates',
  async (type) => {
    const service = require(`../src/services/account/${type}AccountService`)
    const account = await service.createAccount({
      name: 'Image modes',
      baseApi: 'https://test.invalid/v1',
      apiKey: 'test-key',
      accountType: 'dedicated',
      supportsImagesGenerations: true,
      supportsImagesSync: false,
      supportsImagesAsync: true
    })
    const key = [...records.keys()][0]
    expect(records.get(key)).toMatchObject({
      supportsImagesSync: 'false',
      supportsImagesAsync: 'true'
    })
    await service.updateAccount(account.id, { description: 'keep modes' })
    expect(records.get(key)).toMatchObject({
      supportsImagesSync: 'false',
      supportsImagesAsync: 'true'
    })
    await service.updateAccount(account.id, {
      supportsImagesSync: 'true',
      supportsImagesAsync: false
    })
    expect(records.get(key)).toMatchObject({
      supportsImagesSync: 'true',
      supportsImagesAsync: 'false'
    })
    const { supportsImageRequest } = require('../src/utils/imageCapabilities')
    const saved = await service.getAccount(account.id)
    expect(supportsImageRequest(saved, false)).toBe(true)
    expect(supportsImageRequest(saved, true)).toBe(false)
    if (type === 'openaiResponses') {
      redis.getAllIdsByIndex.mockResolvedValue([account.id])
      expect((await service.getAllAccounts(true))[0]).toMatchObject({
        supportsImagesSync: true,
        supportsImagesAsync: false
      })
    }
  }
)

test.each(['openai', 'openaiResponses'])(
  '%s account defaults to sync with async disabled',
  async (type) => {
    const service = require(`../src/services/account/${type}AccountService`)
    await service.createAccount({
      name: 'Legacy defaults',
      baseApi: 'https://test.invalid/v1',
      apiKey: 'test-key',
      accountType: 'dedicated',
      supportsImagesGenerations: true
    })
    expect([...records.values()][0]).toMatchObject({
      supportsImagesSync: 'true',
      supportsImagesAsync: 'false'
    })
  }
)
