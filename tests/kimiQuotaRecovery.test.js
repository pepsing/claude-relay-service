jest.useFakeTimers()

const mockRedisClient = {
  hset: jest.fn().mockResolvedValue(undefined),
  hdel: jest.fn().mockResolvedValue(undefined)
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
    redis.setAccountLock.mockResolvedValue(true)
    redis.releaseAccountLock.mockResolvedValue(true)
    upstreamErrorHelper.clearTempUnavailable.mockResolvedValue(undefined)
    rateLimitCleanupService.clearedAccounts = []
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
})
