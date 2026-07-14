const claudeRelayConfigService = require('./claudeRelayConfigService')
const logger = require('../utils/logger')

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

class AccountConcurrencyQueueService {
  async waitForSlot({
    accountId,
    accountName,
    maxConcurrentTasks,
    tryAcquire,
    release,
    isDisconnected = () => false
  }) {
    const relayConfig = await claudeRelayConfigService.getConfig()
    const timeoutMs = Math.max(1000, Number(relayConfig.concurrentRequestQueueTimeoutMs) || 10000)
    const startedAt = Date.now()
    let pollIntervalMs = 50

    logger.info(
      `⏳ Sticky session waiting for account concurrency: ${accountName || accountId} (timeout: ${timeoutMs}ms)`
    )

    while (Date.now() - startedAt < timeoutMs) {
      if (isDisconnected()) {
        const error = new Error('Client disconnected while waiting for account concurrency')
        error.code = 'ACCOUNT_CONCURRENCY_QUEUE_CANCELLED'
        error.statusCode = 499
        throw error
      }

      const currentConcurrency = Number(await tryAcquire())
      if (currentConcurrency <= maxConcurrentTasks) {
        const waitTimeMs = Date.now() - startedAt
        logger.info(
          `✅ Sticky session acquired queued account slot: ${accountName || accountId} after ${waitTimeMs}ms`
        )
        return { currentConcurrency, waitTimeMs }
      }

      await release()
      await sleep(pollIntervalMs)
      pollIntervalMs = Math.min(500, Math.ceil(pollIntervalMs * 1.5))
    }

    const error = new Error(
      `Sticky session account concurrency queue expired for ${accountName || accountId}`
    )
    error.code = 'ACCOUNT_CONCURRENCY_QUEUE_TIMEOUT'
    error.statusCode = 503
    error.accountId = accountId
    throw error
  }
}

module.exports = new AccountConcurrencyQueueService()
