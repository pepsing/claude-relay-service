jest.useFakeTimers()

jest.mock('../src/models/redis', () => ({
  setAccountBalance: jest.fn().mockResolvedValue(undefined),
  getDateStringInTimezone: jest.fn(() => '2026-07-21')
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  recordErrorHistory: jest.fn().mockResolvedValue(undefined),
  clearTempUnavailable: jest.fn().mockResolvedValue(undefined)
}))

jest.mock('../src/utils/webhookNotifier', () => ({
  sendAccountAnomalyNotification: jest.fn().mockResolvedValue(undefined)
}))

const axios = require('axios')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')

jest.mock('axios')

describe('OpenAI Responses provider subscription quota protection', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('suspends Kimi Chat Completions accounts on billing-cycle 403 even when auto protection is disabled', async () => {
    const account = {
      id: 'kimi-chat-1',
      name: 'kimi-chat',
      baseApi: 'https://api.kimi.com/coding',
      apiKey: 'test-key',
      disableAutoProtection: 'true'
    }
    jest.spyOn(openaiResponsesAccountService, 'getAccount').mockResolvedValue(account)
    jest.spyOn(openaiResponsesAccountService, 'updateAccount').mockResolvedValue({ success: true })

    const result = await openaiResponsesAccountService.handleProviderQuotaError(account.id, {
      account,
      status: 403,
      errorData: {
        error: {
          type: 'access_terminated_error',
          message:
            "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle."
        }
      }
    })

    expect(result).toEqual(
      expect.objectContaining({ handled: true, provider: 'kimi', quotaType: 'billing_cycle' })
    )
    expect(openaiResponsesAccountService.updateAccount).toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({
        status: 'quota_exceeded',
        schedulable: 'false',
        kimiBillingCycleQuotaStoppedAt: expect.any(String)
      })
    )
  })

  it('suspends Volcengine Chat Completions accounts until the monthly reset time', async () => {
    const account = {
      id: 'ark-chat-1',
      name: 'ark-chat',
      baseApi: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      apiKey: 'test-key',
      disableAutoProtection: 'true'
    }
    jest.spyOn(openaiResponsesAccountService, 'getAccount').mockResolvedValue(account)
    jest.spyOn(openaiResponsesAccountService, 'updateAccount').mockResolvedValue({ success: true })

    const result = await openaiResponsesAccountService.handleProviderQuotaError(account.id, {
      account,
      status: 429,
      errorData:
        'You have exceeded the monthly usage quota. It will reset at 2026-07-31 23:59:59 +0800 CST.'
    })

    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        provider: 'volcengine',
        quotaType: 'monthly',
        resetAt: '2026-07-31T15:59:59.000Z'
      })
    )
    expect(openaiResponsesAccountService.updateAccount).toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({
        status: 'rate_limited',
        schedulable: 'false',
        rateLimitResetAt: '2026-07-31T15:59:59.000Z',
        rateLimitAutoStopped: 'true'
      })
    )
  })

  it('queries the Zhipu Coding Plan quota API and suspends an exhausted account', async () => {
    const account = {
      id: 'zhipu-chat-1',
      name: 'zhipu-chat',
      baseApi: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKey: 'test-key',
      proxy: null
    }
    jest.spyOn(openaiResponsesAccountService, 'getAccount').mockResolvedValue(account)
    jest.spyOn(openaiResponsesAccountService, 'updateAccount').mockResolvedValue({ success: true })
    axios.mockResolvedValue({
      status: 200,
      data: {
        data: {
          level: 'pro',
          limits: [
            {
              type: 'TOKENS_LIMIT',
              percentage: 100,
              unit: 3,
              number: 5,
              nextResetTime: '2026-07-21T10:00:00.000Z'
            }
          ]
        }
      }
    })

    const result = await openaiResponsesAccountService.handleProviderQuotaError(account.id, {
      account,
      status: 429,
      errorData: { error: { message: 'quota exceeded' } }
    })

    expect(result).toEqual(
      expect.objectContaining({ handled: true, provider: 'zhipu', quotaType: 'coding_plan' })
    )
    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
      })
    )
    expect(openaiResponsesAccountService.updateAccount).toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({ status: 'quota_exceeded', schedulable: 'false' })
    )
  })

  it('automatically restores a Volcengine account after its reset time', async () => {
    const account = {
      id: 'ark-chat-2',
      name: 'ark-chat',
      apiKey: 'test-key',
      rateLimitStatus: 'limited',
      rateLimitResetAt: '2020-01-01T00:00:00.000Z',
      rateLimitAutoStopped: 'true',
      schedulable: 'false'
    }
    jest.spyOn(openaiResponsesAccountService, 'getAccount').mockResolvedValue(account)
    jest.spyOn(openaiResponsesAccountService, 'updateAccount').mockResolvedValue({ success: true })

    await expect(openaiResponsesAccountService.checkAndClearRateLimit(account.id)).resolves.toBe(
      true
    )
    expect(openaiResponsesAccountService.updateAccount).toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({
        status: 'active',
        schedulable: 'true',
        rateLimitAutoStopped: ''
      })
    )
  })
})
