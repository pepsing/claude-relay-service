const logger = require('../utils/logger')
const langfuseTraceService = require('./langfuseTraceService')
const quotaCycleService = require('./quotaCycleService')
const quotaIdentityService = require('./quotaIdentityService')

const WINDOW_DURATIONS_MS = {
  five_hour: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
}

function normalizeDate(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date
}

function isZhipuBucketExhausted(bucket = {}) {
  const percentage = Number(bucket.percentage)
  const remaining = Number(bucket.remaining)
  return (
    (Number.isFinite(percentage) && percentage >= 100) ||
    (bucket.remaining !== null && bucket.remaining !== undefined && remaining <= 0)
  )
}

function getWindowStart(windowType, resetAt) {
  const resetDate = normalizeDate(resetAt)
  if (!resetDate) {
    return null
  }

  const durationMs = WINDOW_DURATIONS_MS[windowType]
  if (durationMs) {
    return new Date(resetDate.getTime() - durationMs)
  }
  if (windowType === 'monthly') {
    let targetYear = resetDate.getUTCFullYear()
    let targetMonth = resetDate.getUTCMonth() - 1
    if (targetMonth < 0) {
      targetYear -= 1
      targetMonth = 11
    }
    const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
    return new Date(
      Date.UTC(
        targetYear,
        targetMonth,
        Math.min(resetDate.getUTCDate(), lastDayOfTargetMonth),
        resetDate.getUTCHours(),
        resetDate.getUTCMinutes(),
        resetDate.getUTCSeconds(),
        resetDate.getUTCMilliseconds()
      )
    )
  }
  return null
}

function compactBucketSnapshot(bucket = {}) {
  return {
    windowType: bucket.windowType,
    label: bucket.label,
    percentage: bucket.percentage,
    total: bucket.total,
    used: bucket.used,
    remaining: bucket.remaining,
    resetAt: bucket.resetAt,
    unit: bucket.unit,
    number: bucket.number,
    exhausted: isZhipuBucketExhausted(bucket)
  }
}

class QuotaCycleIntegrationService {
  constructor(options = {}) {
    this.cycleService = options.cycleService || quotaCycleService
    this.identityService = options.identityService || quotaIdentityService
    this.langfuseService = options.langfuseService || langfuseTraceService
    this.now = typeof options.now === 'function' ? options.now : () => new Date()
  }

  async recordKimiExceeded({ accountType, account, observedAt = this.now() }) {
    const context = await this.identityService.resolveQuotaContext('kimi', accountType, account)
    return this.cycleService.markExceeded({
      quotaGroupId: context.quotaGroupId,
      provider: 'kimi',
      windowType: 'billing_cycle',
      firstExceededAt: observedAt,
      providerSnapshot: {
        windowType: 'billing_cycle',
        exhausted: true
      },
      accountRefs: context.accountRefs
    })
  }

  async recordKimiRecovered({ accountType, account, recoveredAt = this.now() }) {
    const quotaGroupId = this.identityService.buildQuotaGroupId
      ? this.identityService.buildQuotaGroupId('kimi', account)
      : (await this.identityService.resolveQuotaContext('kimi', accountType, account)).quotaGroupId
    return this.cycleService.markRecovered({
      quotaGroupId,
      provider: 'kimi',
      windowType: 'billing_cycle',
      recoveredAt
    })
  }

  async recordVolcengineExceeded({ accountType, account, resetAt, observedAt = this.now() }) {
    const normalizedResetAt = normalizeDate(resetAt)
    if (!normalizedResetAt) {
      throw new Error('Valid resetAt is required for a Volcengine quota cycle')
    }

    const context = await this.identityService.resolveQuotaContext(
      'volcengine',
      accountType,
      account
    )
    return this.cycleService.markExceeded({
      quotaGroupId: context.quotaGroupId,
      provider: 'volcengine',
      windowType: 'monthly',
      windowStartAt: getWindowStart('monthly', normalizedResetAt),
      firstExceededAt: observedAt,
      resetAt: normalizedResetAt,
      boundarySource: 'provider_reset',
      providerSnapshot: {
        windowType: 'monthly',
        resetAt: normalizedResetAt.toISOString(),
        exhausted: true
      },
      accountRefs: context.accountRefs
    })
  }

  async reconcilePersistedQuotaState({ accountType, account }) {
    const result = {
      kimiExceeded: false,
      kimiRecovered: false,
      volcengineExceeded: false
    }

    if (
      account?.kimiQuotaCycleRecoveryPendingAt &&
      this.identityService.isProviderAccount('kimi', account)
    ) {
      if (account.kimiQuotaCycleRecoveryPendingStoppedAt) {
        try {
          await this.recordKimiExceeded({
            accountType,
            account,
            observedAt: account.kimiQuotaCycleRecoveryPendingStoppedAt
          })
          result.kimiExceeded = true
        } catch (error) {
          if (error.code !== 'STALE_QUOTA_EXCEEDED_EVENT') {
            throw error
          }
        }
      }
      await this.recordKimiRecovered({
        accountType,
        account,
        recoveredAt: account.kimiQuotaCycleRecoveryPendingAt
      })
      result.kimiRecovered = true
    }

    if (
      account?.kimiBillingCycleQuotaStoppedAt &&
      this.identityService.isProviderAccount('kimi', account)
    ) {
      await this.recordKimiExceeded({
        accountType,
        account,
        observedAt: account.kimiBillingCycleQuotaStoppedAt
      })
      result.kimiExceeded = true
    }

    const volcengineResetAt = account?.rateLimitEndAt || account?.rateLimitResetAt
    const autoStopped =
      account?.rateLimitAutoStopped === true || account?.rateLimitAutoStopped === 'true'
    if (
      autoStopped &&
      volcengineResetAt &&
      this.identityService.isProviderAccount('volcengine', account)
    ) {
      await this.recordVolcengineExceeded({
        accountType,
        account,
        resetAt: volcengineResetAt,
        observedAt: account.rateLimitedAt || this.now()
      })
      result.volcengineExceeded = true
    }

    return result
  }

  async syncZhipuQuota({ accountType, account, quotaStatus, observedAt = this.now() }) {
    const tokenBuckets = (quotaStatus?.buckets || quotaStatus?.quota?.buckets || []).filter(
      (bucket) =>
        bucket?.type === 'TOKENS_LIMIT' && ['five_hour', 'weekly'].includes(bucket.windowType)
    )
    if (tokenBuckets.length === 0) {
      return { marked: [], recovered: [] }
    }

    const context = await this.identityService.resolveQuotaContext('zhipu', accountType, account)
    const result = { marked: [], recovered: [] }

    for (const bucket of tokenBuckets) {
      if (!isZhipuBucketExhausted(bucket)) {
        const recoveredCycle = await this.cycleService.markRecovered({
          quotaGroupId: context.quotaGroupId,
          provider: 'zhipu',
          windowType: bucket.windowType,
          recoveredAt: observedAt
        })
        if (recoveredCycle) {
          result.recovered.push(recoveredCycle)
        }
        continue
      }

      const resetAt = normalizeDate(bucket.resetAt)
      const windowStartAt = getWindowStart(bucket.windowType, resetAt)
      let bucketObservedAt = normalizeDate(observedAt, this.now())
      let observationClamped = false
      if (windowStartAt && bucketObservedAt < windowStartAt) {
        bucketObservedAt = windowStartAt
        observationClamped = true
      }
      if (resetAt && bucketObservedAt > resetAt) {
        bucketObservedAt = resetAt
        observationClamped = true
      }
      if (this.cycleService.getLatestOpenCycle) {
        const openCycle = await this.cycleService.getLatestOpenCycle({
          quotaGroupId: context.quotaGroupId,
          provider: 'zhipu',
          windowType: bucket.windowType
        })
        const openResetAt = normalizeDate(openCycle?.resetAt)
        if (openCycle && resetAt && (!openResetAt || openResetAt.getTime() !== resetAt.getTime())) {
          const recoveredCycle = await this.cycleService.markRecovered({
            cycleId: openCycle.cycleId,
            recoveredAt: observedAt
          })
          if (recoveredCycle) {
            result.recovered.push(recoveredCycle)
          }
        }
      }
      const cycle = await this.cycleService.markExceeded({
        quotaGroupId: context.quotaGroupId,
        provider: 'zhipu',
        windowType: bucket.windowType,
        windowStartAt,
        firstExceededAt: bucketObservedAt,
        resetAt,
        boundarySource: resetAt ? 'provider_reset' : 'first_observed_exceeded',
        isPartial: !resetAt || observationClamped,
        providerSnapshot: compactBucketSnapshot(bucket),
        accountRefs: context.accountRefs
      })
      result.marked.push(cycle)
    }

    return result
  }

  async processPendingCycles(options = {}) {
    const now = normalizeDate(options.now, this.now())
    const requestedGraceMs = Number(options.graceMs)
    const graceMs = Number.isFinite(requestedGraceMs)
      ? Math.max(0, requestedGraceMs)
      : 2 * 60 * 1000
    const requestedDiscoveryWaitMs = Number(
      options.accountDiscoveryWaitMs ?? process.env.QUOTA_ACCOUNT_DISCOVERY_MAX_WAIT_MS
    )
    const accountDiscoveryWaitMs = Number.isFinite(requestedDiscoveryWaitMs)
      ? Math.max(0, requestedDiscoveryWaitMs)
      : 60 * 60 * 1000
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 20))
    const cutoff = new Date(now.getTime() - graceMs)
    const result = {
      finalized: 0,
      partialFinalized: 0,
      exported: 0,
      failed: 0,
      exportSkipped: null,
      errors: []
    }

    await this.cycleService.initialize()
    const pendingUsage = await this.cycleService.listCycles({
      exportStatus: 'waiting_usage',
      to: cutoff,
      page: 1,
      pageSize: limit
    })
    for (const cycle of pendingUsage.items) {
      try {
        if (this.identityService.resolveQuotaContextByGroup) {
          const context = await this.identityService.resolveQuotaContextByGroup(
            cycle.provider,
            cycle.quotaGroupId
          )
          let accountDiscoveryIncomplete = false
          if (!context.complete) {
            const firstExceededAt = normalizeDate(cycle.firstExceededAt, now)
            if (now.getTime() - firstExceededAt.getTime() < accountDiscoveryWaitMs) {
              throw new Error('Shared quota account discovery was incomplete')
            }
            accountDiscoveryIncomplete = true
            result.partialFinalized += 1
            logger.warn(
              `⚠️ Finalizing quota cycle ${cycle.cycleId} as partial after account discovery timeout`
            )
          }
          const accountRefs = [...(cycle.accountRefs || []), ...context.accountRefs]
          if (accountRefs.length > 0) {
            await this.cycleService.markExceeded({
              cycleId: cycle.cycleId,
              cycleKey: cycle.cycleKey,
              quotaGroupId: cycle.quotaGroupId,
              provider: cycle.provider,
              windowType: cycle.windowType,
              windowStartAt: cycle.windowStartAt,
              firstExceededAt: cycle.firstExceededAt,
              resetAt: cycle.resetAt,
              boundarySource: cycle.boundarySource,
              isPartial: cycle.isPartial || accountDiscoveryIncomplete,
              providerSnapshot: {
                ...cycle.providerSnapshot,
                ...(accountDiscoveryIncomplete ? { accountDiscoveryIncomplete: true } : {})
              },
              accountRefs
            })
          }
        }
        await this.cycleService.finalizeUsage(cycle.cycleId)
        result.finalized += 1
      } catch (error) {
        result.errors.push({ cycleId: cycle.cycleId, stage: 'finalize', error: error.message })
        logger.warn(`⚠️ Failed to finalize quota cycle ${cycle.cycleId}: ${error.message}`)
      }
    }

    if (!this.langfuseService.isEnabled()) {
      result.exportSkipped = 'langfuse_disabled'
      return result
    }

    const claim = await this.cycleService.claimPendingExports({ limit, now })
    for (const cycle of claim.cycles) {
      try {
        const capture = await this.langfuseService.captureQuotaCycleSummary(cycle)
        if (!capture.captured) {
          throw new Error(`Langfuse quota cycle export failed: ${capture.reason || 'unknown'}`)
        }
        await this.cycleService.markExported({
          cycleId: cycle.cycleId,
          claimToken: claim.claimToken,
          traceId: capture.traceId,
          exportedAt: now
        })
        result.exported += 1
      } catch (error) {
        const retryDelayMs = Math.min(
          6 * 60 * 60 * 1000,
          60 * 1000 * 2 ** Math.min(8, Math.max(0, cycle.exportAttempts - 1))
        )
        await this.cycleService.markExportFailed({
          cycleId: cycle.cycleId,
          claimToken: claim.claimToken,
          error,
          nextAttemptAt: new Date(now.getTime() + retryDelayMs)
        })
        result.failed += 1
        result.errors.push({ cycleId: cycle.cycleId, stage: 'export', error: error.message })
        logger.warn(`⚠️ Failed to export quota cycle ${cycle.cycleId}: ${error.message}`)
      }
    }

    return result
  }
}

const quotaCycleIntegrationService = new QuotaCycleIntegrationService()

module.exports = quotaCycleIntegrationService
module.exports.QuotaCycleIntegrationService = QuotaCycleIntegrationService
module.exports._private = {
  getWindowStart,
  isZhipuBucketExhausted,
  compactBucketSnapshot
}
