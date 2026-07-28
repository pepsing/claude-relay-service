jest.useFakeTimers()

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/models/redis', () => ({}))

jest.mock('../src/services/quotaCycleIntegrationService', () => ({
  syncZhipuQuota: jest.fn().mockResolvedValue(undefined)
}))

const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const quotaCycleIntegrationService = require('../src/services/quotaCycleIntegrationService')

describe('Zhipu Coding Plan quota parser', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    quotaCycleIntegrationService.syncZhipuQuota.mockResolvedValue(undefined)
  })

  afterAll(() => {
    jest.useRealTimers()
  })

  it('maps current unit-based token windows and preserves reset times', () => {
    const quotaStatus = claudeConsoleAccountService.normalizeZhipuCodingQuotaData({
      data: {
        level: 'max',
        limits: [
          {
            type: 'TOKENS_LIMIT',
            unit: 3,
            number: 5,
            percentage: 29,
            nextResetTime: 1782298807960
          },
          {
            type: 'TOKENS_LIMIT',
            unit: 6,
            number: 1,
            percentage: 100,
            nextResetTime: 1782528570992
          },
          {
            type: 'TIME_LIMIT',
            unit: 5,
            number: 1,
            usage: 4000,
            currentValue: 241,
            remaining: 3759,
            percentage: 6,
            nextResetTime: 1783565370997
          }
        ]
      }
    })

    const fiveHour = quotaStatus.buckets.find((bucket) => bucket.windowType === 'five_hour')
    const weekly = quotaStatus.buckets.find((bucket) => bucket.windowType === 'weekly')

    expect(fiveHour).toEqual(
      expect.objectContaining({
        label: '5小时额度',
        percentage: 29,
        resetAt: '2026-06-24T11:00:07.960Z',
        rawUnit: 3,
        number: 5
      })
    )
    expect(weekly).toEqual(
      expect.objectContaining({
        label: '每周额度',
        percentage: 100,
        resetAt: '2026-06-27T02:49:30.992Z',
        rawUnit: 6,
        number: 1
      })
    )
    expect(quotaStatus.exhausted).toBe(true)
    expect(quotaStatus.nextResetAt).toBe('2026-06-27T02:49:30.992Z')
  })

  it('keeps old token-only plans compatible by inferring 5h then weekly order', () => {
    const quotaStatus = claudeConsoleAccountService.normalizeZhipuCodingQuotaData({
      data: {
        level: 'pro',
        limits: [
          {
            type: 'TOKENS_LIMIT',
            percentage: 18,
            nextResetTime: 1782298807960
          },
          {
            type: 'TOKENS_LIMIT',
            percentage: 0,
            nextResetTime: 1782528570992
          }
        ]
      }
    })

    const tokenBuckets = quotaStatus.buckets.filter((bucket) => bucket.type === 'TOKENS_LIMIT')

    expect(tokenBuckets).toHaveLength(2)
    expect(tokenBuckets[0]).toEqual(
      expect.objectContaining({
        windowType: 'five_hour',
        label: '5小时额度',
        percentage: 18,
        resetAt: '2026-06-24T11:00:07.960Z'
      })
    )
    expect(tokenBuckets[1]).toEqual(
      expect.objectContaining({
        windowType: 'weekly',
        label: '每周额度',
        percentage: 0,
        resetAt: '2026-06-27T02:49:30.992Z'
      })
    )
  })

  it('keeps Claude Console stopped until its persisted exhausted snapshot is synchronized', async () => {
    const persistedQuotaStatus = {
      exhausted: true,
      buckets: [
        {
          type: 'TOKENS_LIMIT',
          windowType: 'weekly',
          percentage: 100,
          remaining: 0,
          resetAt: '2026-08-03T00:00:00.000Z'
        }
      ]
    }
    const healthyQuotaStatus = {
      exhausted: false,
      buckets: [
        {
          type: 'TOKENS_LIMIT',
          windowType: 'weekly',
          percentage: 20,
          remaining: 80,
          resetAt: '2026-08-10T00:00:00.000Z'
        }
      ],
      quota: { buckets: [] }
    }
    const account = {
      id: 'zhipu-console-outbox',
      name: 'Zhipu Console Outbox',
      apiUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'test-key',
      zhipuCodingQuotaAutoStopped: true,
      zhipuCodingQuotaStoppedAt: '2026-07-27T00:00:00.000Z',
      zhipuCodingQuotaStatusObservedAt: '2026-07-28T00:00:00.000Z',
      zhipuCodingQuotaStatus: persistedQuotaStatus
    }
    jest.spyOn(claudeConsoleAccountService, 'getAccount').mockResolvedValue(account)
    jest.spyOn(claudeConsoleAccountService, '_cacheZhipuCodingQuota').mockResolvedValue(undefined)
    const fetchQuota = jest
      .spyOn(claudeConsoleAccountService, 'fetchZhipuCodingQuota')
      .mockResolvedValue(healthyQuotaStatus)
    const recover = jest
      .spyOn(claudeConsoleAccountService, 'recoverZhipuCodingQuotaExceeded')
      .mockResolvedValue({ success: true })
    quotaCycleIntegrationService.syncZhipuQuota
      .mockRejectedValueOnce(new Error('PostgreSQL unavailable'))
      .mockResolvedValue(undefined)

    await expect(
      claudeConsoleAccountService.refreshZhipuCodingQuotaProtection(account.id)
    ).rejects.toThrow('PostgreSQL unavailable')
    expect(fetchQuota).not.toHaveBeenCalled()
    expect(recover).not.toHaveBeenCalled()

    await expect(
      claudeConsoleAccountService.refreshZhipuCodingQuotaProtection(account.id)
    ).resolves.toEqual(
      expect.objectContaining({ checked: true, exhausted: false, recovered: true })
    )
    expect(quotaCycleIntegrationService.syncZhipuQuota).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accountType: 'claude-console',
        account,
        quotaStatus: persistedQuotaStatus,
        observedAt: account.zhipuCodingQuotaStatusObservedAt
      })
    )
    expect(recover).toHaveBeenCalledWith(account.id, healthyQuotaStatus)
  })
})
