const crypto = require('crypto')
const postgresQuotaCycleStore = require('./quotaCycleStores/postgresQuotaCycleStore')

const ALLOWED_ACCOUNT_REF_FIELDS = ['accountId', 'id', 'accountType', 'type', 'accountName', 'name']

function normalizeText(value, fallback = null) {
  if (value === null || value === undefined) {
    return fallback
  }
  const normalized = String(value).split('\u0000').join('').trim()
  return normalized || fallback
}

function normalizeDate(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date
}

function normalizeAccountRefs(accountRefs = []) {
  const refs = []
  const seen = new Set()
  for (const rawRef of Array.isArray(accountRefs) ? accountRefs : []) {
    const source = typeof rawRef === 'string' ? { accountId: rawRef } : rawRef
    if (!source || typeof source !== 'object') {
      continue
    }

    const accountId = normalizeText(source.accountId || source.id)
    const accountType = normalizeText(source.accountType || source.type)
    const accountKey = `${accountType || '*'}:${accountId}`
    if (!accountId || seen.has(accountKey)) {
      continue
    }
    seen.add(accountKey)

    const ref = { accountId }
    if (accountType) {
      ref.accountType = accountType
    }
    for (const field of ALLOWED_ACCOUNT_REF_FIELDS) {
      const value = normalizeText(source[field])
      if (value && !['accountId', 'id', 'accountType', 'type'].includes(field)) {
        ref[field] = value
      }
    }
    refs.push(ref)
  }
  const typedAccountIds = new Set(refs.filter((ref) => ref.accountType).map((ref) => ref.accountId))
  return refs.filter((ref) => ref.accountType || !typedAccountIds.has(ref.accountId))
}

function buildCycleId({ quotaGroupId, provider, windowType, cycleKey }) {
  const digest = crypto
    .createHash('sha256')
    .update([quotaGroupId, provider, windowType, cycleKey].join('\u001f'))
    .digest('hex')
  return `quota_${digest.slice(0, 32)}`
}

function deriveCycleKey({ windowType, resetAt, windowStartAt, firstExceededAt }) {
  if (resetAt) {
    return `${windowType}:reset:${resetAt.toISOString()}`
  }
  if (windowStartAt) {
    return `${windowType}:start:${windowStartAt.toISOString()}`
  }
  return `${windowType}:observed:${firstExceededAt.toISOString()}`
}

class QuotaCycleService {
  constructor(options = {}) {
    this.store = options.store || postgresQuotaCycleStore
    this.now = typeof options.now === 'function' ? options.now : () => new Date()
  }

  async initialize() {
    await this.store.ensureSchema()
    return true
  }

  async markExceeded(input = {}) {
    const quotaGroupId = normalizeText(input.quotaGroupId)
    const provider = normalizeText(input.provider)?.toLowerCase()
    const windowType = normalizeText(input.windowType)?.toLowerCase()
    if (!quotaGroupId || !provider || !windowType) {
      throw new Error('quotaGroupId, provider and windowType are required')
    }

    const firstExceededAt = normalizeDate(input.firstExceededAt, this.now())
    let windowStartAt = normalizeDate(input.windowStartAt)
    const resetAt = normalizeDate(input.resetAt)
    const reuseOpenCycle = !input.cycleKey && !resetAt && !windowStartAt
    if (windowStartAt && windowStartAt > firstExceededAt) {
      throw new Error('Quota window start time must not be after the first exceeded time')
    }
    if (resetAt && resetAt < firstExceededAt) {
      throw new Error('Quota reset time must not be before the first exceeded time')
    }

    let cycleKey = normalizeText(input.cycleKey)
    let inferredBoundarySource = null
    if (!cycleKey && !resetAt && !windowStartAt) {
      const openCycle = await this.store.getLatestOpenCycle({
        quotaGroupId,
        provider,
        windowType
      })
      cycleKey = openCycle?.cycleKey || null
      windowStartAt = normalizeDate(openCycle?.windowStartAt)
      if (!cycleKey) {
        const recoveredCycle = await this.store.getLatestRecoveredCycle({
          quotaGroupId,
          provider,
          windowType
        })
        windowStartAt = normalizeDate(recoveredCycle?.recoveredAt)
        if (windowStartAt) {
          inferredBoundarySource = 'inferred_from_recovery'
        } else {
          const trackingStartedAt = normalizeDate(await this.store.getTrackingStartedAt())
          if (trackingStartedAt && trackingStartedAt <= firstExceededAt) {
            windowStartAt = trackingStartedAt
            inferredBoundarySource = 'tracking_started'
          } else {
            windowStartAt = firstExceededAt
            inferredBoundarySource = 'first_observed_exceeded'
          }
        }
      }
    }
    if (windowStartAt && windowStartAt > firstExceededAt) {
      throw Object.assign(
        new Error('Quota window start time must not be after the first exceeded time'),
        {
          code: 'STALE_QUOTA_EXCEEDED_EVENT'
        }
      )
    }
    cycleKey =
      cycleKey ||
      deriveCycleKey({
        windowType,
        resetAt,
        windowStartAt,
        firstExceededAt
      })

    const accountRefs = normalizeAccountRefs(input.accountRefs)
    return this.store.markExceeded({
      cycleId:
        normalizeText(input.cycleId) ||
        buildCycleId({ quotaGroupId, provider, windowType, cycleKey }),
      cycleKey,
      quotaGroupId,
      provider,
      windowType,
      windowStartAt,
      firstExceededAt,
      resetAt,
      boundarySource: normalizeText(input.boundarySource, inferredBoundarySource || 'unknown'),
      isPartial:
        input.isPartial === true ||
        !windowStartAt ||
        ['tracking_started', 'first_observed_exceeded'].includes(inferredBoundarySource),
      providerSnapshot:
        input.providerSnapshot && typeof input.providerSnapshot === 'object'
          ? input.providerSnapshot
          : {},
      accountRefs,
      reuseOpenCycle
    })
  }

  async markRecovered(input = {}) {
    let cycleId = normalizeText(input.cycleId)
    if (!cycleId) {
      const quotaGroupId = normalizeText(input.quotaGroupId)
      const provider = normalizeText(input.provider)?.toLowerCase()
      if (!quotaGroupId || !provider) {
        throw new Error('cycleId or both quotaGroupId and provider are required')
      }
      const openCycle = await this.store.getLatestOpenCycle({
        quotaGroupId,
        provider,
        windowType: normalizeText(input.windowType)?.toLowerCase() || null
      })
      cycleId = openCycle?.cycleId || null
    }
    if (!cycleId) {
      return null
    }

    return this.store.markRecovered({
      cycleId,
      recoveredAt: normalizeDate(input.recoveredAt, this.now())
    })
  }

  async finalizeUsage(cycleId, options = {}) {
    const normalizedCycleId = normalizeText(cycleId)
    if (!normalizedCycleId) {
      throw new Error('cycleId is required')
    }

    const cycle = await this.store.getCycle(normalizedCycleId)
    if (!cycle) {
      return null
    }
    if (cycle.usageSummary) {
      return cycle
    }

    const accountRefs =
      normalizeAccountRefs(options.accountRefs).length > 0
        ? normalizeAccountRefs(options.accountRefs)
        : normalizeAccountRefs(cycle.accountRefs)
    if (accountRefs.length === 0) {
      throw new Error(`Quota cycle ${normalizedCycleId} has no account IDs for usage aggregation`)
    }

    const usageSummary = await this.store.aggregateUsage({
      quotaGroupId: cycle.quotaGroupId,
      accountRefs,
      startAt: normalizeDate(options.startAt || cycle.windowStartAt),
      endAt: normalizeDate(options.endAt || cycle.firstExceededAt)
    })
    return this.store.finalizeUsage(normalizedCycleId, usageSummary, this.now())
  }

  async getCycle(cycleId) {
    return this.store.getCycle(normalizeText(cycleId))
  }

  async getLatestOpenCycle(input = {}) {
    const quotaGroupId = normalizeText(input.quotaGroupId)
    const provider = normalizeText(input.provider)?.toLowerCase()
    if (!quotaGroupId || !provider) {
      throw new Error('quotaGroupId and provider are required')
    }
    return this.store.getLatestOpenCycle({
      quotaGroupId,
      provider,
      windowType: normalizeText(input.windowType)?.toLowerCase() || null
    })
  }

  async listCycles(filters = {}) {
    return this.store.listCycles(filters)
  }

  async claimPendingExports(options = {}) {
    return this.store.claimPendingExports(options)
  }

  async markExported(input = {}) {
    return this.store.markExported(input)
  }

  async markExportFailed(input = {}) {
    return this.store.markExportFailed(input)
  }
}

const quotaCycleService = new QuotaCycleService()

module.exports = quotaCycleService
module.exports.QuotaCycleService = QuotaCycleService
module.exports.normalizeAccountRefs = normalizeAccountRefs
module.exports.buildCycleId = buildCycleId
