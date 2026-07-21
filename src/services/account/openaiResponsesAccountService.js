const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const axios = require('axios')
const ProxyHelper = require('../../utils/proxyHelper')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const config = require('../../../config/config')
const LRUCache = require('../../utils/lruCache')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const {
  getOpenAIProviderEndpointValues,
  normalizeOpenAIProviderEndpoint
} = require('../../utils/openaiProviderEndpoint')
const { normalizeAccountStickySessionMode } = require('../../utils/stickySessionPolicy')

class OpenAIResponsesAccountService {
  constructor() {
    // 加密相关常量
    this.ENCRYPTION_ALGORITHM = 'aes-256-cbc'
    this.ENCRYPTION_SALT = 'openai-responses-salt'

    // Redis 键前缀
    this.ACCOUNT_KEY_PREFIX = 'openai_responses_account:'
    this.SHARED_ACCOUNTS_KEY = 'shared_openai_responses_accounts'

    // 🚀 性能优化：缓存派生的加密密钥，避免每次重复计算
    this._encryptionKeyCache = null

    // 🔄 解密结果缓存，提高解密性能
    this._decryptCache = new LRUCache(500)

    // 🧹 定期清理缓存（每10分钟）
    setInterval(
      () => {
        this._decryptCache.cleanup()
        logger.info(
          '🧹 OpenAI-Responses decrypt cache cleanup completed',
          this._decryptCache.getStats()
        )
      },
      10 * 60 * 1000
    )
  }

  _normalizeMaxConcurrentTasks(value) {
    const concurrent = parseInt(value, 10)
    return Number.isInteger(concurrent) && concurrent > 0 ? concurrent : 0
  }

  _getProviderBaseUrl(accountOrUrl) {
    return typeof accountOrUrl === 'string'
      ? accountOrUrl
      : accountOrUrl?.baseApi || accountOrUrl?.apiUrl || accountOrUrl?.url
  }

  _parseProviderUrl(accountOrUrl) {
    const rawUrl = this._getProviderBaseUrl(accountOrUrl)
    if (!rawUrl || typeof rawUrl !== 'string') {
      return null
    }

    try {
      const parsedUrl = new URL(rawUrl)
      if (parsedUrl.protocol !== 'https:') {
        return null
      }
      return parsedUrl
    } catch {
      return null
    }
  }

  isKimiCodingAccount(accountOrUrl) {
    const parsedUrl = this._parseProviderUrl(accountOrUrl)
    if (!parsedUrl || parsedUrl.hostname.toLowerCase() !== 'api.kimi.com') {
      return false
    }

    const pathname = parsedUrl.pathname.replace(/\/+$/, '').toLowerCase()
    return pathname === '/coding' || pathname.startsWith('/coding/')
  }

  isVolcengineArkCodingAccount(accountOrUrl) {
    const parsedUrl = this._parseProviderUrl(accountOrUrl)
    if (!parsedUrl || !/^ark\.[a-z0-9-]+\.volces\.com$/i.test(parsedUrl.hostname)) {
      return false
    }

    const pathname = parsedUrl.pathname.replace(/\/+$/, '').toLowerCase()
    return pathname === '/api/coding' || pathname.startsWith('/api/coding/')
  }

  isZhipuCodingPlanAccount(accountOrUrl) {
    const parsedUrl = this._parseProviderUrl(accountOrUrl)
    if (!parsedUrl) {
      return false
    }

    const hostname = parsedUrl.hostname.toLowerCase()
    const pathname = parsedUrl.pathname.replace(/\/+$/, '').toLowerCase()
    const knownHost =
      hostname === 'open.bigmodel.cn' || hostname === 'api.z.ai' || hostname === 'bigmodel.cn'

    return knownHost && (pathname === '/api/coding' || pathname.startsWith('/api/coding/'))
  }

  _stringifyProviderError(errorData) {
    if (typeof errorData === 'string') {
      return errorData
    }
    if (Buffer.isBuffer(errorData)) {
      return errorData.toString()
    }

    try {
      return JSON.stringify(errorData || '')
    } catch {
      return String(errorData || '')
    }
  }

  isKimiBillingCycleQuotaError(status, errorData, account) {
    if (Number(status) !== 403 || !this.isKimiCodingAccount(account)) {
      return false
    }

    const errorText = this._stringifyProviderError(errorData).toLowerCase()
    return (
      errorText.includes('billing_cycle_quota') ||
      errorText.includes('usage_limit_reached') ||
      errorText.includes('quota will be refreshed in the next cycle') ||
      (errorText.includes('billing cycle') &&
        (errorText.includes('usage limit') || errorText.includes('quota')))
    )
  }

  _parseVolcengineArkResetTime(errorText) {
    const match = String(errorText || '').match(
      /\breset\s+at\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s+([+-]\d{2}:?\d{2})(?:\s+[A-Z]{2,5})?/i
    )
    if (!match) {
      return null
    }

    const [, datePart, timePart, rawOffset] = match
    const offset = rawOffset.includes(':')
      ? rawOffset
      : `${rawOffset.slice(0, 3)}:${rawOffset.slice(3)}`
    const resetAt = new Date(`${datePart}T${timePart}${offset}`)
    if (Number.isNaN(resetAt.getTime())) {
      return null
    }

    return {
      resetAt: resetAt.toISOString(),
      resetAtText: match[0].replace(/^reset\s+at\s+/i, '')
    }
  }

  getVolcengineArkMonthlyQuotaError(status, errorData, account) {
    if (Number(status) !== 429 || !this.isVolcengineArkCodingAccount(account)) {
      return null
    }

    const errorText = this._stringifyProviderError(errorData)
    const normalizedText = errorText.toLowerCase()
    if (
      !normalizedText.includes('monthly usage quota') &&
      !(normalizedText.includes('monthly') && normalizedText.includes('quota'))
    ) {
      return null
    }

    return this._parseVolcengineArkResetTime(errorText)
  }

  _toFiniteNumber(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  _parseOptionalJson(value) {
    if (!value) {
      return null
    }
    if (typeof value === 'object') {
      return value
    }
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  _timestampToIso(value) {
    if (value === undefined || value === null || value === '') {
      return null
    }

    const numeric = Number(value)
    const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  _normalizeZhipuLimit(limit = {}, index = 0) {
    const type = String(limit.type || '').toUpperCase()
    const percentage = this._toFiniteNumber(limit.percentage)
    const usage = this._toFiniteNumber(limit.usage ?? limit.total ?? limit.limit)
    const currentValue = this._toFiniteNumber(limit.currentValue ?? limit.used)
    const remainingValue = this._toFiniteNumber(limit.remaining)
    const unit = this._toFiniteNumber(limit.unit)
    const number = this._toFiniteNumber(limit.number)
    const hasAbsoluteQuota = usage !== null || currentValue !== null || remainingValue !== null
    const total = usage !== null ? usage : 100
    const used =
      currentValue !== null
        ? currentValue
        : percentage !== null
          ? hasAbsoluteQuota && usage !== null
            ? (usage * percentage) / 100
            : percentage
          : remainingValue !== null && usage !== null
            ? Math.max(0, usage - remainingValue)
            : null
    const remaining =
      remainingValue !== null ? remainingValue : used !== null ? Math.max(0, total - used) : null

    let windowType = null
    let label = limit.name || limit.label || ''
    if (type === 'TOKENS_LIMIT') {
      if (unit === 3 && number === 5) {
        windowType = 'five_hour'
        label = label || '5小时额度'
      } else if (unit === 6) {
        windowType = 'weekly'
        label = label || '每周额度'
      } else {
        windowType = 'tokens'
      }
    } else if (type === 'TIME_LIMIT') {
      windowType = 'mcp_monthly'
      label = label || 'MCP每月'
    }

    return {
      type,
      windowType,
      label,
      percentage: percentage === null ? null : Math.max(0, percentage),
      total,
      used,
      remaining,
      unit: hasAbsoluteQuota ? limit.displayUnit || 'tokens' : '%',
      rawUnit: unit,
      number,
      resetAt: this._timestampToIso(
        limit.nextResetTime || limit.resetAt || limit.resetTime || limit.next_reset_time
      ),
      index
    }
  }

  _isZhipuBucketExhausted(bucket) {
    return (
      bucket?.type === 'TOKENS_LIMIT' &&
      ((bucket.percentage !== null && bucket.percentage >= 100) ||
        (bucket.remaining !== null && bucket.remaining <= 0))
    )
  }

  normalizeZhipuCodingQuotaData(responseData) {
    const payload = typeof responseData === 'string' ? JSON.parse(responseData) : responseData
    const data = payload?.data || payload
    const limits = Array.isArray(data?.limits) ? data.limits : []
    if (!data || limits.length === 0) {
      const error = new Error(payload?.msg || payload?.message || '智谱 quota 响应缺少 limits')
      error.code = 'ZHIPU_QUOTA_INVALID_RESPONSE'
      throw error
    }

    const buckets = limits.map((limit, index) => this._normalizeZhipuLimit(limit, index))
    const tokenBuckets = buckets
      .filter((bucket) => bucket.type === 'TOKENS_LIMIT')
      .sort((a, b) => {
        const rank = { five_hour: 0, tokens: 1, weekly: 2 }
        return (rank[a.windowType] ?? 9) - (rank[b.windowType] ?? 9) || a.index - b.index
      })

    tokenBuckets.forEach((bucket, index) => {
      if (bucket.windowType === 'tokens') {
        bucket.windowType = index === 0 ? 'five_hour' : index === 1 ? 'weekly' : 'tokens'
      }
      bucket.label = bucket.label || (bucket.windowType === 'weekly' ? '每周额度' : '5小时额度')
    })

    const exhaustedBuckets = tokenBuckets.filter((bucket) => this._isZhipuBucketExhausted(bucket))
    const resetTimes = exhaustedBuckets
      .map((bucket) => (bucket.resetAt ? new Date(bucket.resetAt).getTime() : null))
      .filter((time) => Number.isFinite(time))
    const primaryBucket = tokenBuckets[0] || buckets[0]
    const nextResetAt =
      resetTimes.length > 0
        ? new Date(Math.max(...resetTimes)).toISOString()
        : primaryBucket?.resetAt || null
    const level =
      data.level || data.planName || data.plan || data.plan_type || data.packageName || 'unknown'

    return {
      type: 'zhipu-coding-plan',
      level,
      exhausted: exhaustedBuckets.length > 0,
      nextResetAt,
      quota: {
        type: 'zhipu-coding-plan',
        planName: level,
        used: primaryBucket?.used ?? primaryBucket?.percentage ?? null,
        remaining: primaryBucket?.remaining ?? null,
        total: primaryBucket?.total ?? null,
        percentage: primaryBucket?.percentage ?? null,
        resetAt: primaryBucket?.resetAt || nextResetAt,
        buckets
      },
      buckets,
      exhaustedBuckets
    }
  }

  _compactZhipuQuotaStatus(quotaStatus) {
    if (!quotaStatus) {
      return null
    }
    return {
      type: quotaStatus.type,
      level: quotaStatus.level,
      exhausted: quotaStatus.exhausted,
      nextResetAt: quotaStatus.nextResetAt,
      quota: quotaStatus.quota,
      buckets: quotaStatus.buckets
    }
  }

  async fetchZhipuCodingQuota(accountOrId) {
    const account =
      typeof accountOrId === 'string' ? await this.getAccount(accountOrId) : accountOrId
    if (!account || !this.isZhipuCodingPlanAccount(account)) {
      const error = new Error('Not an OpenAI-compatible Zhipu Coding Plan account')
      error.code = 'NOT_ZHIPU_CODING_PLAN'
      throw error
    }
    if (!account.apiKey) {
      const error = new Error('Zhipu Coding Plan account apiKey is empty')
      error.code = 'ZHIPU_QUOTA_MISSING_API_KEY'
      throw error
    }

    const parsedUrl = this._parseProviderUrl(account)
    const quotaUrl = `${parsedUrl.origin}/api/monitor/usage/quota/limit`
    const proxyAgent = account.proxy ? ProxyHelper.createProxyAgent(account.proxy) : null
    const token = String(account.apiKey).trim()
    const requestQuota = async (useRawToken = false) => {
      const authorization =
        useRawToken || /^(bearer|basic)\s+/i.test(token) ? token : `Bearer ${token}`
      const requestConfig = {
        method: 'GET',
        url: quotaUrl,
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          'Accept-Language': 'en-US,en',
          'Content-Type': 'application/json'
        },
        timeout: 15000,
        validateStatus: () => true
      }
      if (proxyAgent) {
        requestConfig.httpAgent = proxyAgent
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
      }
      return axios(requestConfig)
    }

    let response = await requestQuota(false)
    if (
      (response.status === 401 || response.status === 403) &&
      !/^(bearer|basic)\s+/i.test(token)
    ) {
      response = await requestQuota(true)
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(
        response.data?.msg ||
          response.data?.message ||
          `智谱 quota API 返回 HTTP ${response.status}`
      )
      error.code = 'ZHIPU_QUOTA_HTTP_ERROR'
      error.status = response.status
      throw error
    }

    return this.normalizeZhipuCodingQuotaData(response.data)
  }

  async _cacheZhipuCodingQuota(accountId, quotaStatus) {
    if (!quotaStatus?.quota) {
      return
    }
    const ttl = Math.max(60, parseInt(process.env.ZHIPU_CODING_QUOTA_CACHE_TTL_SECONDS) || 300)
    await redis.setAccountBalance(
      'openai-responses',
      accountId,
      {
        balance: null,
        currency: 'USD',
        quota: quotaStatus.quota,
        queryMethod: 'api',
        status: 'success',
        rawData: this._compactZhipuQuotaStatus(quotaStatus),
        lastRefreshAt: new Date().toISOString()
      },
      ttl
    )
  }

  async markKimiBillingCycleQuotaExceeded(accountId, errorDetails = '') {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    const now = new Date().toISOString()
    await this.updateAccount(accountId, {
      status: 'quota_exceeded',
      schedulable: 'false',
      errorMessage: 'Kimi Code billing cycle quota exhausted (403), scheduling suspended',
      kimiBillingCycleQuotaStoppedAt: now,
      updatedAt: now
    })
    upstreamErrorHelper
      .recordErrorHistory(accountId, 'openai-responses', 403, 'quota_exceeded')
      .catch(() => {})

    try {
      const webhookNotifier = require('../../utils/webhookNotifier')
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId,
        accountName: account.name || 'OpenAI Responses Account',
        platform: 'openai-responses',
        status: 'quota_exceeded',
        errorCode: 'KIMI_BILLING_CYCLE_QUOTA_EXCEEDED',
        reason:
          'Kimi Code billing cycle quota exhausted (403). Account scheduling has been suspended.',
        details: this._stringifyProviderError(errorDetails).substring(0, 500)
      })
    } catch (webhookError) {
      logger.error('Failed to send Kimi billing cycle quota webhook notification:', webhookError)
    }

    logger.warn(
      `🚫 Kimi Code OpenAI-compatible account marked as quota exceeded: ${account.name} (${accountId})`
    )
    return { success: true }
  }

  async markVolcengineArkMonthlyQuotaExceeded(accountId, options = {}) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    const resetAt = new Date(options.resetAt)
    if (Number.isNaN(resetAt.getTime())) {
      throw new Error('Valid resetAt is required')
    }

    const now = new Date().toISOString()
    const resetAtIso = resetAt.toISOString()
    const resetAtText = options.resetAtText || resetAtIso
    const updates = {
      status: 'rate_limited',
      rateLimitedAt: now,
      rateLimitStatus: 'limited',
      rateLimitResetAt: resetAtIso,
      rateLimitAutoStopped: 'true',
      schedulable: 'false',
      errorMessage: `Volcengine Ark monthly usage quota exhausted (429). Reset at ${resetAtText}`,
      updatedAt: now
    }
    await this.updateAccount(accountId, updates)
    upstreamErrorHelper
      .recordErrorHistory(accountId, 'openai-responses', 429, 'monthly_quota_exceeded')
      .catch(() => {})

    try {
      const webhookNotifier = require('../../utils/webhookNotifier')
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId,
        accountName: account.name || 'OpenAI Responses Account',
        platform: 'openai-responses',
        status: 'rate_limited',
        errorCode: 'VOLCENGINE_ARK_MONTHLY_QUOTA_EXCEEDED',
        reason: updates.errorMessage,
        details: this._stringifyProviderError(options.errorDetails).substring(0, 500)
      })
    } catch (webhookError) {
      logger.error(
        'Failed to send Volcengine Ark monthly quota webhook notification:',
        webhookError
      )
    }

    logger.warn(
      `🚫 Volcengine Ark OpenAI-compatible account monthly quota exhausted: ${account.name} (${accountId}), reset at ${resetAtIso}`
    )
    return { success: true, resetAt: resetAtIso }
  }

  async markZhipuCodingQuotaExceeded(accountId, quotaStatus, errorDetails = '') {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    const now = new Date().toISOString()
    const alreadyStopped =
      account.zhipuCodingQuotaAutoStopped === true ||
      account.zhipuCodingQuotaAutoStopped === 'true' ||
      !!account.zhipuCodingQuotaStoppedAt
    const exhaustedLabels = (quotaStatus?.exhaustedBuckets || [])
      .map((bucket) => bucket.label)
      .filter(Boolean)
    const reason =
      exhaustedLabels.length > 0
        ? `Zhipu Coding Plan quota exhausted: ${exhaustedLabels.join(', ')}`
        : 'Zhipu Coding Plan quota exhausted'
    const updates = {
      status: 'quota_exceeded',
      schedulable: 'false',
      errorMessage: quotaStatus?.nextResetAt
        ? `${reason}. Reset at ${quotaStatus.nextResetAt}`
        : `${reason}. Waiting for quota API recovery`,
      zhipuCodingQuotaStoppedAt: account.zhipuCodingQuotaStoppedAt || now,
      zhipuCodingQuotaNextResetAt: quotaStatus?.nextResetAt || '',
      zhipuCodingQuotaAutoStopped: 'true',
      zhipuCodingQuotaStatus: JSON.stringify(this._compactZhipuQuotaStatus(quotaStatus) || {}),
      updatedAt: now
    }
    await this.updateAccount(accountId, updates)
    await this._cacheZhipuCodingQuota(accountId, quotaStatus).catch(() => {})

    if (!alreadyStopped) {
      try {
        const webhookNotifier = require('../../utils/webhookNotifier')
        await webhookNotifier.sendAccountAnomalyNotification({
          accountId,
          accountName: account.name || 'OpenAI Responses Account',
          platform: 'openai-responses',
          status: 'quota_exceeded',
          errorCode: 'ZHIPU_CODING_PLAN_QUOTA_EXCEEDED',
          reason: updates.errorMessage,
          details: this._stringifyProviderError(errorDetails).substring(0, 500)
        })
      } catch (webhookError) {
        logger.error('Failed to send Zhipu quota webhook notification:', webhookError)
      }
    }

    return { success: true, skipped: alreadyStopped }
  }

  async recoverZhipuCodingQuotaExceeded(accountId, quotaStatus = null) {
    const account = await this.getAccount(accountId)
    if (!account) {
      return { success: false, reason: 'Account not found' }
    }

    const updates = {
      errorMessage: '',
      zhipuCodingQuotaStoppedAt: '',
      zhipuCodingQuotaNextResetAt: '',
      zhipuCodingQuotaAutoStopped: '',
      zhipuCodingQuotaStatus: quotaStatus
        ? JSON.stringify(this._compactZhipuQuotaStatus(quotaStatus) || {})
        : '',
      updatedAt: new Date().toISOString()
    }
    if (account.status === 'quota_exceeded') {
      updates.status = 'active'
    }
    if (
      (account.zhipuCodingQuotaAutoStopped === true ||
        account.zhipuCodingQuotaAutoStopped === 'true') &&
      (account.schedulable === false || account.schedulable === 'false')
    ) {
      updates.schedulable = 'true'
    }
    await this.updateAccount(accountId, updates)
    if (quotaStatus) {
      await this._cacheZhipuCodingQuota(accountId, quotaStatus).catch(() => {})
    }
    return { success: true }
  }

  async refreshZhipuCodingQuotaProtection(accountId, options = {}) {
    const account = options.account?.apiKey ? options.account : await this.getAccount(accountId)
    if (!account || !this.isZhipuCodingPlanAccount(account)) {
      return { checked: false, skipped: true, reason: 'not_zhipu_coding_plan' }
    }

    const quotaStatus = await this.fetchZhipuCodingQuota(account)
    await this._cacheZhipuCodingQuota(accountId, quotaStatus).catch(() => {})
    const autoStopped =
      account.zhipuCodingQuotaAutoStopped === true ||
      account.zhipuCodingQuotaAutoStopped === 'true' ||
      !!account.zhipuCodingQuotaStoppedAt

    if (quotaStatus.exhausted) {
      const result = await this.markZhipuCodingQuotaExceeded(
        accountId,
        quotaStatus,
        options.errorDetails || ''
      )
      return {
        checked: true,
        exhausted: true,
        suspended: !result.skipped,
        quotaStatus
      }
    }
    if (autoStopped || account.status === 'quota_exceeded') {
      await this.recoverZhipuCodingQuotaExceeded(accountId, quotaStatus)
      return { checked: true, exhausted: false, recovered: true, quotaStatus }
    }
    return { checked: true, exhausted: false, quotaStatus }
  }

  async handleProviderQuotaError(accountId, options = {}) {
    const account =
      options.account?.apiKey && options.account.apiKey !== '***'
        ? options.account
        : await this.getAccount(accountId)
    if (!account) {
      return { handled: false }
    }

    const status = Number(options.status)
    const errorData = options.errorData
    if (this.isKimiBillingCycleQuotaError(status, errorData, account)) {
      await this.markKimiBillingCycleQuotaExceeded(accountId, errorData)
      return { handled: true, provider: 'kimi', quotaType: 'billing_cycle' }
    }

    const volcengineQuota = this.getVolcengineArkMonthlyQuotaError(status, errorData, account)
    if (volcengineQuota) {
      await this.markVolcengineArkMonthlyQuotaExceeded(accountId, {
        ...volcengineQuota,
        errorDetails: errorData
      })
      return {
        handled: true,
        provider: 'volcengine',
        quotaType: 'monthly',
        resetAt: volcengineQuota.resetAt
      }
    }

    if ([400, 403, 429].includes(status) && this.isZhipuCodingPlanAccount(account)) {
      try {
        const result = await this.refreshZhipuCodingQuotaProtection(accountId, {
          account,
          errorDetails: this._stringifyProviderError(errorData)
        })
        if (result.exhausted) {
          return {
            handled: true,
            provider: 'zhipu',
            quotaType: 'coding_plan',
            resetAt: result.quotaStatus?.nextResetAt || null
          }
        }
      } catch (error) {
        logger.warn(`⚠️ Failed to check Zhipu Coding Plan quota for ${accountId}: ${error.message}`)
      }
    }

    return { handled: false }
  }

  async checkAllZhipuCodingQuotaAccounts() {
    const result = { checked: 0, suspended: 0, recovered: 0, errors: [], accounts: [] }
    const accounts = await this.getAllAccounts(true)
    for (const account of accounts) {
      if (!this.isZhipuCodingPlanAccount(account)) {
        continue
      }
      const autoStopped =
        account.zhipuCodingQuotaAutoStopped === true ||
        account.zhipuCodingQuotaAutoStopped === 'true' ||
        !!account.zhipuCodingQuotaStoppedAt
      const shouldCheck =
        account.isActive !== false &&
        (account.schedulable !== false || autoStopped || account.status === 'quota_exceeded')
      if (!shouldCheck) {
        continue
      }

      result.checked += 1
      try {
        const update = await this.refreshZhipuCodingQuotaProtection(account.id)
        if (update.suspended) {
          result.suspended += 1
        }
        if (update.recovered) {
          result.recovered += 1
          result.accounts.push({
            id: account.id,
            name: account.name,
            quotaStatus: update.quotaStatus
          })
        }
      } catch (error) {
        result.errors.push({
          accountId: account.id,
          accountName: account.name,
          error: error.message
        })
      }
    }
    return result
  }

  // 创建账户
  async createAccount(options = {}) {
    const {
      name = 'OpenAI Responses Account',
      description = '',
      baseApi = '', // 必填：API 基础地址
      apiKey = '', // 必填：API 密钥
      userAgent = '', // 可选：自定义 User-Agent，空则透传原始请求
      priority = 50, // 调度优先级 (1-100)
      proxy = null,
      isActive = true,
      accountType = 'shared', // 'dedicated' or 'shared'
      schedulable = true, // 是否可被调度
      supportedModels = {}, // 模型白名单/映射表，空对象表示支持所有模型
      modelRestrictionMode = 'mapping',
      dailyQuota = 0, // 每日额度限制（美元），0表示不限制
      quotaResetTime = '00:00', // 额度重置时间（HH:mm格式）
      maxConcurrentTasks = 0, // 最大并发任务数，0表示无限制
      rateLimitDuration = 60, // 限流时间（分钟）
      disableAutoProtection = false, // 是否关闭自动防护（429/401/400/529 不自动禁用）
      providerEndpoint = 'responses', // Provider 端点类型：responses | chat-completions | auto
      stickySessionMode = 'inherit' // inherit | off | fallback
    } = options

    // 验证必填字段
    if (!baseApi || !apiKey) {
      throw new Error('Base API URL and API Key are required for OpenAI-Responses account')
    }

    // 验证 providerEndpoint 枚举值
    const normalizedProviderEndpoint = normalizeOpenAIProviderEndpoint(providerEndpoint)
    if (!normalizedProviderEndpoint) {
      const validEndpoints = getOpenAIProviderEndpointValues()
      throw new Error(
        `Invalid providerEndpoint: ${providerEndpoint}. Must be one of: ${validEndpoints.join(', ')}`
      )
    }

    // 规范化 baseApi（确保不以 / 结尾）
    const normalizedBaseApi = baseApi.endsWith('/') ? baseApi.slice(0, -1) : baseApi
    const normalizedModelRestrictionMode = this._normalizeModelRestrictionMode(modelRestrictionMode)
    const processedModels = this._processModelMapping(
      supportedModels,
      normalizedModelRestrictionMode
    )

    const accountId = uuidv4()

    const accountData = {
      id: accountId,
      platform: 'openai-responses',
      name,
      description,
      baseApi: normalizedBaseApi,
      apiKey: this._encryptSensitiveData(apiKey),
      userAgent,
      priority: priority.toString(),
      supportedModels: JSON.stringify(processedModels),
      modelRestrictionMode: normalizedModelRestrictionMode,
      proxy: proxy ? JSON.stringify(proxy) : '',
      isActive: isActive.toString(),
      accountType,
      schedulable: schedulable.toString(),

      // ✅ 新增：账户订阅到期时间（业务字段，手动管理）
      // 注意：OpenAI-Responses 使用 API Key 认证，没有 OAuth token，因此没有 expiresAt
      subscriptionExpiresAt: options.subscriptionExpiresAt || null,

      createdAt: new Date().toISOString(),
      lastUsedAt: '',
      status: 'active',
      errorMessage: '',
      // 限流相关
      rateLimitedAt: '',
      rateLimitStatus: '',
      rateLimitDuration: rateLimitDuration.toString(),
      // 额度管理
      dailyQuota: dailyQuota.toString(),
      dailyUsage: '0',
      lastResetDate: redis.getDateStringInTimezone(),
      quotaResetTime,
      quotaStoppedAt: '',
      kimiBillingCycleQuotaStoppedAt: '',
      zhipuCodingQuotaStoppedAt: '',
      zhipuCodingQuotaNextResetAt: '',
      zhipuCodingQuotaAutoStopped: '',
      zhipuCodingQuotaStatus: '',
      maxConcurrentTasks: this._normalizeMaxConcurrentTasks(maxConcurrentTasks).toString(),
      disableAutoProtection: disableAutoProtection.toString(), // 关闭自动防护
      providerEndpoint: normalizedProviderEndpoint, // Provider 端点类型：responses(默认) | chat-completions | auto
      stickySessionMode: normalizeAccountStickySessionMode(stickySessionMode)
    }

    // 保存到 Redis
    await this._saveAccount(accountId, accountData)

    logger.success(`Created OpenAI-Responses account: ${name} (${accountId})`)

    return {
      ...accountData,
      apiKey: '***' // 返回时隐藏敏感信息
    }
  }

  // 获取账户
  async getAccount(accountId) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`
    const accountData = await client.hgetall(key)

    if (!accountData || !accountData.id) {
      return null
    }

    // 解密敏感数据
    accountData.apiKey = this._decryptSensitiveData(accountData.apiKey)

    // 解析 JSON 字段
    if (accountData.proxy) {
      try {
        accountData.proxy = JSON.parse(accountData.proxy)
      } catch (e) {
        accountData.proxy = null
      }
    }

    accountData.maxConcurrentTasks = this._normalizeMaxConcurrentTasks(
      accountData.maxConcurrentTasks
    )
    accountData.supportedModels = this._parseSupportedModels(accountData.supportedModels)
    accountData.modelRestrictionMode = this._normalizeModelRestrictionMode(
      accountData.modelRestrictionMode
    )
    accountData.stickySessionMode = normalizeAccountStickySessionMode(accountData.stickySessionMode)
    accountData.isZhipuCodingPlan = this.isZhipuCodingPlanAccount(accountData)
    accountData.zhipuCodingQuotaAutoStopped = accountData.zhipuCodingQuotaAutoStopped === 'true'
    accountData.zhipuCodingQuotaStatus = this._parseOptionalJson(accountData.zhipuCodingQuotaStatus)

    return accountData
  }

  // 更新账户
  async updateAccount(accountId, updates) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    // 处理敏感字段加密
    if (updates.apiKey) {
      updates.apiKey = this._encryptSensitiveData(updates.apiKey)
    }

    // 处理 JSON 字段
    if (updates.proxy !== undefined) {
      updates.proxy = updates.proxy ? JSON.stringify(updates.proxy) : ''
    }

    if (updates.modelRestrictionMode !== undefined) {
      updates.modelRestrictionMode = this._normalizeModelRestrictionMode(
        updates.modelRestrictionMode
      )
    }

    if (updates.supportedModels !== undefined) {
      updates.supportedModels = JSON.stringify(
        this._processModelMapping(
          updates.supportedModels,
          updates.modelRestrictionMode || account.modelRestrictionMode || 'mapping'
        )
      )
    }

    // 规范化 baseApi
    if (updates.baseApi) {
      updates.baseApi = updates.baseApi.endsWith('/')
        ? updates.baseApi.slice(0, -1)
        : updates.baseApi
    }

    // ✅ 直接保存 subscriptionExpiresAt（如果提供）
    // OpenAI-Responses 使用 API Key，没有 token 刷新逻辑，不会覆盖此字段
    if (updates.subscriptionExpiresAt !== undefined) {
      // 直接保存，不做任何调整
    }

    // 验证 providerEndpoint 枚举值
    if (updates.providerEndpoint !== undefined) {
      const normalizedProviderEndpoint = normalizeOpenAIProviderEndpoint(updates.providerEndpoint)
      if (!normalizedProviderEndpoint) {
        const validEndpoints = getOpenAIProviderEndpointValues()
        throw new Error(
          `Invalid providerEndpoint: ${updates.providerEndpoint}. Must be one of: ${validEndpoints.join(', ')}`
        )
      }
      updates.providerEndpoint = normalizedProviderEndpoint
    }

    // 自动防护开关
    if (updates.disableAutoProtection !== undefined) {
      updates.disableAutoProtection = updates.disableAutoProtection.toString()
    }

    if (updates.maxConcurrentTasks !== undefined) {
      updates.maxConcurrentTasks = this._normalizeMaxConcurrentTasks(
        updates.maxConcurrentTasks
      ).toString()
    }

    if (updates.stickySessionMode !== undefined) {
      updates.stickySessionMode = normalizeAccountStickySessionMode(updates.stickySessionMode)
    }

    // 更新 Redis
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`
    await client.hset(key, updates)

    logger.info(`📝 Updated OpenAI-Responses account: ${account.name}`)

    return { success: true }
  }

  // 删除账户
  async deleteAccount(accountId) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`

    // 从共享账户列表中移除
    await client.srem(this.SHARED_ACCOUNTS_KEY, accountId)

    // 从索引中移除
    await redis.removeFromIndex('openai_responses_account:index', accountId)

    // 删除账户数据
    await client.del(key)

    logger.info(`🗑️ Deleted OpenAI-Responses account: ${accountId}`)

    return { success: true }
  }

  // 获取所有账户
  async getAllAccounts(includeInactive = false) {
    const client = redis.getClientSafe()

    // 使用索引获取所有账户ID
    const accountIds = await redis.getAllIdsByIndex(
      'openai_responses_account:index',
      `${this.ACCOUNT_KEY_PREFIX}*`,
      /^openai_responses_account:(.+)$/
    )
    if (accountIds.length === 0) {
      return []
    }

    const keys = accountIds.map((id) => `${this.ACCOUNT_KEY_PREFIX}${id}`)
    // Pipeline 批量查询所有账户数据
    const pipeline = client.pipeline()
    keys.forEach((key) => pipeline.hgetall(key))
    const results = await pipeline.exec()

    const accounts = []
    for (const [err, accountData] of results) {
      if (err || !accountData || !accountData.id) {
        continue
      }

      // 过滤非活跃账户
      if (!includeInactive && accountData.isActive !== 'true') {
        continue
      }

      // 隐藏敏感信息
      accountData.apiKey = '***'
      accountData.maxConcurrentTasks = this._normalizeMaxConcurrentTasks(
        accountData.maxConcurrentTasks
      )
      accountData.supportedModels = this._parseSupportedModels(accountData.supportedModels)
      accountData.modelRestrictionMode = this._normalizeModelRestrictionMode(
        accountData.modelRestrictionMode
      )
      accountData.activeTaskCount = await redis.getConcurrency(
        `openai_responses_account:${accountData.id}`
      )

      // 解析 JSON 字段
      if (accountData.proxy) {
        try {
          accountData.proxy = JSON.parse(accountData.proxy)
        } catch {
          accountData.proxy = null
        }
      }

      // 获取限流状态信息
      const rateLimitInfo = this._getRateLimitInfo(accountData)
      accountData.rateLimitStatus = rateLimitInfo.isRateLimited
        ? {
            isRateLimited: true,
            rateLimitedAt: accountData.rateLimitedAt || null,
            minutesRemaining: rateLimitInfo.remainingMinutes || 0
          }
        : {
            isRateLimited: false,
            rateLimitedAt: null,
            minutesRemaining: 0
          }

      // 转换字段类型
      accountData.schedulable = accountData.schedulable !== 'false'
      accountData.isActive = accountData.isActive === 'true'
      accountData.expiresAt = accountData.subscriptionExpiresAt || null
      accountData.platform = accountData.platform || 'openai-responses'
      accountData.stickySessionMode = normalizeAccountStickySessionMode(
        accountData.stickySessionMode
      )
      accountData.isZhipuCodingPlan = this.isZhipuCodingPlanAccount(accountData)
      accountData.zhipuCodingQuotaAutoStopped = accountData.zhipuCodingQuotaAutoStopped === 'true'
      accountData.zhipuCodingQuotaStatus = this._parseOptionalJson(
        accountData.zhipuCodingQuotaStatus
      )

      accounts.push(accountData)
    }

    return accounts
  }

  // 标记账户限流
  async markAccountRateLimited(accountId, duration = null) {
    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }

    // disableAutoProtection 检查
    if (account.disableAutoProtection === true || account.disableAutoProtection === 'true') {
      logger.info(
        `🛡️ Account ${accountId} has auto-protection disabled, skipping markAccountRateLimited`
      )
      upstreamErrorHelper
        .recordErrorHistory(accountId, 'openai-responses', 429, 'rate_limit')
        .catch(() => {})
      return
    }

    const rateLimitDuration = duration || parseInt(account.rateLimitDuration) || 60
    const now = new Date()
    const resetAt = new Date(now.getTime() + rateLimitDuration * 60000)

    await this.updateAccount(accountId, {
      rateLimitedAt: now.toISOString(),
      rateLimitStatus: 'limited',
      rateLimitResetAt: resetAt.toISOString(),
      rateLimitDuration: rateLimitDuration.toString(),
      status: 'rateLimited',
      schedulable: 'false', // 防止被调度
      errorMessage: `Rate limited until ${resetAt.toISOString()}`
    })

    logger.warn(
      `⏳ Account ${account.name} marked as rate limited for ${rateLimitDuration} minutes (until ${resetAt.toISOString()})`
    )
  }

  // 🚫 标记账户为未授权状态（401错误）
  async markAccountUnauthorized(accountId, reason = 'OpenAI Responses账号认证失败（401错误）') {
    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }

    // disableAutoProtection 检查
    if (account.disableAutoProtection === true || account.disableAutoProtection === 'true') {
      logger.info(
        `🛡️ Account ${accountId} has auto-protection disabled, skipping markAccountUnauthorized`
      )
      upstreamErrorHelper
        .recordErrorHistory(accountId, 'openai-responses', 401, 'auth_error')
        .catch(() => {})
      return
    }

    const now = new Date().toISOString()
    const currentCount = parseInt(account.unauthorizedCount || '0', 10)
    const unauthorizedCount = Number.isFinite(currentCount) ? currentCount + 1 : 1

    await this.updateAccount(accountId, {
      status: 'unauthorized',
      schedulable: 'false',
      errorMessage: reason,
      unauthorizedAt: now,
      unauthorizedCount: unauthorizedCount.toString()
    })

    logger.warn(
      `🚫 OpenAI-Responses account ${account.name || accountId} marked as unauthorized due to 401 error`
    )

    try {
      const webhookNotifier = require('../../utils/webhookNotifier')
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId,
        accountName: account.name || accountId,
        platform: 'openai',
        status: 'unauthorized',
        errorCode: 'OPENAI_UNAUTHORIZED',
        reason,
        timestamp: now
      })
      logger.info(
        `📢 Webhook notification sent for OpenAI-Responses account ${account.name || accountId} unauthorized state`
      )
    } catch (webhookError) {
      logger.error('Failed to send unauthorized webhook notification:', webhookError)
    }
  }

  // 检查并清除过期的限流状态
  async checkAndClearRateLimit(accountId) {
    const account = await this.getAccount(accountId)
    if (!account || account.rateLimitStatus !== 'limited') {
      return false
    }

    const now = new Date()
    let shouldClear = false

    // 优先使用 rateLimitResetAt 字段
    if (account.rateLimitResetAt) {
      const resetAt = new Date(account.rateLimitResetAt)
      shouldClear = now >= resetAt
    } else {
      // 如果没有 rateLimitResetAt，使用旧的逻辑
      const rateLimitedAt = new Date(account.rateLimitedAt)
      const rateLimitDuration = parseInt(account.rateLimitDuration) || 60
      shouldClear = now - rateLimitedAt > rateLimitDuration * 60000
    }

    if (shouldClear) {
      // 限流已过期，清除状态
      await this.updateAccount(accountId, {
        rateLimitedAt: '',
        rateLimitStatus: '',
        rateLimitResetAt: '',
        rateLimitAutoStopped: '',
        status: 'active',
        schedulable: 'true', // 恢复调度
        errorMessage: ''
      })

      logger.info(`✅ Rate limit cleared for account ${account.name}`)
      return true
    }

    return false
  }

  // 切换调度状态
  async toggleSchedulable(accountId) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    const newSchedulableStatus = account.schedulable === 'true' ? 'false' : 'true'
    await this.updateAccount(accountId, {
      schedulable: newSchedulableStatus
    })

    logger.info(
      `🔄 Toggled schedulable status for account ${account.name}: ${newSchedulableStatus}`
    )

    return {
      success: true,
      schedulable: newSchedulableStatus === 'true'
    }
  }

  // 更新使用额度
  async updateUsageQuota(accountId, amount) {
    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }

    // 检查是否需要重置额度
    const today = redis.getDateStringInTimezone()
    if (account.lastResetDate !== today) {
      // 重置额度
      await this.updateAccount(accountId, {
        dailyUsage: amount.toString(),
        lastResetDate: today,
        quotaStoppedAt: ''
      })
    } else {
      // 累加使用额度
      const currentUsage = parseFloat(account.dailyUsage) || 0
      const newUsage = currentUsage + amount
      const dailyQuota = parseFloat(account.dailyQuota) || 0

      const updates = {
        dailyUsage: newUsage.toString()
      }

      // 检查是否超出额度
      if (dailyQuota > 0 && newUsage >= dailyQuota) {
        updates.status = 'quotaExceeded'
        updates.quotaStoppedAt = new Date().toISOString()
        updates.errorMessage = `Daily quota exceeded: $${newUsage.toFixed(2)} / $${dailyQuota.toFixed(2)}`
        logger.warn(`💸 Account ${account.name} exceeded daily quota`)
      }

      await this.updateAccount(accountId, updates)
    }
  }

  // 更新账户使用统计（记录 token 使用量）
  async updateAccountUsage(accountId, tokens = 0) {
    const account = await this.getAccount(accountId)
    if (!account) {
      return
    }

    const updates = {
      lastUsedAt: new Date().toISOString()
    }

    // 如果有 tokens 参数且大于0，同时更新使用统计
    if (tokens > 0) {
      const currentTokens = parseInt(account.totalUsedTokens) || 0
      updates.totalUsedTokens = (currentTokens + tokens).toString()
    }

    await this.updateAccount(accountId, updates)
  }

  // 记录使用量（为了兼容性的别名）
  async recordUsage(accountId, tokens = 0) {
    return this.updateAccountUsage(accountId, tokens)
  }

  // 重置账户状态（清除所有异常状态）
  async resetAccountStatus(accountId) {
    const account = await this.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    const updates = {
      // 根据是否有有效的 apiKey 来设置 status
      status: account.apiKey ? 'active' : 'created',
      // 恢复可调度状态
      schedulable: 'true',
      // 清除错误相关字段
      errorMessage: '',
      rateLimitedAt: '',
      rateLimitStatus: '',
      rateLimitResetAt: '',
      rateLimitDuration: '',
      rateLimitAutoStopped: '',
      quotaStoppedAt: '',
      kimiBillingCycleQuotaStoppedAt: '',
      zhipuCodingQuotaStoppedAt: '',
      zhipuCodingQuotaNextResetAt: '',
      zhipuCodingQuotaAutoStopped: '',
      zhipuCodingQuotaStatus: ''
    }

    await this.updateAccount(accountId, updates)
    logger.info(`✅ Reset all error status for OpenAI-Responses account ${accountId}`)

    // 清除临时不可用状态
    await upstreamErrorHelper.clearTempUnavailable(accountId, 'openai-responses').catch(() => {})

    // 发送 Webhook 通知
    try {
      const webhookNotifier = require('../../utils/webhookNotifier')
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId,
        accountName: account.name || accountId,
        platform: 'openai-responses',
        status: 'recovered',
        errorCode: 'STATUS_RESET',
        reason: 'Account status manually reset',
        timestamp: new Date().toISOString()
      })
      logger.info(
        `📢 Webhook notification sent for OpenAI-Responses account ${account.name} status reset`
      )
    } catch (webhookError) {
      logger.error('Failed to send status reset webhook notification:', webhookError)
    }

    return { success: true, message: 'Account status reset successfully' }
  }

  // ⏰ 检查账户订阅是否已过期
  isSubscriptionExpired(account) {
    if (!account.subscriptionExpiresAt) {
      return false // 未设置过期时间，视为永不过期
    }

    const expiryDate = new Date(account.subscriptionExpiresAt)
    const now = new Date()

    if (expiryDate <= now) {
      logger.debug(
        `⏰ OpenAI-Responses Account ${account.name} (${account.id}) subscription expired at ${account.subscriptionExpiresAt}`
      )
      return true
    }

    return false
  }

  // 获取限流信息
  _getRateLimitInfo(accountData) {
    if (accountData.rateLimitStatus !== 'limited') {
      return { isRateLimited: false }
    }

    const now = new Date()
    let willBeAvailableAt
    let remainingMinutes

    // 优先使用 rateLimitResetAt 字段
    if (accountData.rateLimitResetAt) {
      willBeAvailableAt = new Date(accountData.rateLimitResetAt)
      remainingMinutes = Math.max(0, Math.ceil((willBeAvailableAt - now) / 60000))
    } else {
      // 如果没有 rateLimitResetAt，使用旧的逻辑
      const rateLimitedAt = new Date(accountData.rateLimitedAt)
      const rateLimitDuration = parseInt(accountData.rateLimitDuration) || 60
      const elapsedMinutes = Math.floor((now - rateLimitedAt) / 60000)
      remainingMinutes = Math.max(0, rateLimitDuration - elapsedMinutes)
      willBeAvailableAt = new Date(rateLimitedAt.getTime() + rateLimitDuration * 60000)
    }

    return {
      isRateLimited: remainingMinutes > 0,
      remainingMinutes,
      willBeAvailableAt
    }
  }

  _normalizeModelRestrictionMode(mode) {
    return mode === 'whitelist' ? 'whitelist' : 'mapping'
  }

  _parseSupportedModels(value) {
    if (!value) {
      return {}
    }

    if (typeof value === 'object') {
      return this._processModelMapping(value, 'mapping')
    }

    try {
      return this._processModelMapping(JSON.parse(value), 'mapping')
    } catch {
      return {}
    }
  }

  _processModelMapping(supportedModels, modelRestrictionMode = 'mapping') {
    const normalizedMode = this._normalizeModelRestrictionMode(modelRestrictionMode)

    if (!supportedModels || (Array.isArray(supportedModels) && supportedModels.length === 0)) {
      return {}
    }

    if (Array.isArray(supportedModels)) {
      return supportedModels.reduce((mapping, model) => {
        if (typeof model === 'string' && model.trim()) {
          const normalizedModel = model.trim()
          mapping[normalizedModel] = normalizedModel
        }
        return mapping
      }, {})
    }

    if (typeof supportedModels === 'object') {
      const mapping = {}
      for (const [from, to] of Object.entries(supportedModels)) {
        const inboundModel = typeof from === 'string' ? from.trim() : ''
        const upstreamModel =
          normalizedMode === 'whitelist'
            ? inboundModel
            : typeof to === 'string' && to.trim()
              ? to.trim()
              : inboundModel

        if (inboundModel) {
          mapping[inboundModel] = upstreamModel
        }
      }
      return mapping
    }

    return {}
  }

  isModelSupported(modelMapping, requestedModel) {
    if (!requestedModel) {
      return true
    }

    const parsedMapping = this._parseSupportedModels(modelMapping)
    const keys = Object.keys(parsedMapping)
    if (keys.length === 0) {
      return true
    }

    const requestedModelLower = requestedModel.toLowerCase()
    return keys.some((model) => model.toLowerCase() === requestedModelLower)
  }

  getMappedModel(modelMapping, requestedModel) {
    if (!requestedModel) {
      return requestedModel
    }

    const parsedMapping = this._parseSupportedModels(modelMapping)
    if (Object.keys(parsedMapping).length === 0) {
      return requestedModel
    }

    if (Object.prototype.hasOwnProperty.call(parsedMapping, requestedModel)) {
      return parsedMapping[requestedModel]
    }

    const requestedModelLower = requestedModel.toLowerCase()
    for (const [from, to] of Object.entries(parsedMapping)) {
      if (from.toLowerCase() === requestedModelLower) {
        return to
      }
    }

    return requestedModel
  }

  // 加密敏感数据
  _encryptSensitiveData(text) {
    if (!text) {
      return ''
    }

    const key = this._getEncryptionKey()
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(this.ENCRYPTION_ALGORITHM, key, iv)

    let encrypted = cipher.update(text)
    encrypted = Buffer.concat([encrypted, cipher.final()])

    return `${iv.toString('hex')}:${encrypted.toString('hex')}`
  }

  // 解密敏感数据
  _decryptSensitiveData(text) {
    if (!text || text === '') {
      return ''
    }

    // 检查缓存
    const cacheKey = crypto.createHash('sha256').update(text).digest('hex')
    const cached = this._decryptCache.get(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    try {
      const key = this._getEncryptionKey()
      const [ivHex, encryptedHex] = text.split(':')

      const iv = Buffer.from(ivHex, 'hex')
      const encryptedText = Buffer.from(encryptedHex, 'hex')

      const decipher = crypto.createDecipheriv(this.ENCRYPTION_ALGORITHM, key, iv)
      let decrypted = decipher.update(encryptedText)
      decrypted = Buffer.concat([decrypted, decipher.final()])

      const result = decrypted.toString()

      // 存入缓存（5分钟过期）
      this._decryptCache.set(cacheKey, result, 5 * 60 * 1000)

      return result
    } catch (error) {
      logger.error('Decryption error:', error)
      return ''
    }
  }

  // 获取加密密钥
  _getEncryptionKey() {
    if (!this._encryptionKeyCache) {
      this._encryptionKeyCache = crypto.scryptSync(
        config.security.encryptionKey,
        this.ENCRYPTION_SALT,
        32
      )
    }
    return this._encryptionKeyCache
  }

  // 保存账户到 Redis
  async _saveAccount(accountId, accountData) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`

    // 保存账户数据
    await client.hset(key, accountData)

    // 添加到索引
    await redis.addToIndex('openai_responses_account:index', accountId)

    // 添加到共享账户列表
    if (accountData.accountType === 'shared') {
      await client.sadd(this.SHARED_ACCOUNTS_KEY, accountId)
    }
  }
}

module.exports = new OpenAIResponsesAccountService()
