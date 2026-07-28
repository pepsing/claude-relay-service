const config = require('../../config/config')
const logger = require('../utils/logger')
const dimensionalStore = require('./usageStores/postgresDimensionalUsageStore')

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const REPAIR_INTERVAL_MS = 6 * HOUR_MS

function floorDate(date, intervalMs) {
  return new Date(Math.floor(date.getTime() / intervalMs) * intervalMs)
}

function ceilDate(date, intervalMs) {
  return new Date(Math.ceil(date.getTime() / intervalMs) * intervalMs)
}

function formatDateInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function shiftDateText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

class UsageDimensionalRollupService {
  constructor(options = {}) {
    this.store = options.store || dimensionalStore
    this.now = typeof options.now === 'function' ? options.now : () => new Date()
    this.materializeTimer = null
    this.repairTimer = null
    this.runningPromise = null
    this.started = false
    this.metrics = {
      materializationRuns: 0,
      materializationErrors: 0,
      repairRuns: 0,
      repairErrors: 0,
      cleanupRuns: 0,
      lastMaterializedAt: null,
      lastRepairedAt: null,
      lastError: null
    }
  }

  getSettings() {
    const aggregationConfig = config.usageAggregation || {}
    const eventRetentionDays = Math.max(
      1,
      Number.parseInt(
        aggregationConfig.eventRetentionDays ?? process.env.USAGE_EVENT_RETENTION_DAYS,
        10
      ) || 14
    )
    return {
      enabled: aggregationConfig.enabled ?? process.env.USAGE_DIMENSIONAL_ROLLUP_ENABLED === 'true',
      readEnabled:
        aggregationConfig.readEnabled ?? process.env.USAGE_DIMENSIONAL_READ_ENABLED === 'true',
      cleanupEnabled:
        aggregationConfig.cleanupEnabled ?? process.env.USAGE_EVENT_CLEANUP_ENABLED === 'true',
      businessTimezone:
        aggregationConfig.businessTimezone ||
        process.env.USAGE_BUSINESS_TIMEZONE ||
        'Asia/Shanghai',
      minuteRetentionHours: Math.max(
        1,
        Number.parseInt(
          aggregationConfig.minuteRetentionHours ?? process.env.USAGE_MINUTE_RETENTION_HOURS,
          10
        ) || 48
      ),
      hourlyRetentionDays: Math.max(
        1,
        Number.parseInt(
          aggregationConfig.hourlyRetentionDays ?? process.env.USAGE_HOURLY_RETENTION_DAYS,
          10
        ) || 30
      ),
      eventRetentionDays,
      repairDays: Math.min(
        Math.max(
          1,
          Number.parseInt(
            aggregationConfig.repairDays ?? process.env.USAGE_ROLLUP_REPAIR_DAYS,
            10
          ) || 14
        ),
        Math.max(1, eventRetentionDays - 2)
      ),
      materializeIntervalMs: Math.max(
        MINUTE_MS,
        Number.parseInt(
          aggregationConfig.materializeIntervalMs ?? process.env.USAGE_ROLLUP_INTERVAL_MS,
          10
        ) || MINUTE_MS
      ),
      cleanupBatchSize: Math.min(
        50000,
        Math.max(
          100,
          Number.parseInt(
            aggregationConfig.cleanupBatchSize ?? process.env.USAGE_EVENT_CLEANUP_BATCH_SIZE,
            10
          ) || 50000
        )
      )
    }
  }

  async start() {
    if (this.started) {
      return { started: false, reason: 'already_started' }
    }

    const settings = this.getSettings()
    if (!settings.enabled) {
      return { started: false, reason: 'disabled' }
    }

    await this.store.ensureSchema()
    this.started = true

    this.runMaterialization()
      .catch((error) => {
        logger.warn(`⚠️ Initial dimensional usage materialization failed: ${error.message}`)
      })
      .finally(() => {
        if (!this.started) {
          return
        }
        this.runRepairAndCleanup().catch((error) => {
          logger.warn(`⚠️ Initial dimensional usage repair failed: ${error.message}`)
        })
      })

    this.materializeTimer = setInterval(() => {
      this.runMaterialization().catch((error) => {
        logger.warn(`⚠️ Dimensional usage materialization failed: ${error.message}`)
      })
    }, settings.materializeIntervalMs)
    this.repairTimer = setInterval(() => {
      this.runRepairAndCleanup().catch((error) => {
        logger.warn(`⚠️ Dimensional usage repair failed: ${error.message}`)
      })
    }, REPAIR_INTERVAL_MS)

    if (typeof this.materializeTimer.unref === 'function') {
      this.materializeTimer.unref()
    }
    if (typeof this.repairTimer.unref === 'function') {
      this.repairTimer.unref()
    }

    logger.info(
      `📈 Dimensional usage rollups started (${settings.materializeIntervalMs / 1000}s interval)`
    )
    return { started: true }
  }

  stop() {
    if (this.materializeTimer) {
      clearInterval(this.materializeTimer)
      this.materializeTimer = null
    }
    if (this.repairTimer) {
      clearInterval(this.repairTimer)
      this.repairTimer = null
    }
    this.started = false
  }

  async runMaterialization(options = {}) {
    const settings = this.getSettings()
    if (!settings.enabled && options.force !== true) {
      return { skipped: true, reason: 'disabled' }
    }
    if (this.runningPromise) {
      return this.runningPromise
    }

    this.runningPromise = (async () => {
      const now = options.now instanceof Date ? options.now : this.now()
      const minuteStart = floorDate(new Date(now.getTime() - 2 * HOUR_MS), MINUTE_MS)
      const minuteEnd = ceilDate(new Date(now.getTime() + MINUTE_MS), MINUTE_MS)
      const hourStart = floorDate(new Date(now.getTime() - 2 * HOUR_MS), HOUR_MS)
      const hourEnd = ceilDate(new Date(now.getTime() + HOUR_MS), HOUR_MS)
      const today = formatDateInTimezone(now, settings.businessTimezone)
      const yesterday = shiftDateText(today, -1)
      const tomorrow = shiftDateText(today, 1)
      const dayStart = await this.store.resolveBusinessDayRange(
        yesterday,
        settings.businessTimezone
      )
      const dayEnd = await this.store.resolveBusinessDayRange(tomorrow, settings.businessTimezone)

      const results = await Promise.all([
        this.store.materializeRange({
          granularity: 'minute',
          startDate: minuteStart,
          endDate: minuteEnd,
          businessTimezone: settings.businessTimezone
        }),
        this.store.materializeRange({
          granularity: 'hour',
          startDate: hourStart,
          endDate: hourEnd,
          businessTimezone: settings.businessTimezone
        }),
        this.store.materializeRange({
          granularity: 'day',
          startDate: dayStart.startDate,
          endDate: dayEnd.startDate,
          businessTimezone: settings.businessTimezone
        })
      ])

      this.metrics.materializationRuns += 1
      this.metrics.lastMaterializedAt = new Date().toISOString()
      this.metrics.lastError = null
      return {
        skipped: false,
        results
      }
    })()
      .catch((error) => {
        this.metrics.materializationErrors += 1
        this.metrics.lastError = error.message
        throw error
      })
      .finally(() => {
        this.runningPromise = null
      })

    return this.runningPromise
  }

  async runRepairAndCleanup(options = {}) {
    const settings = this.getSettings()
    if (!settings.enabled && options.force !== true) {
      return { skipped: true, reason: 'disabled' }
    }

    const now = options.now instanceof Date ? options.now : this.now()
    const today = formatDateInTimezone(now, settings.businessTimezone)
    const repairStartDate = shiftDateText(today, -settings.repairDays)
    const repairStart = await this.store.resolveBusinessDayRange(
      repairStartDate,
      settings.businessTimezone
    )
    const repairEnd = await this.store.resolveBusinessDayRange(
      shiftDateText(today, 1),
      settings.businessTimezone
    )
    const minuteRepairStart = floorDate(
      new Date(now.getTime() - settings.minuteRetentionHours * HOUR_MS),
      MINUTE_MS
    )
    const hourRepairDays = Math.min(settings.hourlyRetentionDays, settings.eventRetentionDays)
    const hourRepairStart = floorDate(new Date(now.getTime() - hourRepairDays * DAY_MS), HOUR_MS)
    const shortTermRepairEnd = ceilDate(new Date(now.getTime() + HOUR_MS), HOUR_MS)

    try {
      const [minuteMaterialization, hourMaterialization, dayMaterialization] = await Promise.all([
        this.store.materializeRange({
          granularity: 'minute',
          startDate: minuteRepairStart,
          endDate: shortTermRepairEnd,
          businessTimezone: settings.businessTimezone
        }),
        this.store.materializeRange({
          granularity: 'hour',
          startDate: hourRepairStart,
          endDate: shortTermRepairEnd,
          businessTimezone: settings.businessTimezone
        }),
        this.store.materializeRange({
          granularity: 'day',
          startDate: repairStart.startDate,
          endDate: repairEnd.startDate,
          businessTimezone: settings.businessTimezone
        })
      ])
      const validations = []
      for (let offset = settings.repairDays; offset >= 1; offset -= 1) {
        const usageDate = shiftDateText(today, -offset)
        validations.push(await this.store.validateDay(usageDate, settings.businessTimezone))
      }

      const rollupCleanup = await this.store.cleanupExpiredRollups({
        minuteRetentionHours: settings.minuteRetentionHours,
        hourlyRetentionDays: settings.hourlyRetentionDays,
        now
      })
      let eventCleanup = {
        deletedRecords: 0,
        skipped: true,
        reason: 'disabled'
      }
      if (settings.cleanupEnabled) {
        eventCleanup = await this.store.cleanupVerifiedUsageEvents({
          retentionDays: settings.eventRetentionDays,
          batchSize: settings.cleanupBatchSize,
          businessTimezone: settings.businessTimezone,
          now
        })
      }

      this.metrics.repairRuns += 1
      this.metrics.cleanupRuns += 1
      this.metrics.lastRepairedAt = new Date().toISOString()
      this.metrics.lastError = null
      return {
        skipped: false,
        minuteMaterialization,
        hourMaterialization,
        dayMaterialization,
        validations,
        rollupCleanup,
        eventCleanup
      }
    } catch (error) {
      this.metrics.repairErrors += 1
      this.metrics.lastError = error.message
      throw error
    }
  }

  async getHealth() {
    const settings = this.getSettings()
    const coverage = settings.enabled ? await this.store.getCoverage() : null
    return {
      started: this.started,
      settings,
      metrics: { ...this.metrics },
      coverage
    }
  }
}

const usageDimensionalRollupService = new UsageDimensionalRollupService()

module.exports = usageDimensionalRollupService
module.exports.UsageDimensionalRollupService = UsageDimensionalRollupService
module.exports._private = {
  floorDate,
  ceilDate,
  formatDateInTimezone,
  shiftDateText,
  MINUTE_MS,
  HOUR_MS,
  DAY_MS
}
