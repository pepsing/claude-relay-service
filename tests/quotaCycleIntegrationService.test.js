jest.mock('../src/utils/logger', () => ({
  warn: jest.fn()
}))

const {
  QuotaCycleIntegrationService,
  _private
} = require('../src/services/quotaCycleIntegrationService')

function createDependencies() {
  return {
    cycleService: {
      initialize: jest.fn().mockResolvedValue(true),
      markExceeded: jest.fn(async (input) => input),
      markRecovered: jest.fn(async (input) => ({ cycleId: `recovered-${input.windowType}` })),
      listCycles: jest.fn().mockResolvedValue({ items: [], pagination: {} }),
      finalizeUsage: jest.fn(),
      claimPendingExports: jest.fn().mockResolvedValue({ claimToken: 'claim-1', cycles: [] }),
      markExported: jest.fn(),
      markExportFailed: jest.fn()
    },
    identityService: {
      resolveQuotaContext: jest.fn().mockResolvedValue({
        quotaGroupId: 'qg-shared',
        accountRefs: [
          {
            accountId: 'claude-1',
            accountType: 'claude-console',
            accountName: 'Claude GLM'
          },
          {
            accountId: 'responses-1',
            accountType: 'openai-responses',
            accountName: 'Responses GLM'
          }
        ]
      })
    },
    langfuseService: {
      isEnabled: jest.fn().mockReturnValue(true),
      isQuotaCycleEnabled: jest.fn().mockReturnValue(true),
      captureQuotaCycleSummary: jest.fn()
    }
  }
}

describe('QuotaCycleIntegrationService', () => {
  test('tracks five-hour and weekly Zhipu buckets independently', async () => {
    const dependencies = createDependencies()
    const service = new QuotaCycleIntegrationService(dependencies)
    const observedAt = new Date('2026-07-28T10:00:00.000Z')

    const result = await service.syncZhipuQuota({
      accountType: 'claude-console',
      account: { id: 'claude-1', apiKey: 'secret' },
      observedAt,
      quotaStatus: {
        buckets: [
          {
            type: 'TOKENS_LIMIT',
            windowType: 'five_hour',
            label: '5小时额度',
            percentage: 100,
            remaining: 0,
            resetAt: '2026-07-28T12:00:00.000Z'
          },
          {
            type: 'TOKENS_LIMIT',
            windowType: 'weekly',
            label: '每周额度',
            percentage: 50,
            remaining: 50,
            resetAt: '2026-08-03T00:00:00.000Z'
          }
        ]
      }
    })

    expect(dependencies.cycleService.markExceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        quotaGroupId: 'qg-shared',
        provider: 'zhipu',
        windowType: 'five_hour',
        windowStartAt: new Date('2026-07-28T07:00:00.000Z'),
        firstExceededAt: observedAt,
        resetAt: new Date('2026-07-28T12:00:00.000Z'),
        isPartial: false
      })
    )
    expect(dependencies.cycleService.markRecovered).toHaveBeenCalledWith({
      quotaGroupId: 'qg-shared',
      provider: 'zhipu',
      windowType: 'weekly',
      recoveredAt: observedAt
    })
    expect(result.marked).toHaveLength(1)
    expect(result.recovered).toHaveLength(1)
  })

  test('records Kimi as an open cycle and Volcengine from the prior monthly reset', async () => {
    const dependencies = createDependencies()
    const service = new QuotaCycleIntegrationService(dependencies)
    const observedAt = new Date('2026-07-28T10:00:00.000Z')
    const account = { id: 'account-1', apiKey: 'secret' }

    await service.recordKimiExceeded({
      accountType: 'openai-responses',
      account,
      observedAt
    })
    await service.recordVolcengineExceeded({
      accountType: 'openai-responses',
      account,
      observedAt,
      resetAt: '2026-08-01T00:00:00.000Z'
    })

    expect(dependencies.cycleService.markExceeded.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        provider: 'kimi',
        windowType: 'billing_cycle',
        firstExceededAt: observedAt
      })
    )
    expect(dependencies.cycleService.markExceeded.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        provider: 'volcengine',
        windowType: 'monthly',
        windowStartAt: new Date('2026-07-01T00:00:00.000Z'),
        resetAt: new Date('2026-08-01T00:00:00.000Z')
      })
    )
  })

  test('clamps legacy Zhipu replay observations into the provider window and marks them partial', async () => {
    const dependencies = createDependencies()
    const service = new QuotaCycleIntegrationService(dependencies)

    await service.syncZhipuQuota({
      accountType: 'claude-console',
      account: { id: 'claude-legacy', apiKey: 'secret' },
      observedAt: '2026-07-29T12:00:00.000Z',
      quotaStatus: {
        buckets: [
          {
            type: 'TOKENS_LIMIT',
            windowType: 'five_hour',
            percentage: 100,
            remaining: 0,
            resetAt: '2026-07-28T12:00:00.000Z'
          }
        ]
      }
    })

    expect(dependencies.cycleService.markExceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        windowStartAt: new Date('2026-07-28T07:00:00.000Z'),
        firstExceededAt: new Date('2026-07-28T12:00:00.000Z'),
        resetAt: new Date('2026-07-28T12:00:00.000Z'),
        isPartial: true
      })
    )
  })

  test('reconciles persisted quota state for durable retries', async () => {
    const dependencies = createDependencies()
    dependencies.identityService.isProviderAccount = jest.fn().mockReturnValue(true)
    const service = new QuotaCycleIntegrationService(dependencies)
    jest.spyOn(service, 'recordKimiExceeded').mockResolvedValue({})
    jest.spyOn(service, 'recordKimiRecovered').mockResolvedValue({})
    jest.spyOn(service, 'recordVolcengineExceeded').mockResolvedValue({})
    const account = {
      id: 'account-1',
      kimiBillingCycleQuotaStoppedAt: '2026-07-28T03:00:00.000Z',
      kimiQuotaCycleRecoveryPendingAt: '2026-07-28T02:00:00.000Z',
      kimiQuotaCycleRecoveryPendingStoppedAt: '2026-07-28T01:00:00.000Z',
      rateLimitAutoStopped: 'true',
      rateLimitResetAt: '2026-08-01T00:00:00.000Z',
      rateLimitedAt: '2026-07-28T01:30:00.000Z'
    }

    const result = await service.reconcilePersistedQuotaState({
      accountType: 'openai-responses',
      account
    })

    expect(service.recordKimiExceeded).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        observedAt: account.kimiQuotaCycleRecoveryPendingStoppedAt
      })
    )
    expect(service.recordKimiRecovered).toHaveBeenCalledWith(
      expect.objectContaining({ recoveredAt: account.kimiQuotaCycleRecoveryPendingAt })
    )
    expect(service.recordKimiExceeded).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ observedAt: account.kimiBillingCycleQuotaStoppedAt })
    )
    expect(service.recordKimiExceeded.mock.invocationCallOrder[0]).toBeLessThan(
      service.recordKimiRecovered.mock.invocationCallOrder[0]
    )
    expect(service.recordKimiRecovered.mock.invocationCallOrder[0]).toBeLessThan(
      service.recordKimiExceeded.mock.invocationCallOrder[1]
    )
    expect(service.recordVolcengineExceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        resetAt: account.rateLimitResetAt,
        observedAt: account.rateLimitedAt
      })
    )
    expect(result).toEqual({
      kimiExceeded: true,
      kimiRecovered: true,
      volcengineExceeded: true
    })
  })

  test('continues with a current stop after an older recovery replay is stale', async () => {
    const dependencies = createDependencies()
    dependencies.identityService.isProviderAccount = jest.fn().mockReturnValue(true)
    const service = new QuotaCycleIntegrationService(dependencies)
    const staleError = Object.assign(new Error('stale replay'), {
      code: 'STALE_QUOTA_EXCEEDED_EVENT'
    })
    jest
      .spyOn(service, 'recordKimiExceeded')
      .mockRejectedValueOnce(staleError)
      .mockResolvedValueOnce({})
    jest.spyOn(service, 'recordKimiRecovered').mockResolvedValue(null)
    const account = {
      id: 'account-retry',
      kimiQuotaCycleRecoveryPendingStoppedAt: '2026-07-28T01:00:00.000Z',
      kimiQuotaCycleRecoveryPendingAt: '2026-07-28T02:00:00.000Z',
      kimiBillingCycleQuotaStoppedAt: '2026-07-28T03:00:00.000Z'
    }

    const result = await service.reconcilePersistedQuotaState({
      accountType: 'openai-responses',
      account
    })

    expect(service.recordKimiRecovered).toHaveBeenCalledWith(
      expect.objectContaining({ recoveredAt: account.kimiQuotaCycleRecoveryPendingAt })
    )
    expect(service.recordKimiExceeded).toHaveBeenLastCalledWith(
      expect.objectContaining({ observedAt: account.kimiBillingCycleQuotaStoppedAt })
    )
    expect(result).toEqual({
      kimiExceeded: true,
      kimiRecovered: true,
      volcengineExceeded: false
    })
  })

  test('finalizes mature cycles and exports claimed summaries to Langfuse', async () => {
    const dependencies = createDependencies()
    const now = new Date('2026-07-28T10:05:00.000Z')
    const pendingCycle = {
      cycleId: 'cycle-pending',
      cycleKey: 'weekly:reset:2026-08-03T00:00:00.000Z',
      quotaGroupId: 'qg-shared',
      provider: 'zhipu',
      windowType: 'weekly',
      windowStartAt: '2026-07-27T00:00:00.000Z',
      firstExceededAt: '2026-07-28T10:00:00.000Z',
      resetAt: '2026-08-03T00:00:00.000Z',
      boundarySource: 'provider_reset',
      isPartial: false,
      providerSnapshot: { percentage: 100 }
    }
    const claimedCycle = {
      cycleId: 'cycle-export',
      exportAttempts: 1,
      usageSummary: { totals: { totalTokens: 42 } }
    }
    dependencies.cycleService.listCycles.mockResolvedValue({
      items: [pendingCycle],
      pagination: {}
    })
    dependencies.cycleService.finalizeUsage.mockResolvedValue({
      ...pendingCycle,
      usageSummary: { totals: { totalTokens: 42 } }
    })
    dependencies.cycleService.claimPendingExports.mockResolvedValue({
      claimToken: 'claim-1',
      cycles: [claimedCycle]
    })
    dependencies.langfuseService.captureQuotaCycleSummary.mockResolvedValue({
      captured: true,
      traceId: 'trace-1'
    })
    dependencies.identityService.resolveQuotaContextByGroup = jest.fn().mockResolvedValue({
      complete: true,
      accountRefs: [{ accountId: 'linked-1', accountType: 'claude-console' }]
    })
    const service = new QuotaCycleIntegrationService(dependencies)

    const result = await service.processPendingCycles({ now, graceMs: 120000, limit: 10 })

    expect(dependencies.cycleService.listCycles).toHaveBeenCalledWith({
      exportStatus: 'waiting_usage',
      to: new Date('2026-07-28T10:03:00.000Z'),
      page: 1,
      pageSize: 10
    })
    expect(dependencies.cycleService.finalizeUsage).toHaveBeenCalledWith('cycle-pending')
    expect(dependencies.cycleService.markExceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        cycleId: 'cycle-pending',
        quotaGroupId: 'qg-shared',
        accountRefs: [{ accountId: 'linked-1', accountType: 'claude-console' }]
      })
    )
    expect(dependencies.langfuseService.captureQuotaCycleSummary).toHaveBeenCalledWith(claimedCycle)
    expect(dependencies.cycleService.markExported).toHaveBeenCalledWith({
      cycleId: 'cycle-export',
      claimToken: 'claim-1',
      traceId: 'trace-1',
      exportedAt: now
    })
    expect(result).toEqual(
      expect.objectContaining({
        finalized: 1,
        exported: 1,
        failed: 0
      })
    )
  })

  test('keeps finalized summaries pending while Langfuse is disabled', async () => {
    const dependencies = createDependencies()
    dependencies.langfuseService.isQuotaCycleEnabled.mockReturnValue(false)
    const service = new QuotaCycleIntegrationService(dependencies)

    const result = await service.processPendingCycles({
      now: new Date('2026-07-28T10:05:00.000Z')
    })

    expect(result.exportSkipped).toBe('langfuse_disabled')
    expect(dependencies.cycleService.claimPendingExports).not.toHaveBeenCalled()
  })

  test('defers finalization until shared account discovery is complete', async () => {
    const dependencies = createDependencies()
    dependencies.cycleService.listCycles.mockResolvedValue({
      items: [
        {
          cycleId: 'cycle-pending',
          quotaGroupId: 'qg-shared',
          provider: 'zhipu',
          windowType: 'weekly'
        }
      ],
      pagination: {}
    })
    dependencies.identityService.resolveQuotaContextByGroup = jest.fn().mockResolvedValue({
      complete: false,
      accountRefs: []
    })
    const service = new QuotaCycleIntegrationService(dependencies)

    const result = await service.processPendingCycles({
      now: new Date('2026-07-28T10:05:00.000Z')
    })

    expect(dependencies.cycleService.finalizeUsage).not.toHaveBeenCalled()
    expect(result.errors).toEqual([
      expect.objectContaining({
        cycleId: 'cycle-pending',
        stage: 'finalize',
        error: 'Shared quota account discovery was incomplete'
      })
    ])
  })

  test('finalizes as partial after the account discovery retry window expires', async () => {
    const dependencies = createDependencies()
    dependencies.langfuseService.isQuotaCycleEnabled.mockReturnValue(false)
    dependencies.cycleService.listCycles.mockResolvedValue({
      items: [
        {
          cycleId: 'cycle-pending',
          cycleKey: 'weekly:reset:2026-08-03T00:00:00.000Z',
          quotaGroupId: 'qg-shared',
          provider: 'zhipu',
          windowType: 'weekly',
          windowStartAt: '2026-07-27T00:00:00.000Z',
          firstExceededAt: '2026-07-28T08:00:00.000Z',
          resetAt: '2026-08-03T00:00:00.000Z',
          boundarySource: 'provider_reset',
          isPartial: false,
          providerSnapshot: {},
          accountRefs: [{ accountId: 'known-1', accountType: 'claude-console' }]
        }
      ],
      pagination: {}
    })
    dependencies.identityService.resolveQuotaContextByGroup = jest.fn().mockResolvedValue({
      complete: false,
      accountRefs: []
    })
    const service = new QuotaCycleIntegrationService(dependencies)

    const result = await service.processPendingCycles({
      now: new Date('2026-07-28T10:05:00.000Z'),
      accountDiscoveryWaitMs: 60 * 60 * 1000
    })

    expect(dependencies.cycleService.markExceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        cycleId: 'cycle-pending',
        isPartial: true,
        providerSnapshot: { accountDiscoveryIncomplete: true }
      })
    )
    expect(dependencies.cycleService.finalizeUsage).toHaveBeenCalledWith('cycle-pending')
    expect(result.partialFinalized).toBe(1)
  })

  test('uses calendar months for Volcengine window boundaries', () => {
    expect(_private.getWindowStart('monthly', '2026-03-01T00:00:00.000Z')).toEqual(
      new Date('2026-02-01T00:00:00.000Z')
    )
    expect(_private.getWindowStart('monthly', '2026-07-31T23:59:59.000Z')).toEqual(
      new Date('2026-06-30T23:59:59.000Z')
    )
  })
})
