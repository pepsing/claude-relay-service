jest.mock('../src/services/managementApiKeyService', () => ({
  getSupportedScopes: jest.fn(() => ['api-keys:read', 'accounts:read', 'stats:read'])
}))

const { ManagementApiError, ManagementApiService } = require('../src/services/managementApiService')

describe('ManagementApiService', () => {
  let service

  beforeEach(() => {
    service = new ManagementApiService({
      accountDefinitions: {
        claude: {
          test: true,
          refresh: true,
          stats: true,
          getAccounts: jest.fn().mockResolvedValue([
            {
              id: 'account-2',
              name: 'Beta',
              status: 'paused',
              isActive: 'false',
              refreshToken: 'secret-refresh-token'
            },
            {
              id: 'account-1',
              name: 'Alpha',
              status: 'active',
              isActive: 'true',
              apiKey: 'secret-api-key'
            }
          ])
        }
      }
    })
  })

  test('filters, sorts, paginates, and summarizes accounts without credentials', async () => {
    const result = await service.listAccounts('claude', {
      page: 1,
      pageSize: 1,
      search: 'alpha',
      isActive: 'true'
    })

    expect(result).toEqual({
      items: [
        {
          type: 'claude',
          id: 'account-1',
          name: 'Alpha',
          status: 'active',
          isActive: true
        }
      ],
      pagination: {
        page: 1,
        pageSize: 1,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false
      }
    })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  test('rejects unbounded page sizes instead of silently expanding them', () => {
    expect(() => service.parsePagination({ pageSize: '101' })).toThrow(
      expect.objectContaining({
        code: 'INVALID_QUERY_PARAMETER',
        status: 400
      })
    )
  })

  test('rejects unsupported account types with a stable error code', async () => {
    await expect(service.listAccounts('unknown')).rejects.toEqual(
      expect.objectContaining({
        code: 'UNSUPPORTED_ACCOUNT_TYPE',
        status: 400
      })
    )
  })

  test('returns compact API key summaries by default', () => {
    const result = service.summarizeApiKeyResponse({
      success: true,
      data: {
        items: [
          {
            id: 'key-1',
            name: 'Agent',
            keyPreview: 'cr_abcd...123456',
            usage: { total: { tokens: 100 } },
            apiKey: 'persisted-hash'
          }
        ],
        pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 }
      }
    })

    expect(result.data.items).toEqual([
      {
        id: 'key-1',
        name: 'Agent',
        keyPreview: 'cr_abcd...123456'
      }
    ])
  })

  test('describes account operations and the current key scopes', () => {
    expect(service.getCapabilities(['accounts:read'])).toEqual(
      expect.objectContaining({
        version: 'v1',
        scopes: {
          supported: ['api-keys:read', 'accounts:read', 'stats:read'],
          current: ['accounts:read']
        },
        accounts: [
          {
            type: 'claude',
            operations: ['list', 'create', 'update', 'delete', 'test', 'refresh', 'stats']
          }
        ]
      })
    )
  })

  test('exports typed management errors for route adapters', () => {
    const error = new ManagementApiError('EXAMPLE', 'Example failure', 409)

    expect(error).toMatchObject({
      code: 'EXAMPLE',
      message: 'Example failure',
      status: 409
    })
  })
})
