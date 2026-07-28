const loadService = ({ writeMode = 'redis', readMode = 'redis', dimensionalRead = false } = {}) => {
  jest.resetModules()
  process.env.USAGE_WRITE_MODE = writeMode
  process.env.USAGE_READ_MODE = readMode
  process.env.USAGE_DIMENSIONAL_READ_ENABLED = dimensionalRead ? 'true' : 'false'

  const redisMock = {
    getApiKey: jest
      .fn()
      .mockResolvedValue({ id: 'key_1', name: 'dev key', createdAt: '2026-05-01T00:00:00.000Z' }),
    getUsageStats: jest.fn().mockResolvedValue({ total: { requests: 1 } }),
    getUsageRecords: jest.fn().mockResolvedValue([]),
    getDailyCost: jest.fn().mockResolvedValue(1.2),
    getCostStats: jest.fn().mockResolvedValue({ total: 2.3 }),
    getAllUsedModels: jest.fn().mockResolvedValue(['glm-5.1']),
    getKeyIdsWithModels: jest.fn().mockResolvedValue(new Set(['key_1']))
  }
  const pgStoreMock = {
    upsertUsageEvent: jest.fn().mockResolvedValue({ inserted: 1, skipped: 0 }),
    getUsageStats: jest.fn().mockResolvedValue({ total: { requests: 2 } }),
    getUsageRecords: jest
      .fn()
      .mockResolvedValue([{ requestId: 'req_1', costBreakdown: { total: 1 } }]),
    getDailyCost: jest.fn().mockResolvedValue(3.4),
    getCostStats: jest.fn().mockResolvedValue({ total: 4.5 }),
    getKeyUsageSummary: jest.fn().mockResolvedValue({ requests: 3, cost: 1.23 }),
    getModelStatsForKey: jest.fn().mockResolvedValue([]),
    getBatchModelStats: jest.fn().mockResolvedValue([]),
    getAllUsedModels: jest.fn().mockResolvedValue(['glm-5.1']),
    getKeyIdsWithModels: jest.fn().mockResolvedValue(new Set(['key_1'])),
    getBatchKeyCosts: jest.fn().mockResolvedValue(new Map([['key_1', 1.23]])),
    calculateCustomRangeCosts: jest.fn().mockResolvedValue(new Map([['key_1', 1.23]])),
    getUsageTrend: jest.fn().mockResolvedValue([]),
    getAccountUsageHistory: jest.fn().mockResolvedValue({ history: [] }),
    getAccountUsageSummary: jest.fn().mockResolvedValue({ totalRequests: 0 })
  }
  const loggerMock = {
    warn: jest.fn()
  }
  const dimensionalStoreMock = {
    getUsageTrend: jest.fn().mockResolvedValue([{ date: '2026-07-28', requests: 2 }]),
    getApiKeysUsageTrend: jest.fn(),
    getModelUsageTrend: jest.fn(),
    getAccountUsageTrend: jest.fn(),
    getAccountUsageHistory: jest.fn().mockResolvedValue({
      history: [{ date: '2026-07-28', requests: 2 }]
    }),
    getAccountUsageSummary: jest.fn().mockResolvedValue({
      totalRequests: 20,
      monthlyRequests: 10,
      dailyRequests: 2
    }),
    buildTrendPeriods: jest.fn().mockResolvedValue({
      granularity: 'day',
      periods: [{ date: '2026-07-28' }],
      start: new Date('2026-07-27T16:00:00.000Z'),
      endExclusive: new Date('2026-07-28T16:00:00.000Z')
    }),
    queryDimensionalUsage: jest.fn().mockResolvedValue([
      {
        bucketStart: '2026-07-27T16:00:00.000Z',
        accountId: 'acct-1',
        apiKeyId: 'key-1',
        model: 'gpt-5'
      }
    ])
  }
  const dimensionalServiceMock = {
    getSettings: jest.fn().mockReturnValue({
      readEnabled: dimensionalRead,
      businessTimezone: 'Asia/Shanghai',
      minuteRetentionHours: 48,
      hourlyRetentionDays: 30
    }),
    getHealth: jest.fn().mockResolvedValue({ started: true })
  }

  jest.doMock('../src/models/redis', () => redisMock)
  jest.doMock('../src/services/usageStores/postgresUsageStore', () => pgStoreMock)
  jest.doMock(
    '../src/services/usageStores/postgresDimensionalUsageStore',
    () => dimensionalStoreMock
  )
  jest.doMock('../src/services/usageDimensionalRollupService', () => dimensionalServiceMock)
  jest.doMock('../src/utils/logger', () => loggerMock)

  return {
    service: require('../src/services/usageStatsService'),
    redisMock,
    pgStoreMock,
    dimensionalStoreMock,
    dimensionalServiceMock,
    loggerMock
  }
}

describe('usageStatsService', () => {
  const originalWriteMode = process.env.USAGE_WRITE_MODE
  const originalReadMode = process.env.USAGE_READ_MODE
  const originalDimensionalRead = process.env.USAGE_DIMENSIONAL_READ_ENABLED

  afterEach(() => {
    jest.dontMock('../src/models/redis')
    jest.dontMock('../src/services/usageStores/postgresUsageStore')
    jest.dontMock('../src/services/usageStores/postgresDimensionalUsageStore')
    jest.dontMock('../src/services/usageDimensionalRollupService')
    jest.dontMock('../src/utils/logger')
    process.env.USAGE_WRITE_MODE = originalWriteMode
    process.env.USAGE_READ_MODE = originalReadMode
    process.env.USAGE_DIMENSIONAL_READ_ENABLED = originalDimensionalRead
  })

  test('redis mode delegates reads to Redis', async () => {
    const { service, redisMock, pgStoreMock } = loadService()

    await expect(service.getDailyCost('key_1')).resolves.toBe(1.2)
    await expect(service.getCostStats('key_1')).resolves.toEqual({ total: 2.3 })

    expect(redisMock.getDailyCost).toHaveBeenCalledWith('key_1')
    expect(redisMock.getCostStats).toHaveBeenCalledWith('key_1')
    expect(pgStoreMock.getDailyCost).not.toHaveBeenCalled()
  })

  test('postgres read mode delegates key usage summaries to PostgreSQL store', async () => {
    const { service, redisMock, pgStoreMock } = loadService({ readMode: 'postgres' })

    const summary = await service.getKeyUsageSummary('key_1', 'custom', '2026-06-01', '2026-06-03')

    expect(summary).toEqual({ requests: 3, cost: 1.23 })
    expect(pgStoreMock.getKeyUsageSummary).toHaveBeenCalledWith(
      'key_1',
      'custom',
      '2026-06-01',
      '2026-06-03'
    )
    expect(redisMock.getUsageStats).not.toHaveBeenCalled()
  })

  test('postgres read mode delegates usage stats and records to PostgreSQL store', async () => {
    const { service, redisMock, pgStoreMock } = loadService({ readMode: 'postgres' })

    const stats = await service.getUsageStatsWithRecords('key_1', { recordLimit: 5 })

    expect(redisMock.getApiKey).toHaveBeenCalledWith('key_1')
    expect(pgStoreMock.getUsageStats).toHaveBeenCalledWith('key_1', {
      createdAt: '2026-05-01T00:00:00.000Z'
    })
    expect(pgStoreMock.getUsageRecords).toHaveBeenCalledWith('key_1', 5)
    expect(stats.total.requests).toBe(2)
    expect(stats.recentRecords[0].realCostBreakdown).toEqual({ total: 1 })
  })

  test('dual write logs PostgreSQL failures without throwing', async () => {
    const { service, pgStoreMock, loggerMock } = loadService({ writeMode: 'dual' })
    pgStoreMock.upsertUsageEvent.mockRejectedValueOnce(new Error('pg down'))

    const result = await service.recordUsageEvent(
      'key_1',
      { requestId: 'req_1' },
      { name: 'dev key' }
    )

    expect(result).toEqual({ inserted: 0, skipped: 0, error: 'pg down' })
    expect(loggerMock.warn).toHaveBeenCalled()
  })

  test('postgres write mode propagates PostgreSQL failures', async () => {
    const { service, pgStoreMock } = loadService({ writeMode: 'postgres' })
    pgStoreMock.upsertUsageEvent.mockRejectedValueOnce(new Error('pg down'))

    await expect(
      service.recordUsageEvent('key_1', { requestId: 'req_1' }, { name: 'dev key' })
    ).rejects.toThrow('pg down')
  })

  test('can cut trend reads over to dimensional rollups without changing the response shape', async () => {
    const { service, pgStoreMock, dimensionalStoreMock } = loadService({
      readMode: 'postgres',
      dimensionalRead: true
    })

    const result = await service.getUsageTrend({ days: 7, granularity: 'day' })

    expect(result).toEqual([{ date: '2026-07-28', requests: 2 }])
    expect(dimensionalStoreMock.getUsageTrend).toHaveBeenCalledWith(
      expect.objectContaining({
        days: 7,
        granularity: 'day',
        businessTimezone: 'Asia/Shanghai'
      })
    )
    expect(pgStoreMock.getUsageTrend).not.toHaveBeenCalled()
  })

  test('exposes the full account/model/API-key dimensional query range', async () => {
    const { service, dimensionalStoreMock } = loadService({ readMode: 'postgres' })

    const result = await service.getDimensionalUsage({
      granularity: 'day',
      startDate: '2026-07-28',
      endDate: '2026-07-28',
      groupBy: ['account', 'apiKey', 'model']
    })

    expect(result).toEqual(
      expect.objectContaining({
        granularity: 'day',
        startDate: '2026-07-27T16:00:00.000Z',
        endDate: '2026-07-28T16:00:00.000Z',
        rows: [expect.objectContaining({ accountId: 'acct-1', model: 'gpt-5' })]
      })
    )
    expect(dimensionalStoreMock.queryDimensionalUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        granularity: 'day',
        startDate: new Date('2026-07-27T16:00:00.000Z'),
        endDate: new Date('2026-07-28T16:00:00.000Z')
      })
    )
  })

  test('keeps account history and summaries on rollups after raw-event cleanup', async () => {
    const { service, pgStoreMock, dimensionalStoreMock } = loadService({
      readMode: 'postgres',
      dimensionalRead: true
    })

    await expect(
      service.getAccountUsageHistory({ accountId: 'acct-1', days: 30 })
    ).resolves.toEqual({
      history: [{ date: '2026-07-28', requests: 2 }]
    })
    await expect(service.getAccountUsageSummary('acct-1')).resolves.toEqual({
      totalRequests: 20,
      monthlyRequests: 10,
      dailyRequests: 2
    })
    expect(dimensionalStoreMock.getAccountUsageHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        days: 30,
        businessTimezone: 'Asia/Shanghai'
      })
    )
    expect(dimensionalStoreMock.getAccountUsageSummary).toHaveBeenCalledWith(
      'acct-1',
      'Asia/Shanghai'
    )
    expect(pgStoreMock.getAccountUsageHistory).not.toHaveBeenCalled()
    expect(pgStoreMock.getAccountUsageSummary).not.toHaveBeenCalled()
  })
})
