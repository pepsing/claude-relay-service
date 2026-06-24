const BaseBalanceProvider = require('./baseBalanceProvider')
const claudeConsoleAccountService = require('../account/claudeConsoleAccountService')

class ClaudeConsoleBalanceProvider extends BaseBalanceProvider {
  constructor() {
    super('claude-console')
  }

  supportsAutoQuery(account) {
    return claudeConsoleAccountService.isZhipuCodingPlanAccount(account)
  }

  async queryBalance(account) {
    if (this.supportsAutoQuery(account)) {
      this.logger.debug(`查询智谱 Coding Plan quota: ${account?.id}`)
      const quotaStatus = await claudeConsoleAccountService.fetchZhipuCodingQuota(account)
      return {
        balance: null,
        currency: 'USD',
        quota: quotaStatus.quota,
        queryMethod: 'api',
        rawData: quotaStatus.rawData
      }
    }

    this.logger.debug(`查询 Claude Console 余额（字段）: ${account?.id}`)
    return this.readQuotaFromFields(account)
  }
}

module.exports = ClaudeConsoleBalanceProvider
