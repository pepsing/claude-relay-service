const mockRouter = {
  get: jest.fn(),
  post: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000
  }),
  { virtual: true }
)

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((_req, _res, next) => next())
}))

jest.mock('axios', () => jest.fn())

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  markAccountRateLimited: jest.fn(),
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  removeAccountRateLimit: jest.fn(),
  markAccountUnauthorized: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn(),
  decrypt: jest.fn(),
  isTokenExpired: jest.fn(() => false),
  refreshAccountToken: jest.fn(),
  updateCodexUsageSnapshot: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn(),
  isSubscriptionExpired: jest.fn(() => false)
}))

jest.mock('../src/services/accountGroupService', () => ({
  getGroup: jest.fn(),
  getGroupMembers: jest.fn()
}))

jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({
  handleRequest: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true),
  recordUsage: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getUsageStats: jest.fn(),
  incrConcurrency: jest.fn(),
  decrConcurrency: jest.fn(),
  refreshConcurrencyLease: jest.fn(),
  getConcurrency: jest.fn().mockResolvedValue(0)
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  isTempUnavailable: jest.fn().mockResolvedValue(false)
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/sseParser', () => ({
  IncrementalSSEParser: jest.fn().mockImplementation(() => ({
    feed: jest.fn(() => []),
    getRemaining: jest.fn(() => '')
  }))
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  getSafeMessage: jest.fn((error) => error?.message || 'error')
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => null),
  extractOpenAICacheReadTokens: jest.fn(() => 0)
}))

const apiKeyService = require('../src/services/apiKeyService')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const accountGroupService = require('../src/services/accountGroupService')
const openaiRoutes = require('../src/routes/openaiRoutes')
const registeredGetRoutes = [...mockRouter.get.mock.calls]

const modelIds = (models) => models.map((model) => model.id)

describe('OpenAI models route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    openaiAccountService.isTokenExpired.mockReturnValue(false)
    openaiAccountService.getAllAccounts.mockResolvedValue([])
    openaiAccountService.getAccount.mockResolvedValue(null)
    openaiResponsesAccountService.getAllAccounts.mockResolvedValue([])
    openaiResponsesAccountService.getAccount.mockResolvedValue(null)
    openaiResponsesAccountService.isSubscriptionExpired.mockReturnValue(false)
    accountGroupService.getGroup.mockResolvedValue(null)
    accountGroupService.getGroupMembers.mockResolvedValue([])
    apiKeyService.hasPermission.mockReturnValue(true)
  })

  test('registers the OpenAI standard models route', () => {
    expect(registeredGetRoutes).toContainEqual([
      '/v1/models',
      expect.any(Function),
      openaiRoutes.handleModels
    ])
  })

  test('aggregates model ids from shared OpenAI responses and chat accounts without splitting endpoint type', async () => {
    openaiAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'oauth-1',
        name: 'OpenAI OAuth',
        isActive: true,
        status: 'active',
        accountType: 'shared',
        schedulable: true,
        hasRefreshToken: true
      }
    ])
    openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'chat-1',
        name: 'Kimi Chat',
        isActive: 'true',
        status: 'active',
        accountType: 'shared',
        schedulable: 'true',
        providerEndpoint: 'chat-completions',
        supportedModels: {
          'kimi-k2.6': 'kimi-k2.6'
        }
      },
      {
        id: 'responses-1',
        name: 'OpenAI Responses',
        isActive: 'true',
        status: 'active',
        accountType: 'shared',
        schedulable: 'true',
        providerEndpoint: 'responses',
        supportedModels: {
          'gpt-custom-responses': 'gpt-custom-responses'
        }
      }
    ])

    const models = await openaiRoutes.buildOpenAIModelsList({ permissions: ['openai'] })
    const ids = modelIds(models)

    expect(ids).toContain('gpt-5')
    expect(ids).toContain('kimi-k2.6')
    expect(ids).toContain('gpt-custom-responses')
    expect(models[0]).toEqual(
      expect.objectContaining({
        object: 'model',
        owned_by: 'openai'
      })
    )
  })

  test('uses only a bound OpenAI responses account when API key is dedicated', async () => {
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'dedicated-1',
      name: 'Dedicated Chat',
      isActive: 'true',
      status: 'active',
      accountType: 'dedicated',
      schedulable: 'true',
      providerEndpoint: 'chat-completions',
      supportedModels: {
        'deepseek-v4-pro': 'deepseek-v4-pro'
      }
    })

    const models = await openaiRoutes.buildOpenAIModelsList({
      permissions: ['openai'],
      openaiAccountId: 'responses:dedicated-1'
    })

    expect(modelIds(models)).toEqual(['deepseek-v4-pro'])
    expect(openaiAccountService.getAllAccounts).not.toHaveBeenCalled()
    expect(openaiResponsesAccountService.getAllAccounts).not.toHaveBeenCalled()
  })

  test('aggregates model ids from an OpenAI account group', async () => {
    accountGroupService.getGroup.mockResolvedValue({
      id: 'openai-group',
      name: 'OpenAI group',
      platform: 'openai'
    })
    accountGroupService.getGroupMembers.mockResolvedValue(['oauth-1', 'responses-1'])
    openaiAccountService.getAccount.mockImplementation(async (accountId) => {
      if (accountId !== 'oauth-1') {
        return null
      }

      return {
        id: 'oauth-1',
        name: 'OpenAI OAuth',
        isActive: 'true',
        status: 'active',
        accountType: 'shared',
        schedulable: 'true',
        hasRefreshToken: true,
        supportedModels: ['gpt-5']
      }
    })
    openaiResponsesAccountService.getAccount.mockImplementation(async (accountId) => {
      if (accountId !== 'responses-1') {
        return null
      }

      return {
        id: 'responses-1',
        name: 'OpenAI Chat',
        isActive: 'true',
        status: 'active',
        accountType: 'shared',
        schedulable: 'true',
        supportedModels: {
          'kimi-for-coding': 'kimi-for-coding'
        }
      }
    })

    const models = await openaiRoutes.buildOpenAIModelsList({
      permissions: ['openai'],
      openaiAccountId: 'group:openai-group'
    })

    expect(modelIds(models)).toEqual(['gpt-5', 'kimi-for-coding'])
    expect(openaiAccountService.getAllAccounts).not.toHaveBeenCalled()
    expect(openaiResponsesAccountService.getAllAccounts).not.toHaveBeenCalled()
  })

  test('applies API key model restriction as a blacklist', async () => {
    openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'chat-1',
        name: 'Kimi Chat',
        isActive: 'true',
        status: 'active',
        accountType: 'shared',
        schedulable: 'true',
        supportedModels: {
          'kimi-k2.6': 'kimi-k2.6',
          'deepseek-v4-pro': 'deepseek-v4-pro'
        }
      }
    ])

    const models = await openaiRoutes.buildOpenAIModelsList({
      permissions: ['openai'],
      enableModelRestriction: true,
      restrictedModels: ['kimi-k2.6']
    })

    expect(modelIds(models)).toEqual(['deepseek-v4-pro'])
  })
})
