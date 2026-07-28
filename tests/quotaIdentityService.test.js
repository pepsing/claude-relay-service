const mockClaudeConsoleAccountService = {
  getAllAccounts: jest.fn(),
  getAccount: jest.fn()
}
const mockOpenAIResponsesAccountService = {
  getAllAccounts: jest.fn(),
  getAccount: jest.fn()
}

jest.mock(
  '../src/services/account/claudeConsoleAccountService',
  () => mockClaudeConsoleAccountService
)
jest.mock(
  '../src/services/account/openaiResponsesAccountService',
  () => mockOpenAIResponsesAccountService
)
jest.mock('../src/utils/logger', () => ({
  warn: jest.fn()
}))

const { QuotaIdentityService } = require('../src/services/quotaIdentityService')

describe('QuotaIdentityService', () => {
  let service

  beforeEach(() => {
    jest.clearAllMocks()
    service = new QuotaIdentityService({ secret: 'test-quota-secret' })
    mockClaudeConsoleAccountService.getAccount.mockReset()
    mockOpenAIResponsesAccountService.getAccount.mockReset()
    mockClaudeConsoleAccountService.getAllAccounts.mockResolvedValue([])
    mockOpenAIResponsesAccountService.getAllAccounts.mockResolvedValue([])
  })

  test('builds a stable opaque group id across provider endpoint paths', () => {
    const claudeGroupId = service.buildQuotaGroupId('zhipu', {
      apiUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'provider-secret'
    })
    const responsesGroupId = service.buildQuotaGroupId('zhipu', {
      baseApi: 'https://open.bigmodel.cn/api/coding',
      apiKey: 'provider-secret'
    })

    expect(claudeGroupId).toBe(responsesGroupId)
    expect(claudeGroupId).toMatch(/^qg_[a-f0-9]{64}$/)
    expect(claudeGroupId).not.toContain('provider-secret')
  })

  test('uses one quota identity across known Zhipu host aliases', () => {
    const mainlandGroupId = service.buildQuotaGroupId('zhipu', {
      apiUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'provider-secret'
    })
    const globalGroupId = service.buildQuotaGroupId('zhipu', {
      baseApi: 'https://api.z.ai/api/coding',
      apiKey: 'provider-secret'
    })

    expect(mainlandGroupId).toBe(globalGroupId)
  })

  test('separates credentials and providers', () => {
    const account = {
      apiUrl: 'https://api.kimi.com/coding/v1/messages',
      apiKey: 'key-a'
    }

    expect(service.buildQuotaGroupId('kimi', account)).not.toBe(
      service.buildQuotaGroupId('kimi', { ...account, apiKey: 'key-b' })
    )
    expect(service.buildQuotaGroupId('kimi', account)).not.toBe(
      service.buildQuotaGroupId('zhipu', {
        apiUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiKey: 'key-a'
      })
    )
  })

  test('resolves linked Claude Console and Responses accounts sharing credentials', async () => {
    const currentAccount = {
      id: 'claude-1',
      name: 'glm-claude',
      apiUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'shared-key'
    }
    mockClaudeConsoleAccountService.getAllAccounts.mockResolvedValue([
      { id: 'claude-1', apiUrl: currentAccount.apiUrl }
    ])
    mockClaudeConsoleAccountService.getAccount.mockResolvedValue(currentAccount)
    mockOpenAIResponsesAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'responses-1',
        baseApi: 'https://open.bigmodel.cn/api/coding'
      },
      {
        id: 'kimi-1',
        baseApi: 'https://api.kimi.com/coding'
      }
    ])
    mockOpenAIResponsesAccountService.getAccount.mockImplementation(async (accountId) => {
      if (accountId === 'responses-1') {
        return {
          id: accountId,
          name: 'glm-chat',
          baseApi: 'https://open.bigmodel.cn/api/coding',
          apiKey: 'shared-key'
        }
      }
      return {
        id: accountId,
        name: 'kimi-chat',
        baseApi: 'https://api.kimi.com/coding',
        apiKey: 'shared-key'
      }
    })

    const result = await service.resolveQuotaContext('zhipu', 'claude-console', currentAccount)

    expect(result.provider).toBe('zhipu')
    expect(result.accountRefs).toEqual([
      {
        accountType: 'claude-console',
        accountId: 'claude-1',
        accountName: 'glm-claude'
      },
      {
        accountType: 'openai-responses',
        accountId: 'responses-1',
        accountName: 'glm-chat'
      }
    ])
    expect(result.complete).toBe(true)
  })

  test('keeps scanning linked accounts but reports incomplete discovery after one failure', async () => {
    const currentAccount = {
      id: 'current',
      name: 'current',
      apiUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'shared-key'
    }
    mockClaudeConsoleAccountService.getAllAccounts.mockResolvedValue([
      { id: 'broken', apiUrl: currentAccount.apiUrl },
      { id: 'linked', apiUrl: currentAccount.apiUrl }
    ])
    mockClaudeConsoleAccountService.getAccount.mockImplementation(async (accountId) => {
      if (accountId === 'broken') {
        throw new Error('decrypt failed')
      }
      return {
        id: accountId,
        name: accountId,
        apiUrl: currentAccount.apiUrl,
        apiKey: 'shared-key'
      }
    })

    const result = await service.resolveQuotaContext('zhipu', 'claude-console', currentAccount)

    expect(result.complete).toBe(false)
    expect(result.accountRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: 'current' }),
        expect.objectContaining({ accountId: 'linked' })
      ])
    )
  })
})
