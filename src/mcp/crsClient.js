const axios = require('axios')

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
    const { baseUrl, managementKey, timeoutMs = 30000, httpClient = null } = options
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

  async listApiKeys(params = {}) {
    return await this.request('GET', '/admin/api-keys', { params })
  }

  async createApiKey(data) {
    return await this.request('POST', '/admin/api-keys', { data })
  }

  async updateApiKey(keyId, data) {
    return await this.request('PUT', `/admin/api-keys/${encodeURIComponent(keyId)}`, { data })
  }

  async revealApiKey(keyId) {
    return await this.request('POST', `/admin/api-keys/${encodeURIComponent(keyId)}/reveal-secret`)
  }

  async disableApiKey(keyId) {
    return await this.updateApiKey(keyId, { isActive: false })
  }

  async deleteApiKey(keyId) {
    return await this.request('DELETE', `/admin/api-keys/${encodeURIComponent(keyId)}`)
  }

  async listAccounts(accountType = null) {
    if (accountType) {
      const route = this.getAccountRoute(accountType)
      return await this.request('GET', route.basePath)
    }

    const results = await Promise.all(
      this.getAccountTypes().map(async (type) => {
        try {
          const response = await this.listAccounts(type)
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
    return { success: true, data: results }
  }

  async createAccount(accountType, data) {
    const route = this.getAccountRoute(accountType)
    return await this.request('POST', route.basePath, { data })
  }

  async updateAccount(accountType, accountId, data) {
    const route = this.getAccountRoute(accountType)
    return await this.request('PUT', `${route.basePath}/${encodeURIComponent(accountId)}`, { data })
  }

  async deleteAccount(accountType, accountId) {
    const route = this.getAccountRoute(accountType)
    return await this.request('DELETE', `${route.basePath}/${encodeURIComponent(accountId)}`)
  }

  async testAccount(accountType, accountId) {
    const route = this.getAccountRoute(accountType)
    if (!route.testSuffix) {
      throw new Error(`Account type ${accountType} does not expose a test endpoint`)
    }
    return await this.request(
      'POST',
      `${route.basePath}/${encodeURIComponent(accountId)}/${route.testSuffix}`
    )
  }

  async refreshAccount(accountType, accountId) {
    const route = this.getAccountRoute(accountType)
    if (!route.refreshSuffix) {
      throw new Error(`Account type ${accountType} does not expose a refresh endpoint`)
    }
    return await this.request(
      'POST',
      `${route.basePath}/${encodeURIComponent(accountId)}/${route.refreshSuffix}`
    )
  }

  async getUsageSummary() {
    return await this.request('GET', '/admin/dashboard')
  }

  async getApiKeyStats(keyId, params = {}) {
    return await this.request('GET', `/admin/api-keys/${encodeURIComponent(keyId)}/model-stats`, {
      params
    })
  }

  async getAccountStats(accountType, accountId, days = 30) {
    this.getAccountRoute(accountType)
    if (!ACCOUNT_STATS_TYPES.has(accountType)) {
      throw new Error(`Account statistics are not available for account type ${accountType}`)
    }
    return await this.request(
      'GET',
      `/admin/accounts/${encodeURIComponent(accountId)}/usage-history`,
      {
        params: {
          platform: accountType,
          days
        }
      }
    )
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
  ACCOUNT_STATS_TYPES
}
