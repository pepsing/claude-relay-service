const crypto = require('crypto')
const config = require('../../config/config')
const logger = require('../utils/logger')

const PROVIDER_ACCOUNT_MATCHERS = {
  zhipu: (account) =>
    ['open.bigmodel.cn', 'api.z.ai', 'bigmodel.cn'].includes(getProviderHost(account)),
  kimi: (account) => getProviderHost(account) === 'api.kimi.com',
  volcengine: (account) => /^ark\.[a-z0-9-]+\.volces\.com$/i.test(getProviderHost(account))
}

function normalizeProvider(provider) {
  const normalized = String(provider || '')
    .trim()
    .toLowerCase()
  if (!PROVIDER_ACCOUNT_MATCHERS[normalized]) {
    throw new Error(`Unsupported quota provider: ${provider}`)
  }
  return normalized
}

function getAccountUrl(account = {}) {
  return account.baseApi || account.apiUrl || account.url || ''
}

function getProviderHost(account = {}) {
  try {
    return new URL(getAccountUrl(account)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function getQuotaHostIdentity(provider, account = {}) {
  if (provider === 'zhipu') {
    return 'zhipu-coding'
  }
  if (provider === 'kimi') {
    return 'kimi-coding'
  }
  return getProviderHost(account)
}

function makeAccountRef(accountType, account = {}) {
  return {
    accountType,
    accountId: account.id,
    accountName: account.name || account.id
  }
}

class QuotaIdentityService {
  constructor({ secret = process.env.QUOTA_GROUP_HMAC_KEY || config.security.encryptionKey } = {}) {
    this.secret = String(secret || '')
  }

  buildQuotaGroupId(provider, account = {}) {
    const normalizedProvider = normalizeProvider(provider)
    const apiKey = String(account.apiKey || '').trim()
    if (!apiKey) {
      throw new Error('Quota group identity requires an upstream API key')
    }

    const providerHost = getQuotaHostIdentity(normalizedProvider, account)
    const digest = crypto
      .createHmac('sha256', this.secret)
      .update(`quota-group:v1\0${normalizedProvider}\0${providerHost}\0${apiKey}`)
      .digest('hex')

    return `qg_${digest}`
  }

  isProviderAccount(provider, account = {}) {
    const normalizedProvider = normalizeProvider(provider)
    return PROVIDER_ACCOUNT_MATCHERS[normalizedProvider](account)
  }

  async resolveQuotaContext(provider, accountType, account) {
    const normalizedProvider = normalizeProvider(provider)
    if (!account?.id) {
      throw new Error('Quota context requires an account')
    }

    const quotaGroupId = this.buildQuotaGroupId(normalizedProvider, account)
    const accountRefs = new Map()
    accountRefs.set(`${accountType}:${account.id}`, makeAccountRef(accountType, account))
    const linkedContext = await this.resolveQuotaContextByGroup(normalizedProvider, quotaGroupId)
    for (const ref of linkedContext.accountRefs) {
      accountRefs.set(`${ref.accountType}:${ref.accountId}`, ref)
    }

    return {
      provider: normalizedProvider,
      quotaGroupId,
      accountRefs: Array.from(accountRefs.values()),
      complete: linkedContext.complete
    }
  }

  async resolveQuotaContextByGroup(provider, quotaGroupId) {
    const normalizedProvider = normalizeProvider(provider)
    if (!String(quotaGroupId || '').startsWith('qg_')) {
      throw new Error('A valid quotaGroupId is required')
    }
    const accountRefs = new Map()
    const errors = []
    const accountServices = this._getAccountServices(normalizedProvider)
    for (const candidate of accountServices) {
      try {
        const summaries = await candidate.service.getAllAccounts(true)
        for (const summary of summaries) {
          if (!summary?.id || !candidate.matches(summary)) {
            continue
          }

          try {
            const detailed = await candidate.service.getAccount(summary.id)
            if (
              !detailed?.apiKey ||
              this.buildQuotaGroupId(normalizedProvider, detailed) !== quotaGroupId
            ) {
              continue
            }

            const ref = makeAccountRef(candidate.accountType, detailed)
            accountRefs.set(`${ref.accountType}:${ref.accountId}`, ref)
          } catch (error) {
            errors.push(error)
            logger.warn(
              `⚠️ Failed to inspect linked ${candidate.accountType} quota account ${summary.id}: ${error.message}`
            )
          }
        }
      } catch (error) {
        errors.push(error)
        logger.warn(
          `⚠️ Failed to resolve linked ${candidate.accountType} quota accounts: ${error.message}`
        )
      }
    }

    return {
      provider: normalizedProvider,
      quotaGroupId,
      accountRefs: Array.from(accountRefs.values()),
      complete: errors.length === 0
    }
  }

  _getAccountServices(provider) {
    const claudeConsoleAccountService = require('./account/claudeConsoleAccountService')
    const openaiResponsesAccountService = require('./account/openaiResponsesAccountService')
    const services = [
      {
        accountType: 'claude-console',
        service: claudeConsoleAccountService
      },
      {
        accountType: 'openai-responses',
        service: openaiResponsesAccountService
      }
    ]

    const matcher = PROVIDER_ACCOUNT_MATCHERS[normalizeProvider(provider)]
    return services.map((candidate) => ({
      ...candidate,
      matches: (account) => matcher(account)
    }))
  }
}

const quotaIdentityService = new QuotaIdentityService()

module.exports = quotaIdentityService
module.exports.QuotaIdentityService = QuotaIdentityService
module.exports._private = {
  getAccountUrl,
  getProviderHost,
  getQuotaHostIdentity,
  makeAccountRef,
  normalizeProvider
}
