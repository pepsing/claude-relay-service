const {
  QuotaCycleService,
  normalizeAccountRefs,
  buildCycleId
} = require('../src/services/quotaCycleService')

function createStore() {
  return {
    ensureSchema: jest.fn().mockResolvedValue(),
    getLatestOpenCycle: jest.fn().mockResolvedValue(null),
    getLatestRecoveredCycle: jest.fn().mockResolvedValue(null),
    getTrackingStartedAt: jest.fn().mockResolvedValue(null),
    markExceeded: jest.fn(async (cycle) => cycle),
    markRecovered: jest.fn(async (input) => input),
    getCycle: jest.fn(),
    aggregateUsage: jest.fn(),
    finalizeUsage: jest.fn(),
    listCycles: jest.fn(),
    claimPendingExports: jest.fn(),
    markExported: jest.fn(),
    markExportFailed: jest.fn()
  }
}

describe('QuotaCycleService', () => {
  test('creates a deterministic provider cycle and only retains safe account reference fields', async () => {
    const store = createStore()
    const service = new QuotaCycleService({
      store,
      now: () => new Date('2026-07-25T07:32:00.000Z')
    })

    const cycle = await service.markExceeded({
      quotaGroupId: 'qg_1',
      provider: 'GLM',
      windowType: 'WEEKLY',
      windowStartAt: '2026-07-23T02:00:00.000Z',
      resetAt: '2026-07-30T02:00:00.000Z',
      boundarySource: 'provider_reset',
      accountRefs: [
        {
          accountId: 'account_1',
          accountType: 'claude-console',
          accountName: 'GLM primary',
          apiKey: 'must-not-leak'
        },
        'account_1',
        'account_2'
      ]
    })

    expect(cycle.cycleKey).toBe('weekly:reset:2026-07-30T02:00:00.000Z')
    expect(cycle.cycleId).toBe(
      buildCycleId({
        quotaGroupId: 'qg_1',
        provider: 'glm',
        windowType: 'weekly',
        cycleKey: cycle.cycleKey
      })
    )
    expect(cycle.accountRefs).toEqual([
      {
        accountId: 'account_1',
        accountType: 'claude-console',
        accountName: 'GLM primary'
      },
      { accountId: 'account_2' }
    ])
    expect(cycle.accountRefs[0]).not.toHaveProperty('apiKey')
    expect(cycle.isPartial).toBe(false)
  })

  test('reuses the open cycle key when the provider has no reset boundary', async () => {
    const store = createStore()
    store.getLatestOpenCycle.mockResolvedValue({
      cycleId: 'existing-cycle',
      cycleKey: 'billing_cycle:observed:2026-07-20T13:03:00.000Z'
    })
    const service = new QuotaCycleService({
      store,
      now: () => new Date('2026-07-28T01:02:00.000Z')
    })

    const cycle = await service.markExceeded({
      quotaGroupId: 'qg_kimi',
      provider: 'kimi',
      windowType: 'billing_cycle',
      accountRefs: ['kimi_1']
    })

    expect(cycle.cycleKey).toBe('billing_cycle:observed:2026-07-20T13:03:00.000Z')
    expect(store.markExceeded).toHaveBeenCalledTimes(1)
    expect(store.getLatestRecoveredCycle).not.toHaveBeenCalled()
  })

  test('uses quota tracking activation as the partial first-cycle boundary', async () => {
    const store = createStore()
    store.getTrackingStartedAt.mockResolvedValue('2026-07-27T00:00:00.000Z')
    const service = new QuotaCycleService({
      store,
      now: () => new Date('2026-07-28T01:02:00.000Z')
    })

    const cycle = await service.markExceeded({
      quotaGroupId: 'qg_kimi',
      provider: 'kimi',
      windowType: 'billing_cycle',
      accountRefs: ['kimi_1']
    })

    expect(cycle.windowStartAt).toEqual(new Date('2026-07-27T00:00:00.000Z'))
    expect(cycle.boundarySource).toBe('tracking_started')
    expect(cycle.isPartial).toBe(true)
  })

  test('uses the previous recovery as the next boundary when no provider reset is available', async () => {
    const store = createStore()
    store.getLatestRecoveredCycle.mockResolvedValue({
      cycleId: 'previous-cycle',
      recoveredAt: '2026-07-21T01:00:00.000Z'
    })
    const service = new QuotaCycleService({
      store,
      now: () => new Date('2026-07-28T01:02:00.000Z')
    })

    const cycle = await service.markExceeded({
      quotaGroupId: 'qg_kimi',
      provider: 'kimi',
      windowType: 'billing_cycle',
      accountRefs: ['kimi_1']
    })

    expect(cycle.windowStartAt).toEqual(new Date('2026-07-21T01:00:00.000Z'))
    expect(cycle.boundarySource).toBe('inferred_from_recovery')
    expect(cycle.isPartial).toBe(false)
  })

  test('rejects a stale exceeded replay older than the inferred recovery boundary', async () => {
    const store = createStore()
    store.getLatestRecoveredCycle.mockResolvedValue({
      cycleId: 'previous-cycle',
      recoveredAt: '2026-07-28T02:00:00.000Z'
    })
    const service = new QuotaCycleService({ store })

    await expect(
      service.markExceeded({
        quotaGroupId: 'qg_kimi',
        provider: 'kimi',
        windowType: 'billing_cycle',
        firstExceededAt: '2026-07-28T01:00:00.000Z',
        accountRefs: ['kimi_1']
      })
    ).rejects.toMatchObject({
      code: 'STALE_QUOTA_EXCEEDED_EVENT',
      message: 'Quota window start time must not be after the first exceeded time'
    })
    expect(store.markExceeded).not.toHaveBeenCalled()
  })

  test('rejects a stale exceeded replay older than an existing open-cycle boundary', async () => {
    const store = createStore()
    store.getLatestOpenCycle.mockResolvedValue({
      cycleId: 'current-cycle',
      cycleKey: 'billing_cycle:start:2026-07-28T02:00:00.000Z',
      windowStartAt: '2026-07-28T02:00:00.000Z'
    })
    const service = new QuotaCycleService({ store })

    await expect(
      service.markExceeded({
        quotaGroupId: 'qg_kimi',
        provider: 'kimi',
        windowType: 'billing_cycle',
        firstExceededAt: '2026-07-28T01:00:00.000Z',
        accountRefs: ['kimi_1']
      })
    ).rejects.toMatchObject({
      code: 'STALE_QUOTA_EXCEEDED_EVENT',
      message: 'Quota window start time must not be after the first exceeded time'
    })
    expect(store.markExceeded).not.toHaveBeenCalled()
  })

  test('finalizes an immutable usage summary from all accounts in the quota group', async () => {
    const store = createStore()
    store.getCycle.mockResolvedValue({
      cycleId: 'quota_cycle_1',
      quotaGroupId: 'qg_1',
      windowStartAt: '2026-07-23T02:00:00.000Z',
      firstExceededAt: '2026-07-25T07:32:00.000Z',
      accountRefs: [
        { accountId: 'account_1', accountType: 'claude-console' },
        { accountId: 'account_2', accountType: 'openai-responses' }
      ],
      usageSummary: null
    })
    store.aggregateUsage.mockResolvedValue({
      source: 'usage_events',
      totals: { requests: 3428, totalTokens: 513340779 }
    })
    store.finalizeUsage.mockImplementation(async (_cycleId, summary) => ({
      usageSummary: summary
    }))
    const service = new QuotaCycleService({
      store,
      now: () => new Date('2026-07-25T07:34:00.000Z')
    })

    const result = await service.finalizeUsage('quota_cycle_1')

    expect(store.aggregateUsage).toHaveBeenCalledWith({
      quotaGroupId: 'qg_1',
      accountRefs: [
        { accountId: 'account_1', accountType: 'claude-console' },
        { accountId: 'account_2', accountType: 'openai-responses' }
      ],
      startAt: new Date('2026-07-23T02:00:00.000Z'),
      endAt: new Date('2026-07-25T07:32:00.000Z')
    })
    expect(result.usageSummary.totals.totalTokens).toBe(513340779)
  })

  test('does not aggregate again after a usage summary has been finalized', async () => {
    const store = createStore()
    const existing = {
      cycleId: 'quota_cycle_1',
      usageSummary: { totals: { requests: 3 } }
    }
    store.getCycle.mockResolvedValue(existing)
    const service = new QuotaCycleService({ store })

    await expect(service.finalizeUsage('quota_cycle_1')).resolves.toBe(existing)
    expect(store.aggregateUsage).not.toHaveBeenCalled()
    expect(store.finalizeUsage).not.toHaveBeenCalled()
  })
})

describe('normalizeAccountRefs', () => {
  test('deduplicates refs by account ID', () => {
    expect(normalizeAccountRefs(['account_1', { id: 'account_1' }, { id: 'account_2' }])).toEqual([
      { accountId: 'account_1' },
      { accountId: 'account_2' }
    ])
  })
})
