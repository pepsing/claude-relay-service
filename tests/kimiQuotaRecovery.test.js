jest.useFakeTimers()

const mockRedisClient = {
  hset: jest.fn().mockResolvedValue(undefined),
  hdel: jest.fn().mockResolvedValue(undefined),
  eval: jest.fn().mockResolvedValue(2)
}

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(() => mockRedisClient),
  setAccountLock: jest.fn().mockResolvedValue(true),
  releaseAccountLock: jest.fn().mockResolvedValue(true),
  getConsoleAccountConcurrency: jest.fn().mockResolvedValue(0),
  getConcurrency: jest.fn().mockResolvedValue(0),
  getDateStringInTimezone: jest.fn(() => '2026-07-28')
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  clearTempUnavailable: jest.fn().mockResolvedValue(undefined),
  recordErrorHistory: jest.fn().mockResolvedValue(undefined)
}))

jest.mock('../src/services/quotaCycleIntegrationService', () => ({
  recordKimiExceeded: jest.fn().mockResolvedValue(undefined),
  recordKimiRecovered: jest.fn().mockResolvedValue(undefined),
  reconcilePersistedQuotaState: jest.fn().mockResolvedValue({
    kimiExceeded: false,
    kimiRecovered: false,
    volcengineExceeded: false
  })
}))

jest.mock('../src/services/quotaIdentityService', () => ({
  buildQuotaGroupId: jest.fn(() => 'qg-kimi-shared')
}))

jest.mock('../src/utils/webhookNotifier', () => ({
  sendAccountAnomalyNotification: jest.fn().mockResolvedValue(undefined)
}))

jest.mock('../src/utils/proxyHelper', () => {
  class MockProxyHelper {
    static createProxyAgent = jest.fn().mockReturnValue(null)

    static getProxyDescription = jest.fn().mockReturnValue('No proxy')
  }

  return MockProxyHelper
})

jest.mock('axios')

const axios = require('axios')
const redis = require('../src/models/redis')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const quotaCycleIntegrationService = require('../src/services/quotaCycleIntegrationService')
const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const rateLimitCleanupService = require('../src/services/rateLimitCleanupService')

describe('Kimi billing-cycle quota recovery', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    jest.setSystemTime(new Date('2026-07-28T02:00:00.000Z'))
    mockRedisClient.hset.mockResolvedValue(undefined)
    mockRedisClient.hdel.mockResolvedValue(undefined)
    mockRedisClient.eval.mockResolvedValue(2)
    redis.setAccountLock.mockResolvedValue(true)
    redis.releaseAccountLock.mockResolvedValue(true)
    upstreamErrorHelper.clearTempUnavailable.mockResolvedValue(undefined)
    quotaCycleIntegrationService.recordKimiExceeded.mockResolvedValue(undefined)
    quotaCycleIntegrationService.recordKimiRecovered.mockResolvedValue(undefined)
    quotaCycleIntegrationService.reconcilePersistedQuotaState.mockResolvedValue({
      kimiExceeded: false,
      kimiRecovered: false,
      volcengineExceeded: false
    })
    rateLimitCleanupService.clearedAccounts = []
    rateLimitCleanupService.quotaCycleCleanupBlocks.clear()
  })

  afterAll(() => {
    jest.useRealTimers()
  })

  it('waits one hour after the Kimi quota stop before probing', async () => {
    jest.spyOn(claudeConsoleAccountService, 'getAccount').mockResolvedValue({
      id: 'kimi-console-1',
      name: 'Kimi Console',
      apiUrl: 'https://api.kimi.com/coding',
      apiKey: 'kimi-key',
      supportedModels: { 'claude-sonnet-4-6': 'kimi-for-coding' },
      kimiBillingCycleQuotaStoppedAt: '2026-07-28T01:30:00.000Z'
    })

    const result =
      await claudeConsoleAccountService.checkAndRecoverKimiBillingCycleQuota('kimi-console-1')

    expect(result).toEqual(
      expect.objectContaining({
        checked: false,
        recovered: false,
        nextCheckAt: '2026-07-28T02:30:00.000Z'
      })
    )
    expect(redis.setAccountLock).not.toHaveBeenCalled()
    expect(axios).not.toHaveBeenCalled()
  })

  it('keeps a Claude Console Kimi account suspended when the hourly probe still returns 403', async () => {
    const account = {
      id: 'kimi-console-2',
      name: 'Kimi Console',
      apiUrl: 'https://api.kimi.com/coding/',
      apiKey: 'kimi-key',
      supportedModels: { 'claude-sonnet-4-6': 'kimi-for-coding' },
      kimiBillingCycleQuotaStoppedAt: '2026-07-28T00:00:00.000Z'
    }
    jest.spyOn(claudeConsoleAccountService, 'getAccount').mockResolvedValue(account)
    jest.spyOn(claudeConsoleAccountService, '_createProxyAgent').mockReturnValue(null)
    axios.mockResolvedValue({
      status: 403,
      data: {
        error: {
          message: 'Quota will be refreshed in the next billing cycle.'
        }
      }
    })

    const result =
      await claudeConsoleAccountService.checkAndRecoverKimiBillingCycleQuota('kimi-console-2')

    expect(result).toEqual({ checked: true, recovered: false, status: 403 })
    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.kimi.com/coding/v1/messages',
        data: expect.objectContaining({
          model: 'kimi-for-coding',
          max_tokens: 16,
          stream: false
        })
      })
    )
    expect(mockRedisClient.hset).toHaveBeenCalledWith(
      'claude_console_account:kimi-console-2',
      expect.objectContaining({
        kimiBillingCycleQuotaLastCheckedAt: '2026-07-28T02:00:00.000Z'
      })
    )
    expect(mockRedisClient.hdel).not.toHaveBeenCalled()
    expect(redis.releaseAccountLock).toHaveBeenCalled()
  })

  it('restores an OpenAI-compatible Kimi account after a successful hourly probe', async () => {
    const account = {
      id: 'kimi-openai-1',
      name: 'Kimi OpenAI',
      baseApi: 'https://api.kimi.com/coding',
      apiKey: 'kimi-key',
      supportedModels: { 'kimi-k2.7': 'kimi-k2.7' },
      kimiBillingCycleQuotaStoppedAt: '2026-07-28T00:00:00.000Z'
    }
    jest.spyOn(openaiResponsesAccountService, 'getAccount').mockResolvedValue(account)
    axios.mockResolvedValue({ status: 200, data: { choices: [{ message: { content: 'hi' } }] } })

    const result =
      await openaiResponsesAccountService.checkAndRecoverKimiBillingCycleQuota('kimi-openai-1')

    expect(result).toEqual({ checked: true, recovered: true, status: 200 })
    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.kimi.com/coding/v1/chat/completions',
        headers: expect.objectContaining({
          Authorization: 'Bearer kimi-key'
        }),
        data: expect.objectContaining({
          model: 'kimi-k2.7',
          max_tokens: 16,
          stream: false
        })
      })
    )
    expect(mockRedisClient.hset).toHaveBeenCalledWith(
      'openai_responses_account:kimi-openai-1',
      expect.objectContaining({
        status: 'active',
        schedulable: 'true',
        errorMessage: ''
      })
    )
    expect(mockRedisClient.hdel).toHaveBeenCalledWith(
      'openai_responses_account:kimi-openai-1',
      'kimiBillingCycleQuotaStoppedAt',
      'kimiBillingCycleQuotaLastCheckedAt'
    )
    expect(upstreamErrorHelper.clearTempUnavailable).toHaveBeenCalledWith(
      'kimi-openai-1',
      'openai-responses'
    )
  })

  it('does not recover when Kimi embeds a quota error in a successful response', async () => {
    const account = {
      id: 'kimi-openai-embedded-error',
      name: 'Kimi OpenAI',
      baseApi: 'https://api.kimi.com/coding',
      apiKey: 'kimi-key',
      supportedModels: { 'kimi-k2.7': 'kimi-k2.7' },
      kimiBillingCycleQuotaStoppedAt: '2026-07-28T00:00:00.000Z'
    }
    jest.spyOn(openaiResponsesAccountService, 'getAccount').mockResolvedValue(account)
    axios.mockResolvedValue({
      status: 200,
      data: {
        error: {
          type: 'usage_limit_reached',
          message: 'Billing cycle quota exhausted'
        }
      }
    })

    const result = await openaiResponsesAccountService.checkAndRecoverKimiBillingCycleQuota(
      'kimi-openai-embedded-error'
    )

    expect(result).toEqual({ checked: true, recovered: false, status: 200 })
    expect(mockRedisClient.hdel).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.clearTempUnavailable).not.toHaveBeenCalled()
  })

  it('closes open Kimi cycles when accounts are manually reset', async () => {
    const consoleAccount = {
      id: 'kimi-console-manual',
      name: 'Kimi Console Manual',
      apiUrl: 'https://api.kimi.com/coding',
      apiKey: 'kimi-key',
      kimiBillingCycleQuotaStoppedAt: '2026-07-28T00:00:00.000Z'
    }
    const responsesAccount = {
      id: 'kimi-responses-manual',
      name: 'Kimi Responses Manual',
      baseApi: 'https://api.kimi.com/coding',
      apiKey: 'kimi-key',
      kimiBillingCycleQuotaStoppedAt: '2026-07-28T00:00:00.000Z'
    }
    jest.spyOn(claudeConsoleAccountService, 'getAccount').mockResolvedValue(consoleAccount)
    jest.spyOn(openaiResponsesAccountService, 'getAccount').mockResolvedValue(responsesAccount)
    jest.spyOn(openaiResponsesAccountService, 'updateAccount').mockResolvedValue({ success: true })
    axios.mockResolvedValue({ status: 200, data: { choices: [{ message: { content: 'hi' } }] } })

    await claudeConsoleAccountService.resetAccountStatus(consoleAccount.id)
    await openaiResponsesAccountService.resetAccountStatus(responsesAccount.id)

    expect(quotaCycleIntegrationService.recordKimiRecovered).toHaveBeenCalledTimes(2)
    expect(quotaCycleIntegrationService.recordKimiRecovered).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountType: 'claude-console',
        account: consoleAccount,
        recoveredAt: '2026-07-28T02:00:00.000Z'
      })
    )
    expect(quotaCycleIntegrationService.recordKimiRecovered).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accountType: 'openai-responses',
        account: responsesAccount,
        recoveredAt: '2026-07-28T02:00:00.000Z'
      })
    )
  })

  it('collects recovered Kimi accounts from both supported account types', async () => {
    jest.spyOn(claudeConsoleAccountService, 'getAllAccounts').mockResolvedValue([
      {
        id: 'kimi-console-3',
        name: 'Kimi Console',
        kimiBillingCycleQuotaStoppedAt: '2026-07-28T00:00:00.000Z'
      }
    ])
    jest.spyOn(openaiResponsesAccountService, 'getAllAccounts').mockResolvedValue([
      {
        id: 'kimi-openai-2',
        name: 'Kimi OpenAI',
        kimiBillingCycleQuotaStoppedAt: '2026-07-28T00:00:00.000Z'
      }
    ])
    jest
      .spyOn(claudeConsoleAccountService, 'checkAndRecoverKimiBillingCycleQuota')
      .mockResolvedValue({ checked: true, recovered: false, status: 403 })
    jest
      .spyOn(openaiResponsesAccountService, 'checkAndRecoverKimiBillingCycleQuota')
      .mockResolvedValue({ checked: true, recovered: true, status: 200 })

    const result = { checked: 0, recovered: 0, errors: [] }
    await rateLimitCleanupService.cleanupKimiBillingCycleQuota(result)

    expect(result).toEqual({ checked: 2, recovered: 1, errors: [] })
    expect(openaiResponsesAccountService.getAllAccounts).toHaveBeenCalledWith(true)
    expect(rateLimitCleanupService.clearedAccounts).toEqual([
      expect.objectContaining({
        platform: 'OpenAI Responses',
        accountId: 'kimi-openai-2',
        previousStatus: 'kimi_billing_cycle_quota_exceeded',
        currentStatus: 'active'
      })
    ])
  })

  it('retries persisted quota events before cleanup clears account state', async () => {
    const consoleSummary = {
      id: 'kimi-console-outbox',
      name: 'Kimi Console Outbox',
      kimiQuotaCycleRecoveryPendingAt: '2026-07-28T01:00:00.000Z'
    }
    const responsesSummary = {
      id: 'kimi-responses-outbox',
      name: 'Kimi Responses Outbox',
      kimiQuotaCycleRecoveryPendingAt: '2026-07-28T01:00:00.000Z'
    }
    jest.spyOn(claudeConsoleAccountService, 'getAllAccounts').mockResolvedValue([consoleSummary])
    jest
      .spyOn(openaiResponsesAccountService, 'getAllAccounts')
      .mockResolvedValue([responsesSummary])
    jest.spyOn(claudeConsoleAccountService, 'getAccount').mockResolvedValue(consoleSummary)
    jest.spyOn(openaiResponsesAccountService, 'getAccount').mockResolvedValue(responsesSummary)
    jest
      .spyOn(claudeConsoleAccountService, 'clearKimiQuotaCycleRecoveryPending')
      .mockResolvedValue(2)
    jest
      .spyOn(openaiResponsesAccountService, 'clearKimiQuotaCycleRecoveryPending')
      .mockResolvedValue(2)
    quotaCycleIntegrationService.reconcilePersistedQuotaState
      .mockResolvedValueOnce({
        kimiExceeded: false,
        kimiRecovered: true,
        volcengineExceeded: false
      })
      .mockResolvedValueOnce({
        kimiExceeded: false,
        kimiRecovered: true,
        volcengineExceeded: false
      })
    const result = { checked: 0, synced: 0, errors: [] }

    await rateLimitCleanupService.reconcilePersistedQuotaCycles(result)

    expect(result).toEqual({ checked: 2, synced: 2, errors: [] })
    expect(claudeConsoleAccountService.clearKimiQuotaCycleRecoveryPending).toHaveBeenCalledWith(
      consoleSummary.id,
      consoleSummary.kimiQuotaCycleRecoveryPendingAt,
      undefined
    )
    expect(openaiResponsesAccountService.clearKimiQuotaCycleRecoveryPending).toHaveBeenCalledWith(
      responsesSummary.id,
      responsesSummary.kimiQuotaCycleRecoveryPendingAt,
      undefined
    )
  })

  it('atomically deletes only the expected persisted recovery markers', async () => {
    await claudeConsoleAccountService.clearKimiQuotaCycleRecoveryPending(
      'kimi-console-pending',
      '2026-07-28T01:00:00.000Z',
      '2026-07-28T00:00:00.000Z'
    )
    await openaiResponsesAccountService.clearKimiQuotaCycleRecoveryPending(
      'kimi-responses-pending',
      '2026-07-28T02:00:00.000Z',
      '2026-07-28T01:00:00.000Z'
    )

    expect(mockRedisClient.eval).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('if pending_at ~= ARGV[1]'),
      1,
      'claude_console_account:kimi-console-pending',
      '2026-07-28T01:00:00.000Z',
      '2026-07-28T00:00:00.000Z'
    )
    expect(mockRedisClient.eval).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('if pending_at ~= ARGV[1]'),
      1,
      'openai_responses_account:kimi-responses-pending',
      '2026-07-28T02:00:00.000Z',
      '2026-07-28T01:00:00.000Z'
    )
  })

  it('keeps Kimi recovery monitoring after a manual reset when the upstream probe still fails', async () => {
    const consoleAccount = {
      id: 'kimi-console-manual-still-limited',
      name: 'Kimi Console Manual Still Limited',
      apiUrl: 'https://api.kimi.com/coding',
      apiKey: 'kimi-key',
      kimiBillingCycleQuotaStoppedAt: '2026-07-28T00:00:00.000Z'
    }
    const responsesAccount = {
      id: 'kimi-responses-manual-still-limited',
      name: 'Kimi Responses Manual Still Limited',
      baseApi: 'https://api.kimi.com/coding',
      apiKey: 'kimi-key',
      kimiBillingCycleQuotaStoppedAt: '2026-07-28T00:00:00.000Z'
    }
    jest.spyOn(claudeConsoleAccountService, 'getAccount').mockResolvedValue(consoleAccount)
    jest.spyOn(openaiResponsesAccountService, 'getAccount').mockResolvedValue(responsesAccount)
    jest
      .spyOn(claudeConsoleAccountService, 'checkAndRecoverKimiBillingCycleQuota')
      .mockResolvedValue({ checked: true, recovered: false, status: 403 })
    jest
      .spyOn(openaiResponsesAccountService, 'checkAndRecoverKimiBillingCycleQuota')
      .mockResolvedValue({ checked: true, recovered: false, status: 403 })
    const responsesUpdate = jest
      .spyOn(openaiResponsesAccountService, 'updateAccount')
      .mockResolvedValue({ success: true })

    await claudeConsoleAccountService.resetAccountStatus(consoleAccount.id)
    await openaiResponsesAccountService.resetAccountStatus(responsesAccount.id)

    const consoleResetDelete = mockRedisClient.hdel.mock.calls.find(
      ([key]) => key === `claude_console_account:${consoleAccount.id}`
    )
    expect(consoleResetDelete).toBeDefined()
    expect(consoleResetDelete).not.toContain('kimiBillingCycleQuotaStoppedAt')
    expect(responsesUpdate).toHaveBeenCalledWith(
      responsesAccount.id,
      expect.not.objectContaining({ kimiBillingCycleQuotaStoppedAt: '' })
    )
    expect(quotaCycleIntegrationService.recordKimiRecovered).not.toHaveBeenCalled()
  })

  it('does not clear Volcengine reset evidence until cycle reconciliation succeeds', async () => {
    const account = {
      id: 'volcengine-outbox',
      name: 'Volcengine Outbox',
      baseApi: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      apiKey: 'test-key',
      rateLimitAutoStopped: 'true',
      rateLimitResetAt: '2026-07-28T01:00:00.000Z',
      rateLimitStatus: { isRateLimited: true }
    }
    jest.spyOn(openaiResponsesAccountService, 'getAllAccounts').mockResolvedValue([account])
    jest.spyOn(openaiResponsesAccountService, 'getAccount').mockResolvedValue(account)
    const clearRateLimit = jest
      .spyOn(openaiResponsesAccountService, 'checkAndClearRateLimit')
      .mockResolvedValue(true)
    quotaCycleIntegrationService.reconcilePersistedQuotaState
      .mockRejectedValueOnce(new Error('PostgreSQL unavailable'))
      .mockResolvedValueOnce({
        kimiExceeded: false,
        kimiRecovered: false,
        volcengineExceeded: true
      })
    const reconciliation = { checked: 0, synced: 0, errors: [] }

    await rateLimitCleanupService.reconcilePersistedQuotaCycles(reconciliation)
    await rateLimitCleanupService.cleanupOpenAIResponsesAccounts({
      checked: 0,
      cleared: 0,
      errors: []
    })
    expect(clearRateLimit).not.toHaveBeenCalled()
    expect(rateLimitCleanupService.quotaCycleCleanupBlocks).toContain(
      `openai-responses:${account.id}`
    )

    await rateLimitCleanupService.reconcilePersistedQuotaCycles(reconciliation)
    await rateLimitCleanupService.cleanupOpenAIResponsesAccounts({
      checked: 0,
      cleared: 0,
      errors: []
    })
    expect(clearRateLimit).toHaveBeenCalledWith(account.id)
    expect(rateLimitCleanupService.quotaCycleCleanupBlocks).not.toContain(
      `openai-responses:${account.id}`
    )
  })

  it('blocks a whole provider when quota reconciliation cannot discover its accounts', async () => {
    const account = {
      id: 'volcengine-discovery-race',
      name: 'Volcengine Discovery Race',
      rateLimitAutoStopped: 'true',
      rateLimitResetAt: '2026-07-28T01:00:00.000Z',
      rateLimitStatus: { isRateLimited: true }
    }
    jest
      .spyOn(openaiResponsesAccountService, 'getAllAccounts')
      .mockRejectedValueOnce(new Error('Redis index unavailable'))
      .mockResolvedValueOnce([account])
    jest.spyOn(claudeConsoleAccountService, 'getAllAccounts').mockResolvedValue([])
    const clearRateLimit = jest
      .spyOn(openaiResponsesAccountService, 'checkAndClearRateLimit')
      .mockResolvedValue(true)

    await rateLimitCleanupService.reconcilePersistedQuotaCycles({
      checked: 0,
      synced: 0,
      errors: []
    })
    await rateLimitCleanupService.cleanupOpenAIResponsesAccounts({
      checked: 0,
      cleared: 0,
      errors: []
    })

    expect(rateLimitCleanupService.quotaCycleCleanupBlocks).toContain('openai-responses:*')
    expect(clearRateLimit).not.toHaveBeenCalled()
  })
})
