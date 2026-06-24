jest.useFakeTimers()

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/models/redis', () => ({}))

const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')

describe('Zhipu Coding Plan quota parser', () => {
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
})
