// Regression test: an API key bound to a dedicated Claude account must NEVER be
// silently routed to a different account.
//
// Bug: markAccountRateLimited sets schedulable='false' AND the relay writes a
// temp_unavailable key. The bound-account path checked temp_unavailable FIRST and only
// logged "falling back to pool", so the CLAUDE_DEDICATED_RATE_LIMITED throw was dead code
// and the dedicated key quietly used other accounts from the shared pool.

const mockConfig = { claude: {} }

jest.mock('../config/config', () => mockConfig)
jest.mock('../src/services/account/claudeAccountService', () => ({
  isAccountRateLimited: jest.fn(),
  getAccountRateLimitInfo: jest.fn(),
  isAccountModelRateLimited: jest.fn(),
  getAccountModelRateLimitInfo: jest.fn(),
  clearExpiredModelRateLimit: jest.fn()
}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({}))
jest.mock('../src/services/account/bedrockAccountService', () => ({}))
jest.mock('../src/services/account/ccrAccountService', () => ({}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/services/stickySessionGroupService', () => ({
  filterAccountsByGroup: jest.fn(),
  getGroup: jest.fn(),
  getGroupForAccount: jest.fn(),
  getGroupMembers: jest.fn(),
  isAccountInGroup: jest.fn()
}))
jest.mock('../src/services/claudeRelayConfigService', () => ({ getConfig: jest.fn() }))
const mockRedisClient = {
  del: jest.fn(),
  get: jest.fn(),
  setex: jest.fn(),
  ttl: jest.fn()
}
jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(),
  getClientSafe: jest.fn(() => mockRedisClient)
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn((value) => value !== false && value !== 'false'),
  sortAccountsByPriority: jest.fn((accounts) => accounts)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))

const claudeAccountService = require('../src/services/account/claudeAccountService')
const claudeRelayConfigService = require('../src/services/claudeRelayConfigService')
const stickySessionGroupService = require('../src/services/stickySessionGroupService')
const redis = require('../src/models/redis')
const scheduler = require('../src/services/scheduler/unifiedClaudeScheduler')

const BOUND_ID = 'acct-0w'
// mirrors production: API key "river" bound to account "0w"
const apiKeyData = { id: 'key-river', name: 'river', claudeAccountId: BOUND_ID }

const healthyAccount = {
  id: BOUND_ID,
  name: '0w',
  isActive: 'true',
  status: 'active',
  schedulable: 'true'
}

describe('dedicated (bound) Claude account never silently falls back to the shared pool', () => {
  let tempSpy

  beforeEach(() => {
    jest.clearAllMocks()
    mockConfig.claude.dedicatedAccountFallback = false
    claudeAccountService.isAccountRateLimited.mockResolvedValue(false)
    claudeAccountService.isAccountModelRateLimited.mockResolvedValue(false)
    claudeAccountService.clearExpiredModelRateLimit.mockResolvedValue({ success: true })
    claudeAccountService.getAccountRateLimitInfo.mockResolvedValue({
      rateLimitEndAt: '2026-07-07T07:00:00.000Z'
    })
    claudeAccountService.getAccountModelRateLimitInfo.mockResolvedValue({ resetAt: null })
    claudeRelayConfigService.getConfig.mockResolvedValue({
      stickySessionEnabled: true,
      stickySessionDefaultMode: 'fallback'
    })
    stickySessionGroupService.getGroupForAccount.mockResolvedValue(null)
    stickySessionGroupService.getGroup.mockResolvedValue(null)
    stickySessionGroupService.getGroupMembers.mockResolvedValue([])
    stickySessionGroupService.filterAccountsByGroup.mockImplementation(async (accounts) => accounts)
    stickySessionGroupService.isAccountInGroup.mockResolvedValue(true)
    mockRedisClient.get.mockResolvedValue(null)
    mockRedisClient.setex.mockResolvedValue('OK')
    mockRedisClient.del.mockResolvedValue(1)
    tempSpy = jest.spyOn(scheduler, 'isAccountTemporarilyUnavailable').mockResolvedValue(false)
  })

  afterEach(() => {
    tempSpy.mockRestore()
  })

  it('uses the bound account when it is healthy', async () => {
    redis.getClaudeAccount.mockResolvedValue(healthyAccount)

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-opus-4-8')
    ).resolves.toEqual({ accountId: BOUND_ID, accountType: 'claude-official' })
  })

  it('throws CLAUDE_DEDICATED_RATE_LIMITED when rate limited AND temp-unavailable (the production bug)', async () => {
    // markAccountRateLimited sets schedulable=false + rateLimitAutoStopped,
    // and the relay also writes temp_unavailable — the exact state of "0w".
    redis.getClaudeAccount.mockResolvedValue({
      ...healthyAccount,
      schedulable: 'false',
      rateLimitStatus: 'limited',
      rateLimitAutoStopped: 'true'
    })
    claudeAccountService.isAccountRateLimited.mockResolvedValue(true)
    tempSpy.mockResolvedValue(true)

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-opus-4-8')
    ).rejects.toMatchObject({ code: 'CLAUDE_DEDICATED_RATE_LIMITED', accountId: BOUND_ID })
  })

  it('throws CLAUDE_DEDICATED_RATE_LIMITED when only schedulable=false via rate-limit auto-stop', async () => {
    redis.getClaudeAccount.mockResolvedValue({
      ...healthyAccount,
      schedulable: 'false',
      rateLimitAutoStopped: 'true'
    })

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-opus-4-8')
    ).rejects.toMatchObject({ code: 'CLAUDE_DEDICATED_RATE_LIMITED' })
  })

  it('throws CLAUDE_DEDICATED_RATE_LIMITED when the requested model family is limited', async () => {
    redis.getClaudeAccount.mockResolvedValue(healthyAccount)
    claudeAccountService.isAccountModelRateLimited.mockResolvedValue(true)
    claudeAccountService.getAccountModelRateLimitInfo.mockResolvedValue({ resetAt: 'soon' })

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-sonnet-4-5')
    ).rejects.toMatchObject({ code: 'CLAUDE_DEDICATED_RATE_LIMITED', modelFamily: 'sonnet' })
  })

  it('throws CLAUDE_DEDICATED_UNAVAILABLE when only temporarily unavailable', async () => {
    redis.getClaudeAccount.mockResolvedValue(healthyAccount)
    tempSpy.mockResolvedValue(true)

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-opus-4-8')
    ).rejects.toMatchObject({
      code: 'CLAUDE_DEDICATED_UNAVAILABLE',
      reason: 'temporarily_unavailable'
    })
  })

  it('throws CLAUDE_DEDICATED_UNAVAILABLE when the bound account is inactive', async () => {
    redis.getClaudeAccount.mockResolvedValue({ ...healthyAccount, isActive: 'false' })

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-opus-4-8')
    ).rejects.toMatchObject({ code: 'CLAUDE_DEDICATED_UNAVAILABLE', reason: 'inactive_or_error' })
  })

  it('falls back to the shared pool ONLY when dedicatedAccountFallback is enabled', async () => {
    const fallbackSpy = jest
      .spyOn(scheduler, '_isDedicatedAccountFallbackEnabled')
      .mockReturnValue(true)
    redis.getClaudeAccount.mockResolvedValue(healthyAccount)
    tempSpy.mockResolvedValue(true)
    const poolSpy = jest.spyOn(scheduler, '_getAllAvailableAccounts').mockResolvedValue([])

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-opus-4-8')
    ).rejects.toThrow(/No available Claude accounts/)
    expect(poolSpy).toHaveBeenCalled()

    poolSpy.mockRestore()
    fallbackSpy.mockRestore()
  })

  it('does not create a shared-pool mapping when the selected Console account disables sticky', async () => {
    const poolSpy = jest.spyOn(scheduler, '_getAllAvailableAccounts').mockResolvedValue([
      {
        id: 'console-1',
        accountId: 'console-1',
        accountType: 'claude-console',
        name: 'Console 1',
        priority: 50,
        stickySessionMode: 'off'
      }
    ])

    await expect(
      scheduler.selectAccountForApiKey(
        { id: 'shared-key', name: 'shared-key' },
        'session-hash',
        'claude-sonnet-4-6'
      )
    ).resolves.toEqual({ accountId: 'console-1', accountType: 'claude-console' })
    expect(mockRedisClient.setex).not.toHaveBeenCalled()

    poolSpy.mockRestore()
  })

  it('creates a shared-pool mapping when the selected Console account uses fallback sticky', async () => {
    const poolSpy = jest.spyOn(scheduler, '_getAllAvailableAccounts').mockResolvedValue([
      {
        id: 'console-1',
        accountId: 'console-1',
        accountType: 'claude-console',
        name: 'Console 1',
        priority: 50,
        stickySessionMode: 'fallback'
      }
    ])

    await scheduler.selectAccountForApiKey(
      { id: 'shared-key', name: 'shared-key' },
      'session-hash',
      'claude-sonnet-4-6'
    )

    expect(mockRedisClient.setex).toHaveBeenCalledWith(
      'unified_claude_session_mapping:session-hash',
      expect.any(Number),
      expect.stringContaining('"policyVersion":1')
    )

    poolSpy.mockRestore()
  })

  it('stores the selected Console sticky group in the session mapping', async () => {
    stickySessionGroupService.getGroupForAccount.mockResolvedValue({
      id: 'kimi-group',
      name: 'Kimi'
    })
    const poolSpy = jest.spyOn(scheduler, '_getAllAvailableAccounts').mockResolvedValue([
      {
        id: 'kimi-1',
        accountId: 'kimi-1',
        accountType: 'claude-console',
        name: 'Kimi 1',
        priority: 50,
        stickySessionMode: 'off'
      }
    ])

    await scheduler.selectAccountForApiKey(
      { id: 'shared-key', name: 'shared-key' },
      'grouped-session',
      'claude-sonnet-4-6'
    )

    expect(mockRedisClient.setex).toHaveBeenCalledWith(
      'unified_claude_session_mapping:grouped-session',
      expect.any(Number),
      expect.stringContaining('"stickySessionGroupId":"kimi-group"')
    )
    expect(mockRedisClient.setex).toHaveBeenCalledWith(
      'unified_claude_session_group_mapping:grouped-session',
      expect.any(Number),
      'kimi-group'
    )

    poolSpy.mockRestore()
  })

  it('keeps a mapped sticky account when only its concurrency is full', async () => {
    mockRedisClient.get.mockImplementation(async (key) => {
      if (key === 'unified_claude_session_mapping:busy-session') {
        return JSON.stringify({
          accountId: 'console-busy',
          accountType: 'claude-console',
          mode: 'fallback',
          stickySessionMode: 'fallback'
        })
      }
      return null
    })
    const availabilitySpy = jest.spyOn(scheduler, '_isAccountAvailable').mockResolvedValue(true)

    await expect(
      scheduler.selectAccountForApiKey(
        { id: 'shared-key', name: 'shared-key' },
        'busy-session',
        'claude-sonnet-4-6'
      )
    ).resolves.toMatchObject({ accountId: 'console-busy', accountType: 'claude-console' })
    expect(availabilitySpy).toHaveBeenCalledWith(
      'console-busy',
      'claude-console',
      'claude-sonnet-4-6',
      { ignoreConcurrency: true }
    )

    availabilitySpy.mockRestore()
  })

  it('releases the group boundary when the whole sticky group is unavailable', async () => {
    mockRedisClient.get.mockImplementation(async (key) =>
      key === 'unified_claude_session_group_mapping:fallback-session' ? 'kimi-group' : null
    )
    stickySessionGroupService.getGroup.mockResolvedValue({ id: 'kimi-group', name: 'Kimi' })
    stickySessionGroupService.getGroupMembers.mockResolvedValue(['kimi-1'])
    stickySessionGroupService.filterAccountsByGroup.mockResolvedValue([])
    stickySessionGroupService.isAccountInGroup.mockResolvedValue(false)
    const poolSpy = jest.spyOn(scheduler, '_getAllAvailableAccounts').mockResolvedValue([
      {
        id: 'glm-1',
        accountId: 'glm-1',
        accountType: 'claude-console',
        name: 'GLM 1',
        priority: 50,
        stickySessionMode: 'fallback'
      }
    ])

    await expect(
      scheduler.selectAccountForApiKey(
        { id: 'shared-key', name: 'shared-key' },
        'fallback-session',
        'claude-sonnet-4-6'
      )
    ).resolves.toEqual({ accountId: 'glm-1', accountType: 'claude-console' })
    expect(mockRedisClient.del).toHaveBeenCalledWith(
      'unified_claude_session_group_mapping:fallback-session'
    )

    poolSpy.mockRestore()
  })
})
