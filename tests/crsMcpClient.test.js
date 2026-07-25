const { CrsClient } = require('../src/mcp/crsClient')
const axios = require('axios')

describe('CrsClient', () => {
  let httpClient
  let client

  beforeEach(() => {
    httpClient = {
      request: jest.fn().mockResolvedValue({
        data: { success: true }
      })
    }
    client = new CrsClient({
      baseUrl: 'https://crs.example.com/',
      managementKey: `crsm_${'a'.repeat(64)}`,
      httpClient
    })
  })

  test('rejects relay keys as management credentials', () => {
    expect(
      () =>
        new CrsClient({
          baseUrl: 'https://crs.example.com',
          managementKey: `cr_${'a'.repeat(64)}`
        })
    ).toThrow('A valid crsm_ management key is required')
  })

  test('routes relay API key operations to management v1', async () => {
    await client.createApiKey({ name: 'Agent-created' })
    await client.revealApiKey('key/1')
    await client.deleteApiKey('key/1')

    expect(httpClient.request.mock.calls).toEqual([
      [
        {
          method: 'POST',
          url: '/admin/management/v1/api-keys',
          params: undefined,
          data: { name: 'Agent-created' }
        }
      ],
      [
        {
          method: 'POST',
          url: '/admin/management/v1/api-keys/key%2F1/reveal',
          params: undefined,
          data: undefined
        }
      ],
      [
        {
          method: 'DELETE',
          url: '/admin/management/v1/api-keys/key%2F1',
          params: undefined,
          data: undefined
        }
      ]
    ])
  })

  test('routes account lifecycle and statistics operations', async () => {
    await client.createAccount('claude', { name: 'Claude account' })
    await client.testAccount('claude', 'account-1')
    await client.refreshAccount('claude', 'account-1')
    await client.getAccountStats('claude', 'account-1', 14)

    expect(httpClient.request).toHaveBeenNthCalledWith(1, {
      method: 'POST',
      url: '/admin/management/v1/accounts/claude',
      params: undefined,
      data: { name: 'Claude account' }
    })
    expect(httpClient.request).toHaveBeenNthCalledWith(2, {
      method: 'POST',
      url: '/admin/management/v1/accounts/claude/account-1/test',
      params: undefined,
      data: undefined
    })
    expect(httpClient.request).toHaveBeenNthCalledWith(3, {
      method: 'POST',
      url: '/admin/management/v1/accounts/claude/account-1/refresh',
      params: undefined,
      data: undefined
    })
    expect(httpClient.request).toHaveBeenNthCalledWith(4, {
      method: 'GET',
      url: '/admin/management/v1/stats/accounts/claude/account-1',
      params: { platform: 'claude', days: 14 },
      data: undefined
    })
  })

  test('routes audit log queries to management v1', async () => {
    await client.listAuditLogs({ page: 1, pageSize: 20, action: 'account.update' })
    await client.getAuditLog('audit/1')

    expect(httpClient.request).toHaveBeenNthCalledWith(1, {
      method: 'GET',
      url: '/admin/management/v1/audit-logs',
      params: { page: 1, pageSize: 20, action: 'account.update' },
      data: undefined
    })
    expect(httpClient.request).toHaveBeenNthCalledWith(2, {
      method: 'GET',
      url: '/admin/management/v1/audit-logs/audit%2F1',
      params: undefined,
      data: undefined
    })
  })

  test('adds stable device and client headers to the HTTP client', () => {
    const create = jest.spyOn(axios, 'create').mockReturnValue({ request: jest.fn() })

    try {
      new CrsClient({
        baseUrl: 'https://crs.example.com',
        managementKey: `crsm_${'b'.repeat(64)}`,
        deviceId: 'device-office-1',
        deviceName: 'Office Mac',
        clientName: 'crsctl',
        clientVersion: '1.2.0'
      })

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-CRS-Device-ID': 'device-office-1',
            'X-CRS-Device-Name': 'Office%20Mac',
            'X-CRS-Client': 'crsctl/1.2.0'
          })
        })
      )
    } finally {
      create.mockRestore()
    }
  })

  test('falls back to legacy routes when management v1 is not deployed yet', async () => {
    httpClient.request
      .mockRejectedValueOnce({
        response: {
          status: 404,
          data: { message: 'Not found' }
        }
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            items: Array.from({ length: 5 }, (_, index) => ({ id: `key-${index}` })),
            pagination: { page: 1, pageSize: 200, total: 5, totalPages: 1 }
          }
        }
      })

    const response = await client.listApiKeys({ page: 1, pageSize: 2 })

    expect(httpClient.request).toHaveBeenNthCalledWith(1, {
      method: 'GET',
      url: '/admin/management/v1/api-keys',
      params: { page: 1, pageSize: 2 },
      data: undefined
    })
    expect(httpClient.request).toHaveBeenNthCalledWith(2, {
      method: 'GET',
      url: '/admin/api-keys',
      params: { page: 1, pageSize: 2 },
      data: undefined
    })
    expect(response.data.items).toHaveLength(2)
    expect(client.resolvedManagementApiMode).toBe('legacy')
  })

  test('falls back to static capabilities for legacy servers', async () => {
    httpClient.request.mockRejectedValueOnce({
      response: {
        status: 404,
        data: { message: 'Not found' }
      }
    })

    const response = await client.getCapabilities()

    expect(response.apiVersion).toBe('legacy')
    expect(response.data.accounts.map((account) => account.type)).toContain('claude')
  })

  test('surfaces the CRS error response to MCP handlers', async () => {
    httpClient.request.mockRejectedValue({
      response: {
        status: 403,
        data: {
          message: 'Management API access denied'
        }
      }
    })

    await expect(client.getUsageSummary()).rejects.toMatchObject({
      message: 'Management API access denied',
      status: 403
    })
  })
})
