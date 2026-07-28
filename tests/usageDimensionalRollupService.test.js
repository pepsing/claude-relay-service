const mockStore = {
  ensureSchema: jest.fn(),
  materializeRange: jest.fn(),
  resolveBusinessDayRange: jest.fn(),
  validateDay: jest.fn(),
  cleanupExpiredRollups: jest.fn(),
  cleanupVerifiedUsageEvents: jest.fn(),
  getCoverage: jest.fn()
}

jest.mock('../config/config', () => ({
  usageAggregation: {
    enabled: true,
    readEnabled: false,
    cleanupEnabled: false,
    businessTimezone: 'Asia/Shanghai',
    minuteRetentionHours: 48,
    hourlyRetentionDays: 30,
    eventRetentionDays: 14,
    repairDays: 14,
    materializeIntervalMs: 60000,
    cleanupBatchSize: 50000
  }
}))

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn()
}))

jest.mock('../src/services/usageStores/postgresDimensionalUsageStore', () => mockStore)

const { UsageDimensionalRollupService } = require('../src/services/usageDimensionalRollupService')

function dateRange(dateText) {
  const startDate = new Date(`${dateText}T00:00:00.000Z`)
  return {
    usageDate: dateText,
    startDate,
    endDate: new Date(startDate.getTime() + 86400000)
  }
}

describe('UsageDimensionalRollupService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockStore.ensureSchema.mockResolvedValue()
    mockStore.materializeRange.mockResolvedValue({ materialized: true, rows: 1 })
    mockStore.resolveBusinessDayRange.mockImplementation(async (dateText) => dateRange(dateText))
    mockStore.validateDay.mockImplementation(async (dateText) => ({
      usageDate: dateText,
      verified: true
    }))
    mockStore.cleanupExpiredRollups.mockResolvedValue({
      minuteDeleted: 0,
      hourDeleted: 0
    })
    mockStore.cleanupVerifiedUsageEvents.mockResolvedValue({ deletedRecords: 0 })
    mockStore.getCoverage.mockResolvedValue({ granularities: [], validation: {} })
  })

  test('materializes rolling minute/hour buckets and local business days', async () => {
    const service = new UsageDimensionalRollupService({
      store: mockStore,
      now: () => new Date('2026-07-28T10:05:30.000Z')
    })

    const result = await service.runMaterialization({ force: true })

    expect(result.results).toHaveLength(3)
    expect(mockStore.materializeRange).toHaveBeenCalledWith(
      expect.objectContaining({
        granularity: 'minute',
        startDate: new Date('2026-07-28T08:05:00.000Z'),
        endDate: new Date('2026-07-28T10:07:00.000Z')
      })
    )
    expect(mockStore.materializeRange).toHaveBeenCalledWith(
      expect.objectContaining({
        granularity: 'hour',
        startDate: new Date('2026-07-28T08:00:00.000Z'),
        endDate: new Date('2026-07-28T12:00:00.000Z')
      })
    )
    expect(mockStore.resolveBusinessDayRange).toHaveBeenCalledWith('2026-07-27', 'Asia/Shanghai')
  })

  test('keeps the repair window shorter than raw-event retention and does not delete by default', async () => {
    const service = new UsageDimensionalRollupService({
      store: mockStore,
      now: () => new Date('2026-07-28T10:05:30.000Z')
    })

    const result = await service.runRepairAndCleanup({ force: true })

    expect(result.validations).toHaveLength(12)
    expect(mockStore.validateDay).toHaveBeenCalledWith('2026-07-16', 'Asia/Shanghai')
    expect(mockStore.validateDay).toHaveBeenLastCalledWith('2026-07-27', 'Asia/Shanghai')
    expect(mockStore.cleanupExpiredRollups).toHaveBeenCalled()
    expect(mockStore.cleanupVerifiedUsageEvents).not.toHaveBeenCalled()
    expect(result.eventCleanup).toEqual(
      expect.objectContaining({ skipped: true, reason: 'disabled' })
    )
  })
})
