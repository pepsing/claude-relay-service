const { CrsClient } = require('../src/mcp/crsClient')

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

  test('routes relay API key operations to the existing admin API', async () => {
    await client.createApiKey({ name: 'Agent-created' })
    await client.revealApiKey('key/1')
    await client.deleteApiKey('key/1')

    expect(httpClient.request.mock.calls).toEqual([
      [
        {
          method: 'POST',
          url: '/admin/api-keys',
          params: undefined,
          data: { name: 'Agent-created' }
        }
      ],
      [
        {
          method: 'POST',
          url: '/admin/api-keys/key%2F1/reveal-secret',
          params: undefined,
          data: undefined
        }
      ],
      [
        {
          method: 'DELETE',
          url: '/admin/api-keys/key%2F1',
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
      url: '/admin/claude-accounts',
      params: undefined,
      data: { name: 'Claude account' }
    })
    expect(httpClient.request).toHaveBeenNthCalledWith(2, {
      method: 'POST',
      url: '/admin/claude-accounts/account-1/test',
      params: undefined,
      data: undefined
    })
    expect(httpClient.request).toHaveBeenNthCalledWith(3, {
      method: 'POST',
      url: '/admin/claude-accounts/account-1/refresh',
      params: undefined,
      data: undefined
    })
    expect(httpClient.request).toHaveBeenNthCalledWith(4, {
      method: 'GET',
      url: '/admin/accounts/account-1/usage-history',
      params: { platform: 'claude', days: 14 },
      data: undefined
    })
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
