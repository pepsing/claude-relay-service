const config = require('../../config/config')
const managementApiKeyService = require('./managementApiKeyService')

const MANAGEMENT_API_VERSION = 'v1'
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

const ACCOUNT_DEFINITIONS = {
  claude: {
    test: true,
    refresh: true,
    stats: true,
    getAccounts: async () => await require('./account/claudeAccountService').getAllAccounts()
  },
  'claude-console': {
    test: true,
    refresh: false,
    stats: true,
    getAccounts: async () => await require('./account/claudeConsoleAccountService').getAllAccounts()
  },
  gemini: {
    test: true,
    refresh: true,
    stats: true,
    getAccounts: async () => await require('./account/geminiAccountService').getAllAccounts()
  },
  'gemini-api': {
    test: true,
    refresh: false,
    stats: true,
    getAccounts: async () => await require('./account/geminiApiAccountService').getAllAccounts(true)
  },
  openai: {
    test: false,
    refresh: false,
    stats: true,
    getAccounts: async () => await require('./account/openaiAccountService').getAllAccounts()
  },
  'azure-openai': {
    test: true,
    refresh: false,
    stats: false,
    getAccounts: async () => await require('./account/azureOpenaiAccountService').getAllAccounts()
  },
  'openai-responses': {
    test: true,
    refresh: false,
    stats: true,
    getAccounts: async () =>
      await require('./account/openaiResponsesAccountService').getAllAccounts(true)
  },
  droid: {
    test: true,
    refresh: true,
    stats: true,
    getAccounts: async () => await require('./account/droidAccountService').getAllAccounts()
  },
  bedrock: {
    test: true,
    refresh: false,
    stats: true,
    getAccounts: async () => await require('./account/bedrockAccountService').getAllAccounts()
  },
  ccr: {
    test: true,
    refresh: false,
    stats: false,
    getAccounts: async () => await require('./account/ccrAccountService').getAllAccounts()
  }
}

const ACCOUNT_SUMMARY_FIELDS = [
  'id',
  'name',
  'status',
  'isActive',
  'schedulable',
  'priority',
  'accountType',
  'createdAt',
  'updatedAt',
  'lastUsedAt',
  'expiresAt',
  'subscriptionExpiresAt',
  'rateLimitedAt',
  'rateLimitStatus'
]

const API_KEY_SUMMARY_FIELDS = [
  'id',
  'name',
  'keyPreview',
  'isActive',
  'status',
  'permissions',
  'createdAt',
  'expiresAt',
  'lastUsedAt',
  'ownerDisplayName',
  'secretCaptured'
]

class ManagementApiError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ManagementApiError'
    this.code = code
    this.status = status
  }
}

function parseInteger(value, name, options = {}) {
  const { defaultValue, min = 1, max = Number.MAX_SAFE_INTEGER } = options
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ManagementApiError(
      'INVALID_QUERY_PARAMETER',
      `${name} must be an integer between ${min} and ${max}`
    )
  }
  return parsed
}

function parseBoolean(value, name) {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (value === true || value === 'true') {
    return true
  }
  if (value === false || value === 'false') {
    return false
  }
  throw new ManagementApiError('INVALID_QUERY_PARAMETER', `${name} must be true or false`)
}

function normalizeBoolean(value) {
  if (value === true || value === 'true') {
    return true
  }
  if (value === false || value === 'false') {
    return false
  }
  return value
}

function normalizeAccountResult(result) {
  if (Array.isArray(result)) {
    return result
  }
  if (result?.success === true && Array.isArray(result.data)) {
    return result.data
  }
  if (result?.success === false) {
    throw new ManagementApiError(
      'ACCOUNT_LIST_FAILED',
      result.error || result.message || 'Failed to list accounts',
      500
    )
  }
  return []
}

function pickDefined(source, fields) {
  return fields.reduce((result, field) => {
    if (source?.[field] !== undefined && source[field] !== null && source[field] !== '') {
      result[field] =
        field === 'isActive' || field === 'schedulable'
          ? normalizeBoolean(source[field])
          : source[field]
    }
    return result
  }, {})
}

function summarizeAccount(account, accountType) {
  return {
    type: accountType,
    ...pickDefined(account, ACCOUNT_SUMMARY_FIELDS)
  }
}

function summarizeApiKey(apiKey) {
  return pickDefined(apiKey, API_KEY_SUMMARY_FIELDS)
}

function compareValues(left, right, order) {
  const leftValue = left === undefined || left === null ? '' : left
  const rightValue = right === undefined || right === null ? '' : right
  const result = String(leftValue).localeCompare(String(rightValue), undefined, {
    numeric: true,
    sensitivity: 'base'
  })
  return order === 'asc' ? result : -result
}

class ManagementApiService {
  constructor(options = {}) {
    this.accountDefinitions = options.accountDefinitions || ACCOUNT_DEFINITIONS
  }

  getAccountTypes() {
    return Object.keys(this.accountDefinitions)
  }

  getAccountDefinition(accountType) {
    const definition = this.accountDefinitions[accountType]
    if (!definition) {
      throw new ManagementApiError(
        'UNSUPPORTED_ACCOUNT_TYPE',
        `Unsupported account type: ${accountType}. Supported types: ${this.getAccountTypes().join(', ')}`
      )
    }
    return definition
  }

  getCapabilities(currentScopes = []) {
    return {
      version: MANAGEMENT_API_VERSION,
      pagination: {
        defaultPageSize: DEFAULT_PAGE_SIZE,
        maxPageSize: MAX_PAGE_SIZE
      },
      scopes: {
        supported: managementApiKeyService.getSupportedScopes(),
        current: Array.isArray(currentScopes) ? currentScopes : []
      },
      apiKeys: {
        operations: ['list', 'create', 'update', 'reveal', 'disable', 'delete'],
        listViews: ['summary', 'full']
      },
      accounts: this.getAccountTypes().map((type) => {
        const definition = this.accountDefinitions[type]
        return {
          type,
          operations: [
            'list',
            'create',
            'update',
            'delete',
            ...(definition.test ? ['test'] : []),
            ...(definition.refresh ? ['refresh'] : []),
            ...(definition.stats ? ['stats'] : [])
          ]
        }
      }),
      stats: {
        operations: ['summary', 'api-key', 'account', 'quota-cycles']
      },
      auditLogs: {
        operations: ['list', 'get'],
        retentionDays: Number(config.adminAudit?.retentionDays) || 180
      }
    }
  }

  parsePagination(query = {}, options = {}) {
    return {
      page: parseInteger(query.page, 'page', {
        defaultValue: options.defaultPage || 1,
        min: 1
      }),
      pageSize: parseInteger(query.pageSize, 'pageSize', {
        defaultValue: options.defaultPageSize || DEFAULT_PAGE_SIZE,
        min: 1,
        max: options.maxPageSize || MAX_PAGE_SIZE
      })
    }
  }

  async listAccounts(accountType, query = {}) {
    const definition = this.getAccountDefinition(accountType)
    const { page, pageSize } = this.parsePagination(query)
    const search = String(query.search || '')
      .trim()
      .toLowerCase()
    const status = String(query.status || '')
      .trim()
      .toLowerCase()
    const isActive = parseBoolean(query.isActive, 'isActive')
    const sortBy = ['name', 'createdAt', 'updatedAt', 'lastUsedAt', 'priority', 'status'].includes(
      query.sortBy
    )
      ? query.sortBy
      : 'name'
    const sortOrder = query.sortOrder === 'desc' ? 'desc' : 'asc'

    let accounts = normalizeAccountResult(await definition.getAccounts())
    if (search) {
      accounts = accounts.filter((account) =>
        [account.id, account.name]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(search))
      )
    }
    if (status) {
      accounts = accounts.filter((account) => String(account.status || '').toLowerCase() === status)
    }
    if (isActive !== undefined) {
      accounts = accounts.filter((account) => normalizeBoolean(account.isActive) === isActive)
    }

    accounts.sort((left, right) => compareValues(left[sortBy], right[sortBy], sortOrder))

    const total = accounts.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const safePage = Math.min(page, totalPages)
    const start = (safePage - 1) * pageSize
    const items = accounts
      .slice(start, start + pageSize)
      .map((account) => summarizeAccount(account, accountType))

    return {
      items,
      pagination: {
        page: safePage,
        pageSize,
        total,
        totalPages,
        hasNext: safePage < totalPages,
        hasPrevious: safePage > 1
      }
    }
  }

  summarizeApiKeyResponse(response, view = 'summary') {
    if (view === 'full') {
      return response
    }
    if (view !== 'summary') {
      throw new ManagementApiError('INVALID_QUERY_PARAMETER', 'view must be summary or full')
    }

    const items = response?.data?.items
    if (!Array.isArray(items)) {
      return response
    }
    return {
      ...response,
      data: {
        items: items.map((apiKey) => summarizeApiKey(apiKey)),
        pagination: response.data.pagination
      }
    }
  }
}

const managementApiService = new ManagementApiService()

module.exports = managementApiService
module.exports.ACCOUNT_DEFINITIONS = ACCOUNT_DEFINITIONS
module.exports.DEFAULT_PAGE_SIZE = DEFAULT_PAGE_SIZE
module.exports.MANAGEMENT_API_VERSION = MANAGEMENT_API_VERSION
module.exports.MAX_PAGE_SIZE = MAX_PAGE_SIZE
module.exports.ManagementApiError = ManagementApiError
module.exports.ManagementApiService = ManagementApiService
module.exports.normalizeAccountResult = normalizeAccountResult
module.exports.parseBoolean = parseBoolean
module.exports.parseInteger = parseInteger
module.exports.summarizeAccount = summarizeAccount
module.exports.summarizeApiKey = summarizeApiKey
