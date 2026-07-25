jest.mock('../config/config', () => ({
  security: {
    encryptionKey: 'test-encryption-key-32-characters'
  }
}))

jest.mock('../src/models/redis', () => ({
  setManagementApiKey: jest.fn(),
  getManagementApiKey: jest.fn(),
  getAllManagementApiKeys: jest.fn(),
  findManagementApiKeyByHash: jest.fn(),
  deleteManagementApiKey: jest.fn(),
  touchManagementApiKey: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  security: jest.fn()
}))

const redis = require('../src/models/redis')
const {
  ManagementApiKeyService,
  MANAGEMENT_SCOPES
} = require('../src/services/managementApiKeyService')

describe('ManagementApiKeyService', () => {
  let service

  beforeEach(() => {
    jest.clearAllMocks()
    service = new ManagementApiKeyService()
  })

  test('creates a crsm_ key while only persisting its hash', async () => {
    redis.setManagementApiKey.mockResolvedValue()

    const result = await service.createKey({
      name: 'Local MCP',
      scopes: ['api-keys:read', 'stats:read'],
      createdBy: 'admin'
    })

    expect(result.managementKey).toMatch(/^crsm_[a-f0-9]{64}$/)
    expect(result.scopes).toEqual(['api-keys:read', 'stats:read'])
    expect(redis.setManagementApiKey).toHaveBeenCalledTimes(1)

    const [, storedData, storedHash] = redis.setManagementApiKey.mock.calls[0]
    expect(storedData.keyHash).toBe(storedHash)
    expect(storedHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(storedData)).not.toContain(result.managementKey)
  })

  test('defaults new keys to every supported scope', async () => {
    redis.setManagementApiKey.mockResolvedValue()

    const result = await service.createKey({ name: 'Full access' })

    expect(result.scopes).toEqual(MANAGEMENT_SCOPES)
  })

  test.each([
    ['GET', '/admin/api-keys', 'api-keys:read'],
    ['POST', '/admin/api-keys', 'api-keys:write'],
    ['POST', '/admin/api-keys/key-1/reveal-secret', 'api-keys:reveal'],
    ['GET', '/admin/claude-accounts', 'accounts:read'],
    ['POST', '/admin/claude-accounts/account-1/test', 'accounts:test'],
    ['POST', '/admin/claude-accounts/account-1/refresh', 'accounts:refresh'],
    ['DELETE', '/admin/bedrock-accounts/account-1', 'accounts:write'],
    ['GET', '/admin/dashboard?period=daily', 'stats:read'],
    ['GET', '/admin/api-keys/key-1/model-stats', 'stats:read'],
    ['GET', '/admin/management/v1/api-keys?pageSize=1', 'api-keys:read'],
    ['POST', '/admin/management/v1/api-keys/key-1/reveal', 'api-keys:reveal'],
    ['GET', '/admin/management/v1/accounts/claude', 'accounts:read'],
    ['POST', '/admin/management/v1/accounts/claude/account-1/test', 'accounts:test'],
    ['POST', '/admin/management/v1/accounts/claude/account-1/refresh', 'accounts:refresh'],
    ['GET', '/admin/management/v1/stats/summary', 'stats:read'],
    ['GET', '/admin/management/v1/audit-logs', 'audit:read'],
    ['GET', '/admin/management-api-keys', null],
    ['GET', '/admin/users', null]
  ])('maps %s %s to scope %s', (method, path, expectedScope) => {
    expect(service.resolveRequiredScope(method, path)).toBe(expectedScope)
  })

  test('validates scope and updates last-used metadata', async () => {
    const managementKey = `crsm_${'a'.repeat(64)}`
    const keyHash = service.hashKey(managementKey)
    redis.findManagementApiKeyByHash.mockResolvedValue({
      id: 'key-1',
      name: 'Stats MCP',
      keyHash,
      isActive: 'true',
      scopes: JSON.stringify(['stats:read']),
      expiresAt: ''
    })
    redis.touchManagementApiKey.mockResolvedValue()

    const result = await service.validateKey(managementKey, 'stats:read', {
      ip: '127.0.0.1'
    })

    expect(result.valid).toBe(true)
    expect(result.keyData.scopes).toEqual(['stats:read'])
    expect(redis.touchManagementApiKey).toHaveBeenCalledWith(
      'key-1',
      expect.any(String),
      '127.0.0.1'
    )
  })

  test('allows capabilities access with any supported read scope', async () => {
    const managementKey = `crsm_${'c'.repeat(64)}`
    const keyHash = service.hashKey(managementKey)
    redis.findManagementApiKeyByHash.mockResolvedValue({
      id: 'key-3',
      name: 'Accounts reader',
      keyHash,
      isActive: 'true',
      scopes: JSON.stringify(['accounts:read']),
      expiresAt: ''
    })
    redis.touchManagementApiKey.mockResolvedValue()

    const requiredScopes = service.resolveRequiredScope('GET', '/admin/management/v1/capabilities')
    const result = await service.validateKey(managementKey, requiredScopes)

    expect(requiredScopes).toEqual(['api-keys:read', 'accounts:read', 'stats:read', 'audit:read'])
    expect(result.valid).toBe(true)
  })

  test('rejects valid keys that lack the endpoint scope', async () => {
    const managementKey = `crsm_${'b'.repeat(64)}`
    const keyHash = service.hashKey(managementKey)
    redis.findManagementApiKeyByHash.mockResolvedValue({
      id: 'key-2',
      name: 'Read only',
      keyHash,
      isActive: 'true',
      scopes: JSON.stringify(['accounts:read']),
      expiresAt: ''
    })

    const result = await service.validateKey(managementKey, 'accounts:write')

    expect(result).toEqual({
      valid: false,
      status: 403,
      error: 'Management API key lacks required scope: accounts:write'
    })
    expect(redis.touchManagementApiKey).not.toHaveBeenCalled()
  })

  test('rotation replaces the hash and returns the new key once', async () => {
    redis.getManagementApiKey.mockResolvedValue({
      name: 'Local MCP',
      keyHash: 'old-hash',
      keyPreview: 'crsm_old',
      scopes: JSON.stringify(['api-keys:read']),
      isActive: 'true',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    redis.setManagementApiKey.mockResolvedValue()

    const result = await service.rotateKey('key-1', 'admin')

    expect(result.managementKey).toMatch(/^crsm_[a-f0-9]{64}$/)
    expect(redis.setManagementApiKey).toHaveBeenCalledWith(
      'key-1',
      expect.objectContaining({
        keyHash: expect.not.stringMatching(/^old-hash$/),
        lastUsedAt: '',
        lastUsedIp: ''
      }),
      expect.any(String),
      'old-hash'
    )
  })
})
