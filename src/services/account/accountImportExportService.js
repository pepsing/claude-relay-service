const axios = require('axios')
const claudeConsoleAccountService = require('./claudeConsoleAccountService')
const openaiResponsesAccountService = require('./openaiResponsesAccountService')
const accountGroupService = require('../accountGroupService')
const logger = require('../../utils/logger')
const {
  PROVIDER_ENDPOINT_CHAT_COMPLETIONS,
  PROVIDER_ENDPOINT_RESPONSES,
  normalizeOpenAIProviderEndpoint
} = require('../../utils/openaiProviderEndpoint')

const CONFLICT_STRATEGIES = new Set(['ask', 'skip', 'overwrite', 'abort'])
const REMOTE_REQUEST_TIMEOUT_MS = 30000

const TARGETS = {
  CLAUDE_CONSOLE: 'claude-console',
  OPENAI_RESPONSES: 'openai-responses:responses',
  OPENAI_CHAT_COMPLETIONS: 'openai-responses:chat-completions'
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeLowerText(value) {
  return normalizeText(value).toLowerCase()
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeRemoteBaseUrl(value) {
  const text = normalizeText(value)
  if (!text) {
    throw new Error('远端 CRS 地址不能为空')
  }

  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('远端 CRS 地址格式无效')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('远端 CRS 地址只支持 http 或 https')
  }

  url.pathname = url.pathname
    .replace(/\/(admin-next|admin)(\/.*)?$/i, '')
    .replace(/\/(login|admin-login)(\/.*)?$/i, '')
    .replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function joinRemoteUrl(baseUrl, path) {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

function toNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function toBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}

function resolveOpenAIProviderEndpoint(record) {
  const platform = normalizeLowerText(record.platform || record.accountPlatform || record.type)
  const inferredProvider =
    platform.includes('chat') || platform.includes('completions')
      ? PROVIDER_ENDPOINT_CHAT_COMPLETIONS
      : undefined
  const normalized =
    normalizeOpenAIProviderEndpoint(record.providerEndpoint, inferredProvider) ||
    normalizeOpenAIProviderEndpoint(inferredProvider) ||
    PROVIDER_ENDPOINT_RESPONSES

  return normalized === PROVIDER_ENDPOINT_CHAT_COMPLETIONS
    ? PROVIDER_ENDPOINT_CHAT_COMPLETIONS
    : PROVIDER_ENDPOINT_RESPONSES
}

function resolveRecordTarget(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { error: '账户配置必须是 JSON 对象' }
  }

  const platform = normalizeLowerText(record.platform || record.accountPlatform || record.type)
  const hasApiUrl = !!normalizeText(record.apiUrl)
  const hasBaseApi = !!normalizeText(record.baseApi)

  if (
    platform === 'claude' ||
    platform === 'claude-console' ||
    platform === 'claude_console' ||
    hasApiUrl
  ) {
    return {
      key: TARGETS.CLAUDE_CONSOLE,
      platform: 'claude-console',
      groupPlatform: 'claude',
      label: 'Claude'
    }
  }

  if (
    platform === 'openai-responses' ||
    platform === 'openai_responses' ||
    platform === 'openai responses' ||
    platform === 'openai-chat-completions' ||
    platform === 'openai chat/completions' ||
    platform === 'chat-completions' ||
    hasBaseApi
  ) {
    const providerEndpoint = resolveOpenAIProviderEndpoint(record)
    return {
      key:
        providerEndpoint === PROVIDER_ENDPOINT_CHAT_COMPLETIONS
          ? TARGETS.OPENAI_CHAT_COMPLETIONS
          : TARGETS.OPENAI_RESPONSES,
      platform: 'openai-responses',
      groupPlatform: 'openai',
      label:
        providerEndpoint === PROVIDER_ENDPOINT_CHAT_COMPLETIONS
          ? 'OpenAI chat/completions'
          : 'OpenAI responses',
      providerEndpoint
    }
  }

  return { error: '仅支持 Claude、OpenAI responses、OpenAI chat/completions 账户' }
}

function getOpenAITargetKey(account) {
  return resolveOpenAIProviderEndpoint(account) === PROVIDER_ENDPOINT_CHAT_COMPLETIONS
    ? TARGETS.OPENAI_CHAT_COMPLETIONS
    : TARGETS.OPENAI_RESPONSES
}

function stripRuntimeFields(payload) {
  const stripped = { ...payload }
  const runtimeFields = [
    'id',
    'createdAt',
    'updatedAt',
    'lastUsedAt',
    'status',
    'errorMessage',
    'usage',
    'groupInfos',
    'boundApiKeysCount',
    'dailyUsage',
    'lastResetDate',
    'quotaStoppedAt',
    'rateLimitedAt',
    'rateLimitStatus',
    'rateLimitEndAt',
    'rateLimitInfo',
    'activeTaskCount',
    'tempUnavailable',
    'provider',
    'accountCategory'
  ]

  runtimeFields.forEach((field) => {
    delete stripped[field]
  })

  if (Object.prototype.hasOwnProperty.call(stripped, 'expiresAt')) {
    stripped.subscriptionExpiresAt = stripped.expiresAt || null
    delete stripped.expiresAt
  }

  return stripped
}

function sanitizeImportPayload(record, target) {
  const payload = stripRuntimeFields(cloneJson(record))

  delete payload.platform
  delete payload.accountPlatform
  delete payload.type

  payload.name = normalizeText(payload.name)
  payload.accountType = payload.accountType || 'shared'

  if (target.platform === 'openai-responses') {
    payload.providerEndpoint = target.providerEndpoint || resolveOpenAIProviderEndpoint(record)
  }

  return payload
}

function validatePayload(payload, target) {
  if (!payload.name) {
    return '缺少账户名称 name'
  }

  if (target.platform === 'claude-console') {
    if (!normalizeText(payload.apiUrl)) return '缺少 Claude API URL: apiUrl'
    if (!normalizeText(payload.apiKey) || payload.apiKey === '***') return '缺少 Claude API Key'
  }

  if (target.platform === 'openai-responses') {
    if (!normalizeText(payload.baseApi)) return '缺少 OpenAI Base API: baseApi'
    if (!normalizeText(payload.apiKey) || payload.apiKey === '***') return '缺少 OpenAI API Key'
  }

  return null
}

function getGroupIdsFromPayload(payload) {
  if (Array.isArray(payload.groupIds)) {
    return payload.groupIds.filter((id) => typeof id === 'string' && id.trim())
  }

  if (typeof payload.groupId === 'string' && payload.groupId.trim()) {
    return [payload.groupId.trim()]
  }

  return []
}

async function applyGroupBinding(accountId, payload, target, existingAccount = null) {
  if (!payload.accountType && !payload.groupId && !payload.groupIds) {
    return
  }

  const targetAccountType = payload.accountType || existingAccount?.accountType || 'shared'
  if (existingAccount?.accountType === 'group' && targetAccountType !== 'group') {
    await accountGroupService.removeAccountFromAllGroups(accountId)
    return
  }

  if (targetAccountType !== 'group') {
    return
  }

  const groupIds = getGroupIdsFromPayload(payload)
  if (groupIds.length > 0) {
    await accountGroupService.setAccountGroups(accountId, groupIds, target.groupPlatform)
  }
}

async function loadSupportedAccounts() {
  const [claudeConsoleAccounts, openaiResponsesAccounts] = await Promise.all([
    claudeConsoleAccountService.getAllAccounts(),
    openaiResponsesAccountService.getAllAccounts(true)
  ])

  const accounts = []

  for (const account of claudeConsoleAccounts || []) {
    accounts.push({
      ...account,
      platform: 'claude-console',
      targetKey: TARGETS.CLAUDE_CONSOLE,
      targetLabel: 'Claude'
    })
  }

  for (const account of openaiResponsesAccounts || []) {
    const targetKey = getOpenAITargetKey(account)
    accounts.push({
      ...account,
      platform: 'openai-responses',
      targetKey,
      targetLabel:
        targetKey === TARGETS.OPENAI_CHAT_COMPLETIONS
          ? 'OpenAI chat/completions'
          : 'OpenAI responses'
    })
  }

  return accounts
}

async function findExistingAccount(target, name) {
  const accounts = await loadSupportedAccounts()
  const normalizedName = normalizeLowerText(name)
  return accounts.find(
    (account) =>
      account.targetKey === target.key && normalizeLowerText(account.name) === normalizedName
  )
}

async function createAccount(payload, target) {
  if (target.platform === 'claude-console') {
    const account = await claudeConsoleAccountService.createAccount(payload)
    await applyGroupBinding(account.id, payload, target)
    return account
  }

  const account = await openaiResponsesAccountService.createAccount(payload)
  await applyGroupBinding(account.id, payload, target)
  return account
}

async function updateAccount(existingAccount, payload, target) {
  const updates = { ...payload }
  delete updates.groupId
  delete updates.groupIds

  if (target.platform === 'claude-console') {
    await applyGroupBinding(existingAccount.id, payload, target, existingAccount)
    await claudeConsoleAccountService.updateAccount(existingAccount.id, updates)
    return { id: existingAccount.id }
  }

  await applyGroupBinding(existingAccount.id, payload, target, existingAccount)
  await openaiResponsesAccountService.updateAccount(existingAccount.id, updates)
  return { id: existingAccount.id }
}

function normalizeImportRecords(records) {
  if (!Array.isArray(records)) {
    throw new Error('账户 JSON 必须是数组')
  }

  return records
}

async function previewImport(records) {
  const normalizedRecords = normalizeImportRecords(records)
  const prepared = []
  const conflicts = []
  const invalid = []

  for (let index = 0; index < normalizedRecords.length; index++) {
    const record = normalizedRecords[index]
    const target = resolveRecordTarget(record)
    if (target.error) {
      invalid.push({ index, message: target.error })
      continue
    }

    const payload = sanitizeImportPayload(record, target)
    const validationError = validatePayload(payload, target)
    if (validationError) {
      invalid.push({
        index,
        name: payload.name || '',
        platform: target.label,
        message: validationError
      })
      continue
    }

    const existing = await findExistingAccount(target, payload.name)
    if (existing) {
      conflicts.push({
        index,
        name: payload.name,
        platform: target.label,
        existingId: existing.id,
        existingName: existing.name
      })
    }

    prepared.push({ index, record, target, payload, existing })
  }

  return {
    total: normalizedRecords.length,
    valid: prepared.length,
    conflicts,
    invalid,
    prepared
  }
}

async function importAccounts(records, strategy = 'ask') {
  if (!CONFLICT_STRATEGIES.has(strategy)) {
    throw new Error('导入策略必须是 ask、skip、overwrite 或 abort')
  }

  const preview = await previewImport(records)
  if (preview.conflicts.length > 0 && (strategy === 'ask' || strategy === 'abort')) {
    return {
      success: false,
      code: 'ACCOUNT_NAME_CONFLICT',
      message: '存在同名账户',
      data: {
        total: preview.total,
        conflicts: preview.conflicts,
        invalid: preview.invalid
      }
    }
  }

  const results = []
  let imported = 0
  let overwritten = 0
  let skipped = 0
  let failed = preview.invalid.length

  for (const item of preview.invalid) {
    results.push({
      success: false,
      index: item.index,
      name: item.name || '',
      platform: item.platform || '',
      action: 'failed',
      message: item.message
    })
  }

  for (const item of preview.prepared) {
    const { index, target, payload, existing } = item

    if (existing && strategy === 'skip') {
      skipped += 1
      results.push({
        success: true,
        index,
        name: payload.name,
        platform: target.label,
        action: 'skipped',
        message: '同名账户已跳过'
      })
      continue
    }

    try {
      if (existing) {
        await updateAccount(existing, payload, target)
        overwritten += 1
        results.push({
          success: true,
          index,
          name: payload.name,
          platform: target.label,
          action: 'overwritten',
          message: '已覆盖同名账户'
        })
      } else {
        await createAccount(payload, target)
        imported += 1
        results.push({
          success: true,
          index,
          name: payload.name,
          platform: target.label,
          action: 'created',
          message: '已创建账户'
        })
      }
    } catch (error) {
      failed += 1
      logger.error(`Failed to import account ${payload.name}:`, error)
      results.push({
        success: false,
        index,
        name: payload.name,
        platform: target.label,
        action: 'failed',
        message: error.message || '导入失败'
      })
    }
  }

  const changed = imported + overwritten + skipped

  return {
    success: changed > 0 || failed === 0,
    data: {
      total: preview.total,
      imported,
      overwritten,
      skipped,
      failed,
      conflicts: preview.conflicts,
      invalid: preview.invalid,
      results: results.sort((a, b) => a.index - b.index)
    }
  }
}

async function postRemoteJson(baseUrl, paths, data, token = null) {
  let lastError = null

  for (const path of paths) {
    try {
      const response = await axios.post(joinRemoteUrl(baseUrl, path), data, {
        timeout: REMOTE_REQUEST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        validateStatus: () => true
      })

      if (response.status >= 200 && response.status < 300) {
        return response.data
      }

      lastError = new Error(
        response.data?.message || response.data?.error || `HTTP ${response.status}`
      )
      lastError.status = response.status
    } catch (error) {
      lastError = new Error(
        error.response?.data?.message ||
          error.response?.data?.error ||
          error.message ||
          '远端 CRS 请求失败'
      )
      lastError.status = error.response?.status
    }
  }

  throw lastError || new Error('远端 CRS 请求失败')
}

async function loginRemoteCrs(baseUrl, username, password) {
  const loginResult = await postRemoteJson(baseUrl, ['/web/auth/login', '/webapi/web/auth/login'], {
    username,
    password
  })

  if (!loginResult?.success || !loginResult.token) {
    throw new Error(loginResult?.message || '远端 CRS 登录失败')
  }

  return loginResult.token
}

async function fetchRemoteAccounts(baseUrl, token) {
  const exportResult = await postRemoteJson(
    baseUrl,
    ['/admin/accounts/export-json', '/webapi/admin/accounts/export-json'],
    {},
    token
  )

  if (!exportResult?.success) {
    throw new Error(exportResult?.message || '远端 CRS 账户导出失败')
  }

  const accounts = exportResult.data?.accounts
  if (!Array.isArray(accounts)) {
    throw new Error('远端 CRS 返回的账户导出数据格式无效')
  }

  return {
    accounts,
    remoteSummary: {
      exported: Number(exportResult.data?.exported || accounts.length),
      skipped: Number(exportResult.data?.skipped || 0)
    }
  }
}

async function syncFromRemote(options = {}) {
  const baseUrl = normalizeRemoteBaseUrl(options.baseUrl)
  const username = normalizeText(options.username)
  const password = typeof options.password === 'string' ? options.password : ''
  const strategy = options.strategy || 'ask'

  if (!username || !password) {
    throw new Error('远端 CRS 用户名和密码不能为空')
  }

  const token = await loginRemoteCrs(baseUrl, username, password)
  const { accounts, remoteSummary } = await fetchRemoteAccounts(baseUrl, token)
  const result = await importAccounts(accounts, strategy)

  return {
    ...result,
    data: {
      ...(result.data || {}),
      remote: remoteSummary
    }
  }
}

async function getGroupPayload(accountId) {
  const groups = await accountGroupService.getAccountGroups(accountId)
  const groupIds = Array.isArray(groups) ? groups.map((group) => group.id).filter(Boolean) : []

  if (groupIds.length === 0) {
    return {}
  }

  return {
    groupId: groupIds[0],
    groupIds
  }
}

async function buildClaudeConsoleExportPayload(account) {
  const fullAccount = await claudeConsoleAccountService.getAccount(account.id)
  if (!fullAccount) {
    throw new Error('账户不存在')
  }

  return {
    platform: 'claude-console',
    name: fullAccount.name,
    description: fullAccount.description || '',
    apiUrl: fullAccount.apiUrl,
    apiKey: fullAccount.apiKey,
    priority: toNumber(fullAccount.priority, 50),
    supportedModels: fullAccount.supportedModels || {},
    modelRestrictionMode: fullAccount.modelRestrictionMode || 'mapping',
    userAgent: fullAccount.userAgent || '',
    rateLimitDuration: toNumber(fullAccount.rateLimitDuration, 60),
    proxy: fullAccount.proxy || null,
    accountType: fullAccount.accountType || 'shared',
    expiresAt: fullAccount.subscriptionExpiresAt || null,
    dailyQuota: toNumber(fullAccount.dailyQuota, 0),
    quotaResetTime: fullAccount.quotaResetTime || '00:00',
    maxConcurrentTasks: toNumber(fullAccount.maxConcurrentTasks, 0),
    disableAutoProtection: toBoolean(fullAccount.disableAutoProtection, false),
    interceptWarmup: toBoolean(fullAccount.interceptWarmup, false),
    schedulable: toBoolean(fullAccount.schedulable, true),
    ...(await getGroupPayload(fullAccount.id))
  }
}

async function buildOpenAIResponsesExportPayload(account) {
  const fullAccount = await openaiResponsesAccountService.getAccount(account.id)
  if (!fullAccount) {
    throw new Error('账户不存在')
  }

  const providerEndpoint = resolveOpenAIProviderEndpoint(fullAccount)

  return {
    platform: 'openai-responses',
    name: fullAccount.name,
    description: fullAccount.description || '',
    baseApi: fullAccount.baseApi,
    apiKey: fullAccount.apiKey,
    userAgent: fullAccount.userAgent || '',
    providerEndpoint,
    supportedModels: fullAccount.supportedModels || {},
    modelRestrictionMode: fullAccount.modelRestrictionMode || 'mapping',
    priority: toNumber(fullAccount.priority, 50),
    proxy: fullAccount.proxy || null,
    accountType: fullAccount.accountType || 'shared',
    expiresAt: fullAccount.subscriptionExpiresAt || null,
    rateLimitDuration: toNumber(fullAccount.rateLimitDuration, 60),
    dailyQuota: toNumber(fullAccount.dailyQuota, 0),
    quotaResetTime: fullAccount.quotaResetTime || '00:00',
    maxConcurrentTasks: toNumber(fullAccount.maxConcurrentTasks, 0),
    disableAutoProtection: toBoolean(fullAccount.disableAutoProtection, false),
    schedulable: toBoolean(fullAccount.schedulable, true),
    ...(await getGroupPayload(fullAccount.id))
  }
}

async function exportAccount(account) {
  if (account.platform === 'claude-console') {
    return buildClaudeConsoleExportPayload(account)
  }

  if (account.platform === 'openai-responses') {
    return buildOpenAIResponsesExportPayload(account)
  }

  throw new Error('暂不支持导出该账户类型')
}

async function resolveExportTargets(items = null) {
  const supportedAccounts = await loadSupportedAccounts()

  if (!Array.isArray(items) || items.length === 0) {
    return {
      targets: supportedAccounts,
      skipped: []
    }
  }

  const supportedByKey = new Map(
    supportedAccounts.map((account) => [`${account.platform}:${account.id}`, account])
  )
  const targets = []
  const skipped = []

  for (const item of items) {
    const id = normalizeText(item?.id)
    const platform = normalizeText(item?.platform)
    const key = `${platform}:${id}`
    const target = supportedByKey.get(key)

    if (target) {
      targets.push(target)
    } else {
      skipped.push({
        id,
        platform,
        name: item?.name || '',
        message: '暂不支持导出该账户类型'
      })
    }
  }

  return { targets, skipped }
}

async function exportAccounts(items = null) {
  const { targets, skipped } = await resolveExportTargets(items)
  const accounts = []
  const failures = []

  for (const account of targets) {
    try {
      accounts.push(await exportAccount(account))
    } catch (error) {
      failures.push({
        id: account.id,
        platform: account.platform,
        name: account.name || '',
        message: error.message || '导出失败'
      })
    }
  }

  return {
    accounts,
    exported: accounts.length,
    skipped: skipped.length + failures.length,
    skippedAccounts: [...skipped, ...failures]
  }
}

module.exports = {
  TARGETS,
  importAccounts,
  exportAccounts,
  previewImport,
  syncFromRemote
}
