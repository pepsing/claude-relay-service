const claudeRelayConfigService = require('./claudeRelayConfigService')
const postgresRequestFailureStore = require('./requestFailureStores/postgresRequestFailureStore')
const logger = require('../utils/logger')
const { buildRequestFailureRecord } = require('../utils/requestFailureHelper')

const DEFAULT_RETENTION_HOURS = 48
const MAX_RETENTION_HOURS = 720
const MAX_QUEUE_SIZE = 10000
const WRITE_BATCH_SIZE = 100
const WRITE_RETRY_DELAY_MS = 1000

function clampRetentionHours(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RETENTION_HOURS
  }
  return Math.min(Math.max(parsed, 1), MAX_RETENTION_HOURS)
}

function normalizeDate(value) {
  if (!value) {
    return null
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function sanitizeListFilters(filters = {}, retentionHours = DEFAULT_RETENTION_HOURS) {
  const now = new Date()
  const defaultStart = new Date(now.getTime() - retentionHours * 60 * 60 * 1000)
  const startDate = normalizeDate(filters.startDate) || defaultStart
  const endDate = normalizeDate(filters.endDate) || now

  if (startDate > endDate) {
    const error = new Error('Start date must be before or equal to end date')
    error.statusCode = 400
    throw error
  }

  return {
    ...filters,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString()
  }
}

class RequestFailureDetailService {
  constructor() {
    this.writeQueue = []
    this.drainPromise = null
    this.drainScheduled = false
    this.retryTimer = null
    this.retryDelayPending = false
    this.metrics = {
      queued: 0,
      written: 0,
      dropped: 0,
      writeErrors: 0
    }
  }

  async getSettings() {
    const relayConfig = await claudeRelayConfigService.getConfig()
    return {
      captureEnabled: relayConfig.requestFailureCaptureEnabled === true,
      retentionHours: clampRetentionHours(relayConfig.requestFailureRetentionHours),
      bodyPreviewEnabled: relayConfig.requestFailureBodyPreviewEnabled === true,
      includeClientAbort: relayConfig.requestFailureIncludeClientAbort !== false
    }
  }

  async captureFinalResponse(req, res, options = {}) {
    try {
      const settings = await this.getSettings()
      if (!settings.captureEnabled) {
        return { captured: false, reason: 'disabled' }
      }
      if (options.clientAborted === true && !settings.includeClientAbort) {
        return { captured: false, reason: 'client_abort_disabled' }
      }

      const record = buildRequestFailureRecord(req, res, options)
      if (!record) {
        return { captured: false, reason: 'not_a_final_failure' }
      }
      return this.captureRequestFailure(record, settings)
    } catch (error) {
      logger.warn(`⚠️ Failed to capture final request failure: ${error.message}`)
      return { captured: false, reason: 'error', message: error.message }
    }
  }

  async captureRequestFailure(record = {}, providedSettings = null) {
    try {
      const settings = providedSettings || (await this.getSettings())
      if (!settings.captureEnabled) {
        return { captured: false, reason: 'disabled' }
      }
      if (record.clientAborted === true && !settings.includeClientAbort) {
        return { captured: false, reason: 'client_abort_disabled' }
      }
      if (!record.requestId || !record.apiKeyId) {
        return { captured: false, reason: 'missing_identity' }
      }

      const queuedRecord = { ...record, _writeAttempts: 0 }
      if (!settings.bodyPreviewEnabled) {
        delete queuedRecord.requestBodySnapshot
        queuedRecord.requestBodyTruncated = false
      }

      if (this.writeQueue.length >= MAX_QUEUE_SIZE) {
        this.metrics.dropped += 1
        logger.warn(
          `⚠️ Request failure capture queue is full, dropping ${record.requestId} (dropped=${this.metrics.dropped})`
        )
        return { captured: false, reason: 'queue_full' }
      }

      this.writeQueue.push(queuedRecord)
      this.metrics.queued += 1
      this._scheduleDrain()
      return { captured: true, queued: true, requestId: record.requestId }
    } catch (error) {
      logger.warn(`⚠️ Failed to queue request failure detail: ${error.message}`)
      return { captured: false, reason: 'error', message: error.message }
    }
  }

  _scheduleDrain(delayMs = 0) {
    if (this.drainScheduled || this.drainPromise) {
      return
    }

    this.drainScheduled = true
    const schedule = delayMs > 0 ? setTimeout : setImmediate
    const timer = schedule(() => {
      this.drainScheduled = false
      this.retryTimer = null
      this._drain().catch((error) => {
        logger.warn(`⚠️ Request failure capture drain failed: ${error.message}`)
      })
    }, delayMs)

    if (delayMs > 0) {
      this.retryTimer = timer
    }
    if (typeof timer?.unref === 'function') {
      timer.unref()
    }
  }

  async _drain() {
    if (this.drainPromise) {
      return this.drainPromise
    }

    this.drainPromise = (async () => {
      while (this.writeQueue.length > 0) {
        const batch = this.writeQueue.splice(0, WRITE_BATCH_SIZE)
        try {
          const result = await postgresRequestFailureStore.upsertRequestFailures(batch)
          this.metrics.written += result.upserted || 0
        } catch (error) {
          this.metrics.writeErrors += 1
          const retryable = batch
            .map((record) => ({
              ...record,
              _writeAttempts: Number(record._writeAttempts || 0) + 1
            }))
            .filter((record) => record._writeAttempts <= 1)
          this.metrics.dropped += batch.length - retryable.length

          if (retryable.length > 0) {
            this.writeQueue.unshift(...retryable)
          }
          logger.warn(
            `⚠️ Failed to persist request failure batch (${batch.length} records): ${error.message}`
          )
          this.retryDelayPending = true
          break
        }
      }
    })()

    try {
      await this.drainPromise
    } finally {
      this.drainPromise = null
      if (this.writeQueue.length > 0 && !this.retryTimer) {
        const delayMs = this.retryDelayPending ? WRITE_RETRY_DELAY_MS : 0
        this.retryDelayPending = false
        this._scheduleDrain(delayMs)
      }
    }
  }

  async flush(timeoutMs = 5000) {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
      this.drainScheduled = false
    }

    const flushPromise = this._drain()
    let timeout
    try {
      await Promise.race([
        flushPromise,
        new Promise((resolve) => {
          timeout = setTimeout(resolve, Math.max(1, timeoutMs))
          if (typeof timeout.unref === 'function') {
            timeout.unref()
          }
        })
      ])
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }

    return {
      remaining: this.writeQueue.length,
      ...this.metrics
    }
  }

  getMetrics() {
    return {
      queueLength: this.writeQueue.length,
      ...this.metrics
    }
  }

  async listRequestFailures(filters = {}) {
    const settings = await this.getSettings()
    const normalizedFilters = sanitizeListFilters(filters, settings.retentionHours)
    const [list, summary, availableFilters] = await Promise.all([
      postgresRequestFailureStore.listRequestFailures(normalizedFilters),
      postgresRequestFailureStore.getRequestFailureSummary(normalizedFilters),
      postgresRequestFailureStore.getAvailableFilters(normalizedFilters)
    ])

    return {
      captureEnabled: settings.captureEnabled,
      retentionHours: settings.retentionHours,
      ...list,
      summary,
      availableFilters,
      filters: {
        startDate: normalizedFilters.startDate,
        endDate: normalizedFilters.endDate,
        keyword: normalizedFilters.keyword || null,
        apiKeyId: normalizedFilters.apiKeyId || null,
        accountId: normalizedFilters.accountId || null,
        model: normalizedFilters.model || null,
        endpoint: normalizedFilters.endpoint || null,
        statusCode: normalizedFilters.statusCode || null,
        failureType: normalizedFilters.failureType || null
      }
    }
  }

  async getRequestFailure(requestId, filters = {}) {
    const settings = await this.getSettings()
    const record = await postgresRequestFailureStore.getRequestFailure(requestId, filters)
    return {
      captureEnabled: settings.captureEnabled,
      retentionHours: settings.retentionHours,
      record
    }
  }

  async cleanupExpiredPostgresRequestFailures(options = {}) {
    const settings = await this.getSettings()
    return postgresRequestFailureStore.cleanupExpiredRequestFailures({
      retentionHours: options.retentionHours || settings.retentionHours,
      batchSize: options.batchSize
    })
  }
}

module.exports = new RequestFailureDetailService()
module.exports.clampRetentionHours = clampRetentionHours
module.exports.sanitizeListFilters = sanitizeListFilters
