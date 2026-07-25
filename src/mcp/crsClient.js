const axios = require('axios')

const MANAGEMENT_API_BASE = '/admin/management/v1'

const ACCOUNT_ROUTES = {
  claude: {
    basePath: '/admin/claude-accounts',
    testSuffix: 'test',
    refreshSuffix: 'refresh'
  },
  'claude-console': {
    basePath: '/admin/claude-console-accounts',
    testSuffix: 'test'
  },
  gemini: {
    basePath: '/admin/gemini-accounts',
    testSuffix: 'test',
    refreshSuffix: 'refresh'
  },
  'gemini-api': {
    basePath: '/admin/gemini-api-accounts',
    testSuffix: 'test'
  },
  openai: {
    basePath: '/admin/openai-accounts'
  },
  'azure-openai': {
    basePath: '/admin/azure-openai-accounts',
    testSuffix: 'test'
  },
  'openai-responses': {
    basePath: '/admin/openai-responses-accounts',
    testSuffix: 'test'
  },
  droid: {
    basePath: '/admin/droid-accounts',
    testSuffix: 'test',
    refreshSuffix: 'refresh-token'
  },
  bedrock: {
    basePath: '/admin/bedrock-accounts',
    testSuffix: 'test'
  },
  ccr: {
    basePath: '/admin/ccr-accounts',
    testSuffix: 'test'
  }
}

const ACCOUNT_STATS_TYPES = new Set([
  'claude',
  'claude-console',
  'gemini',
  'gemini-api',
  'openai',
  'openai-responses',
  'droid',
  'bedrock'
])

class CrsClient {
  constructor(options = {}) {
    const {
      baseUrl,
      managementKey,
      timeoutMs = 30000,
      httpClient = null,
      managementApiMode = 'auto'
    } = options
    if (!baseUrl) {
      throw new Error('CRS base URL is required')
    }
    if (!managementKey || !/^crsm_[a-f0-9]{64}$/.test(managementKey)) {
      throw new Error('A valid crsm_ management key is required')
    }

    const parsedUrl = new URL(baseUrl)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('CRS base URL must use http or https')
    }

    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.managementKey = managementKey
    this.managementApiMode = ['auto', 'v1', 'legacy'].includes(managementApiMode)
      ? managementApiMode
      : 'auto'
    this.resolvedManagementApiMode =
      this.managementApiMode === 'auto' ? null : this.managementApiMode
    this.http =
      httpClient ||
      axios.create({
        baseURL: this.baseUrl,
        timeout: timeoutMs,
        headers: {
          Authorization: `Bearer ${managementKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      })
  }

  getAccountTypes() {
    return Object.keys(ACCOUNT_ROUTES)
  }

  async getCapabilities() {
    if (this.resolvedManagementApiMode === 'legacy') {
      return this.getLegacyCapabilities()
    }

    try {
      const response = await this.request('GET', `${MANAGEMENT_API_BASE}/capabilities`)
      this.resolvedManagementApiMode = 'v1'
      return response
    } catch (error) {
      if (error.status !== 404 || this.managementApiMode === 'v1') {
        throw error
      }
      this.resolvedManagementApiMode = 'legacy'
      return this.getLegacyCapabilities()
    }
  }

  async listApiKeys(params = {}) {
    const response = await this.requestManagement('GET', '/api-keys', '/admin/api-keys', {
      params
    })
    return this.boundApiKeyResponse(response, params.pageSize)
  }

  async createApiKey(data) {
    return await this.requestManagement('POST', '/api-keys', '/admin/api-keys', { data })
  }

  async updateApiKey(keyId, data) {
    const encodedKeyId = encodeURIComponent(keyId)
    return await this.requestManagement(
      'PUT',
      `/api-keys/${encodedKeyId}`,
      `/admin/api-keys/${encodedKeyId}`,
      { data }
    )
  }

  async revealApiKey(keyId) {
    const encodedKeyId = encodeURIComponent(keyId)
    return await this.requestManagement(
      'POST',
      `/api-keys/${encodedKeyId}/reveal`,
      `/admin/api-keys/${encodedKeyId}/reveal-secret`
    )
  }

  async disableApiKey(keyId) {
    return await this.updateApiKey(keyId, { isActive: false })
  }

  async deleteApiKey(keyId) {
    const encodedKeyId = encodeURIComponent(keyId)
    return await this.requestManagement(
      'DELETE',
      `/api-keys/${encodedKeyId}`,
      `/admin/api-keys/${encodedKeyId}`
    )
  }

  async listAccounts(accountType = null, params = {}) {
    if (accountType) {
      const route = this.getAccountRoute(accountType)
      const response = await this.requestManagement(
        'GET',
        `/accounts/${encodeURIComponent(accountType)}`,
        route.basePath,
        { params }
      )
      return this.paginateLegacyAccountResponse(response, params)
    }

    const results = await Promise.all(
      this.getAccountTypes().map(async (type) => {
        try {
          const response = await this.listAccounts(type, params)
          return { type, response }
        } catch (error) {
          return {
            type,
            error: error.message,
            status: error.status || null
          }
        }
      })
    )
    return {
      success: true,
      apiVersion: this.resolvedManagementApiMode || 'auto',
      data: results
    }
  }

  async createAccount(accountType, data) {
    const route = this.getAccountRoute(accountType)
    return await this.requestManagement(
      'POST',
      `/accounts/${encodeURIComponent(accountType)}`,
      route.basePath,
      { data }
    )
  }

  async updateAccount(accountType, accountId, data) {
    const route = this.getAccountRoute(accountType)
    const encodedAccountType = encodeURIComponent(accountType)
    const encodedAccountId = encodeURIComponent(accountId)
    return await this.requestManagement(
      'PUT',
      `/accounts/${encodedAccountType}/${encodedAccountId}`,
      `${route.basePath}/${encodedAccountId}`,
      { data }
    )
  }

  async deleteAccount(accountType, accountId) {
    const route = this.getAccountRoute(accountType)
    const encodedAccountType = encodeURIComponent(accountType)
    const encodedAccountId = encodeURIComponent(accountId)
    return await this.requestManagement(
      'DELETE',
      `/accounts/${encodedAccountType}/${encodedAccountId}`,
      `${route.basePath}/${encodedAccountId}`
    )
  }

  async testAccount(accountType, accountId) {
    const route = this.getAccountRoute(accountType)
    if (!route.testSuffix) {
      throw new Error(`Account type ${accountType} does not expose a test endpoint`)
    }
    return await this.requestManagement(
      'POST',
      `/accounts/${encodeURIComponent(accountType)}/${encodeURIComponent(accountId)}/test`,
      `${route.basePath}/${encodeURIComponent(accountId)}/${route.testSuffix}`
    )
  }

  async refreshAccount(accountType, accountId) {
    const route = this.getAccountRoute(accountType)
    if (!route.refreshSuffix) {
      throw new Error(`Account type ${accountType} does not expose a refresh endpoint`)
    }
    return await this.requestManagement(
      'POST',
      `/accounts/${encodeURIComponent(accountType)}/${encodeURIComponent(accountId)}/refresh`,
      `${route.basePath}/${encodeURIComponent(accountId)}/${route.refreshSuffix}`
    )
  }

  async getUsageSummary() {
    return await this.requestManagement('GET', '/stats/summary', '/admin/dashboard')
  }

  async getApiKeyStats(keyId, params = {}) {
    const encodedKeyId = encodeURIComponent(keyId)
    return await this.requestManagement(
      'GET',
      `/stats/api-keys/${encodedKeyId}`,
      `/admin/api-keys/${encodedKeyId}/model-stats`,
      { params }
    )
  }

  async getAccountStats(accountType, accountId, days = 30) {
    this.getAccountRoute(accountType)
    if (!ACCOUNT_STATS_TYPES.has(accountType)) {
      throw new Error(`Account statistics are not available for account type ${accountType}`)
    }
    return await this.requestManagement(
      'GET',
      `/stats/accounts/${encodeURIComponent(accountType)}/${encodeURIComponent(accountId)}`,
      `/admin/accounts/${encodeURIComponent(accountId)}/usage-history`,
      {
        params: {
          days,
          platform: accountType
        }
      }
    )
  }

  getLegacyCapabilities() {
    return {
      success: true,
      apiVersion: 'legacy',
      data: {
        version: 'legacy',
        pagination: {
          defaultPageSize: 20,
          maxPageSize: 200
        },
        accounts: this.getAccountTypes().map((type) => {
          const route = ACCOUNT_ROUTES[type]
          return {
            type,
            operations: [
              'list',
              'create',
              'update',
              'delete',
              ...(route.testSuffix ? ['test'] : []),
              ...(route.refreshSuffix ? ['refresh'] : []),
              ...(ACCOUNT_STATS_TYPES.has(type) ? ['stats'] : [])
            ]
          }
        })
      }
    }
  }

  boundApiKeyResponse(response, pageSize) {
    const items = response?.data?.items
    if (!Number.isInteger(pageSize) || !Array.isArray(items) || items.length <= pageSize) {
      return response
    }
    return {
      ...response,
      data: {
        ...response.data,
        items: items.slice(0, pageSize),
        pagination: {
          ...response.data.pagination,
          pageSize
        }
      }
    }
  }

  paginateLegacyAccountResponse(response, params = {}) {
    if (Array.isArray(response?.data?.items)) {
      return response
    }
    if (!Array.isArray(response?.data)) {
      return response
    }

    const page = Number.isInteger(params.page) && params.page > 0 ? params.page : 1
    const pageSize = Number.isInteger(params.pageSize) && params.pageSize > 0 ? params.pageSize : 20
    const total = response.data.length
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const safePage = Math.min(page, totalPages)
    const start = (safePage - 1) * pageSize

    return {
      ...response,
      data: {
        items: response.data.slice(start, start + pageSize),
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
  }

  annotateLegacyResponse(response) {
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return response
    }
    return {
      ...response,
      apiVersion: response.apiVersion || 'legacy'
    }
  }

  async requestManagement(method, v1Path, legacyPath, options = {}) {
    if (this.resolvedManagementApiMode === 'legacy') {
      return this.annotateLegacyResponse(await this.request(method, legacyPath, options))
    }

    try {
      const response = await this.request(method, `${MANAGEMENT_API_BASE}${v1Path}`, options)
      this.resolvedManagementApiMode = 'v1'
      return response
    } catch (error) {
      if (
        error.status !== 404 ||
        this.managementApiMode === 'v1' ||
        !legacyPath ||
        this.resolvedManagementApiMode === 'v1'
      ) {
        throw error
      }
      this.resolvedManagementApiMode = 'legacy'
      return this.annotateLegacyResponse(await this.request(method, legacyPath, options))
    }
  }

  getAccountRoute(accountType) {
    const route = ACCOUNT_ROUTES[accountType]
    if (!route) {
      throw new Error(
        `Unsupported account type: ${accountType}. Supported types: ${this.getAccountTypes().join(', ')}`
      )
    }
    return route
  }

  async request(method, path, options = {}) {
    try {
      const response = await this.http.request({
        method,
        url: path,
        params: options.params,
        data: options.data
      })
      return response.data
    } catch (error) {
      const status = error.response?.status
      const responseData = error.response?.data
      const message =
        responseData?.message ||
        responseData?.error?.message ||
        responseData?.error ||
        (status ? `CRS request failed with HTTP ${status}` : error.message)
      const clientError = new Error(String(message))
      clientError.status = status
      clientError.data = responseData
      throw clientError
    }
  }
}

module.exports = {
  CrsClient,
  ACCOUNT_ROUTES,
  ACCOUNT_STATS_TYPES,
  MANAGEMENT_API_BASE
}
