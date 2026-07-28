jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, _res, next) => {
    req.admin = {
      username: 'management-key:test',
      authType: 'management-api-key',
      scopes: ['api-keys:read', 'accounts:read', 'accounts:write', 'stats:read']
    }
    next()
  }
}))

jest.mock('../src/services/managementApiKeyService', () => ({
  getSupportedScopes: jest.fn(() => ['api-keys:read', 'accounts:read', 'stats:read'])
}))

const express = require('express')
const request = require('supertest')
const { ManagementApiService } = require('../src/services/managementApiService')
const { createManagementV1Router } = require('../src/routes/admin/managementV1')

function createLegacyRouters() {
  const apiKeys = express.Router()
  apiKeys.get('/api-keys', (req, res) =>
    res.json({
      success: true,
      data: {
        items: [
          {
            id: 'key-1',
            name: 'Agent',
            keyPreview: 'cr_abcd...123456',
            apiKey: 'persisted-hash',
            usage: { total: { tokens: 100 } }
          }
        ],
        pagination: {
          page: Number(req.query.page),
          pageSize: Number(req.query.pageSize),
          total: 1,
          totalPages: 1
        }
      }
    })
  )
  apiKeys.post('/api-keys', (_req, res) =>
    res.status(400).json({
      error: 'INVALID_KEY',
      message: `Rejected crsm_${'a'.repeat(64)}`
    })
  )

  const claude = express.Router()
  claude.post('/claude-accounts', (_req, res) =>
    res.json({
      success: true,
      data: {
        id: 'account-1',
        name: 'Created',
        accessToken: 'secret-access-token',
        awsAccessKeyId: 'secret-access-key-id',
        openaiOauth: 'secret-oauth-json',
        proxy: { password: 'secret-proxy-password' }
      }
    })
  )

  const dashboard = express.Router()
  dashboard.get('/dashboard', (_req, res) => res.json({ success: true, data: { requests: 3 } }))

  return {
    apiKeys,
    dashboard,
    usageStats: express.Router(),
    accounts: {
      claude: {
        router: claude,
        basePath: '/claude-accounts',
        testSuffix: 'test',
        refreshSuffix: 'refresh'
      }
    }
  }
}

describe('management v1 routes', () => {
  let app
  let auditService
  let quotaCycleService

  beforeEach(() => {
    const service = new ManagementApiService({
      accountDefinitions: {
        claude: {
          test: true,
          refresh: true,
          stats: true,
          getAccounts: jest.fn().mockResolvedValue([
            {
              id: 'account-1',
              name: 'Alpha',
              status: 'active',
              refreshToken: 'secret-refresh-token'
            },
            {
              id: 'account-2',
              name: 'Beta',
              status: 'paused',
              apiKey: 'secret-api-key'
            }
          ])
        }
      }
    })

    auditService = {
      list: jest.fn().mockResolvedValue({
        items: [{ id: '1', action: 'account.update', result: 'success' }],
        pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 }
      }),
      getById: jest
        .fn()
        .mockResolvedValueOnce({ id: '1', action: 'account.update', result: 'success' })
    }
    quotaCycleService = {
      listCycles: jest.fn().mockResolvedValue({
        items: [
          {
            cycleId: 'quota-1',
            provider: 'zhipu',
            windowType: 'weekly',
            usageSummary: { totals: { requests: 12, totalTokens: 3456 } }
          }
        ],
        pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 }
      }),
      getCycle: jest.fn().mockResolvedValue({
        cycleId: 'quota-1',
        provider: 'zhipu',
        windowType: 'weekly'
      })
    }

    app = express()
    app.use(express.json())
    app.use(
      '/admin/management/v1',
      createManagementV1Router({
        service,
        auditService,
        quotaCycleService,
        legacyRouters: createLegacyRouters()
      })
    )
  })

  test('reports API capabilities and current key scopes', async () => {
    const response = await request(app).get('/admin/management/v1/capabilities')

    expect(response.status).toBe(200)
    expect(response.body.apiVersion).toBe('v1')
    expect(response.body.data.version).toBe('v1')
    expect(response.body.data.scopes.current).toContain('accounts:read')
  })

  test('returns server-bounded account summaries without credentials', async () => {
    const response = await request(app).get(
      '/admin/management/v1/accounts/claude?page=1&pageSize=1'
    )

    expect(response.status).toBe(200)
    expect(response.body.data.items).toHaveLength(1)
    expect(response.body.data.pagination).toEqual(
      expect.objectContaining({
        page: 1,
        pageSize: 1,
        total: 2,
        hasNext: true
      })
    )
    expect(JSON.stringify(response.body)).not.toContain('secret')
  })

  test('delegates API key listing with strict pagination and summary output', async () => {
    const response = await request(app).get('/admin/management/v1/api-keys?page=1&pageSize=1')

    expect(response.status).toBe(200)
    expect(response.body.data.pagination.pageSize).toBe(1)
    expect(response.body.data.items).toEqual([
      {
        id: 'key-1',
        name: 'Agent',
        keyPreview: 'cr_abcd...123456'
      }
    ])
  })

  test('returns a stable 400 error instead of expanding an invalid page size', async () => {
    const response = await request(app).get('/admin/management/v1/api-keys?page=1&pageSize=101')

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      success: false,
      apiVersion: 'v1',
      error: {
        code: 'INVALID_QUERY_PARAMETER',
        message: 'pageSize must be an integer between 1 and 100'
      },
      message: 'pageSize must be an integer between 1 and 100'
    })
  })

  test('sanitizes account mutation responses', async () => {
    const response = await request(app)
      .post('/admin/management/v1/accounts/claude')
      .send({ name: 'Created', accessToken: 'request-secret' })

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({
      id: 'account-1',
      name: 'Created'
    })
    expect(JSON.stringify(response.body)).not.toContain('secret')
  })

  test('normalizes legacy errors and redacts management keys', async () => {
    const response = await request(app)
      .post('/admin/management/v1/api-keys')
      .send({ name: 'Invalid' })

    expect(response.status).toBe(400)
    expect(response.body.error).toEqual({
      code: 'INVALID_KEY',
      message: 'Rejected crsm_[REDACTED]'
    })
  })

  test('lists and retrieves management audit logs', async () => {
    const listResponse = await request(app).get(
      '/admin/management/v1/audit-logs?page=1&pageSize=20&action=account.update'
    )
    const getResponse = await request(app).get('/admin/management/v1/audit-logs/1')

    expect(listResponse.status).toBe(200)
    expect(listResponse.body.apiVersion).toBe('v1')
    expect(listResponse.body.data.items[0].action).toBe('account.update')
    expect(auditService.list).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        pageSize: 20,
        action: 'account.update'
      })
    )
    expect(getResponse.status).toBe(200)
    expect(getResponse.body.data.id).toBe('1')
  })

  test('lists and retrieves quota cycle usage summaries', async () => {
    const listResponse = await request(app).get(
      '/admin/management/v1/stats/quota-cycles?provider=zhipu&windowType=weekly&page=1&pageSize=20'
    )
    const getResponse = await request(app).get('/admin/management/v1/stats/quota-cycles/quota-1')

    expect(listResponse.status).toBe(200)
    expect(listResponse.body.data.items[0].usageSummary.totals.totalTokens).toBe(3456)
    expect(quotaCycleService.listCycles).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'zhipu',
        windowType: 'weekly',
        page: '1',
        pageSize: '20'
      })
    )
    expect(getResponse.status).toBe(200)
    expect(getResponse.body.data.cycleId).toBe('quota-1')
  })

  test('returns a stable not-found error for an unknown audit record', async () => {
    auditService.getById.mockReset().mockResolvedValue(null)

    const response = await request(app).get('/admin/management/v1/audit-logs/404')

    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('AUDIT_LOG_NOT_FOUND')
  })
})
