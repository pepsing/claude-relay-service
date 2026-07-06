jest.mock('../src/services/apiKeyService', () => {
  const normalizePermissions = jest.fn((permissions) => {
    if (!permissions) {
      return []
    }
    if (Array.isArray(permissions)) {
      return permissions
    }
    if (permissions === 'all') {
      return []
    }
    return [permissions]
  })

  return {
    getAllApiKeysFast: jest.fn(),
    getApiKeyById: jest.fn(),
    normalizePermissions,
    hasPermission: jest.fn((permissions, service) => {
      const normalized = normalizePermissions(permissions)
      return normalized.length === 0 || normalized.includes(service)
    })
  }
})

jest.mock('../src/services/claudeRelayConfigService', () => ({
  getConfig: jest.fn()
}))

jest.mock('../src/services/requestDetailService', () => ({
  listRequestDetails: jest.fn()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({ getAllAccounts: jest.fn() }))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/ccrAccountService', () => ({ getAllAccounts: jest.fn() }))
jest.mock('../src/services/account/bedrockAccountService', () => ({ getAllAccounts: jest.fn() }))
jest.mock('../src/services/account/openaiAccountService', () => ({ getAllAccounts: jest.fn() }))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/azureOpenaiAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/geminiAccountService', () => ({ getAllAccounts: jest.fn() }))
jest.mock('../src/services/account/geminiApiAccountService', () => ({ getAllAccounts: jest.fn() }))
jest.mock('../src/services/account/droidAccountService', () => ({ getAllAccounts: jest.fn() }))
jest.mock('../src/utils/upstreamErrorHelper', () => ({ isTempUnavailable: jest.fn() }))

const apiKeyService = require('../src/services/apiKeyService')
const claudeRelayConfigService = require('../src/services/claudeRelayConfigService')
const requestDetailService = require('../src/services/requestDetailService')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const ccrAccountService = require('../src/services/account/ccrAccountService')
const bedrockAccountService = require('../src/services/account/bedrockAccountService')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const azureOpenaiAccountService = require('../src/services/account/azureOpenaiAccountService')
const geminiAccountService = require('../src/services/account/geminiAccountService')
const geminiApiAccountService = require('../src/services/account/geminiApiAccountService')
const droidAccountService = require('../src/services/account/droidAccountService')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const routeRulesVisualizationService = require('../src/services/routeRulesVisualizationService')

describe('routeRulesVisualizationService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers().setSystemTime(Date.parse('2026-05-29T10:00:00.000Z'))

    apiKeyService.getAllApiKeysFast.mockResolvedValue([])
    apiKeyService.getApiKeyById.mockResolvedValue(null)
    claudeRelayConfigService.getConfig.mockResolvedValue({ modelEndpointConfigs: {} })
    requestDetailService.listRequestDetails.mockResolvedValue({
      captureEnabled: true,
      readMode: 'redis',
      records: [],
      pagination: { totalRecords: 0 }
    })
    claudeAccountService.getAllAccounts.mockResolvedValue([])
    claudeConsoleAccountService.getAllAccounts.mockResolvedValue([])
    ccrAccountService.getAllAccounts.mockResolvedValue([])
    bedrockAccountService.getAllAccounts.mockResolvedValue({ success: true, data: [] })
    openaiAccountService.getAllAccounts.mockResolvedValue([])
    openaiResponsesAccountService.getAllAccounts.mockResolvedValue([])
    azureOpenaiAccountService.getAllAccounts.mockResolvedValue([])
    geminiAccountService.getAllAccounts.mockResolvedValue([])
    geminiApiAccountService.getAllAccounts.mockResolvedValue([])
    droidAccountService.getAllAccounts.mockResolvedValue([])
    upstreamErrorHelper.isTempUnavailable.mockResolvedValue(false)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('returns endpoint definitions and sanitized api key options', async () => {
    apiKeyService.getAllApiKeysFast.mockResolvedValue([
      {
        id: 'key_1',
        name: 'office-dev',
        isActive: true,
        permissions: ['claude'],
        claudeConsoleAccountId: 'console-a'
      }
    ])

    const result = await routeRulesVisualizationService.getEndpoints()

    expect(result.defaultEndpoint).toBe('claude')
    expect(result.endpoints.map((endpoint) => endpoint.id)).toContain('claude')
    expect(result.endpoints.find((endpoint) => endpoint.id === 'claude')).toMatchObject({
      defaultModel: 'claude-sonnet-5',
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'claude-sonnet-5' }),
        expect.objectContaining({ id: 'claude-fable-5' })
      ])
    })
    expect(result.endpoints.find((endpoint) => endpoint.id === 'claude').models).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ id: 'ccr,claude-sonnet-5' }),
        expect.objectContaining({ id: 'ccr,claude-sonnet-4-6' }),
        expect.objectContaining({ id: 'bedrock anthropic.*' })
      ])
    )
    expect(result.apiKeys).toEqual([
      expect.objectContaining({
        id: 'key_1',
        name: 'office-dev',
        permissions: ['claude'],
        bindings: expect.objectContaining({ claudeConsoleAccountId: 'console-a' })
      })
    ])
  })

  test('keeps latest static Claude models visible when endpoint settings were saved earlier', async () => {
    claudeRelayConfigService.getConfig.mockResolvedValue({
      modelEndpointConfigs: {
        claude: {
          whitelistModels: [{ value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' }]
        }
      }
    })

    const result = await routeRulesVisualizationService.getEndpoints()
    const claude = result.endpoints.find((endpoint) => endpoint.id === 'claude')

    expect(claude.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(['claude-sonnet-5', 'claude-fable-5', 'claude-sonnet-4-6'])
    )
  })

  test('explains claude model candidates with live qpm, quotas and availability', async () => {
    apiKeyService.getApiKeyById.mockResolvedValue({
      id: 'key_1',
      name: 'office-dev',
      isActive: true,
      permissions: ['claude']
    })
    claudeConsoleAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'console-a',
        name: 'ai-pincc-cc',
        platform: 'claude-console',
        priority: 49,
        supportedModels: ['claude-sonnet-4-6'],
        isActive: true,
        status: 'active',
        schedulable: true,
        accountType: 'shared',
        dailyQuota: 600,
        dailyUsage: 215.45,
        maxConcurrentTasks: 0,
        activeTaskCount: 3
      },
      {
        id: 'console-b',
        name: 'ai-tokensaver-claude',
        platform: 'claude-console',
        priority: 30,
        supportedModels: ['claude-opus-4-6'],
        isActive: true,
        status: 'active',
        schedulable: false,
        accountType: 'shared',
        dailyQuota: 200,
        dailyUsage: 0
      }
    ])
    requestDetailService.listRequestDetails.mockResolvedValue({
      captureEnabled: true,
      readMode: 'redis',
      records: [
        {
          timestamp: '2026-05-29T09:59:30.000Z',
          endpoint: '/api/v1/messages',
          statusCode: 200,
          accountId: 'console-a',
          accountType: 'claude-console',
          model: 'claude-sonnet-4-6',
          totalTokens: 9000,
          durationMs: 1200
        },
        {
          timestamp: '2026-05-29T09:59:45.000Z',
          endpoint: '/api/v1/messages',
          statusCode: 429,
          accountId: 'console-a',
          accountType: 'claude-console',
          model: 'claude-sonnet-4-6',
          totalTokens: 0,
          durationMs: 900
        }
      ],
      pagination: { totalRecords: 2 }
    })

    const result = await routeRulesVisualizationService.getExplain({
      endpoint: 'claude',
      model: 'claude-sonnet-4-6',
      apiKeyId: 'key_1'
    })

    const routable = result.accounts.find((account) => account.id === 'console-a')
    const excluded = result.accounts.find((account) => account.id === 'console-b')

    expect(result.summary.routableCount).toBe(1)
    expect(result.modelRoutes.map((model) => model.id)).toEqual(
      expect.arrayContaining(['claude-sonnet-4-6', 'claude-opus-4-6'])
    )
    expect(routable).toMatchObject({
      routeStatus: 'routable',
      priority: 49,
      editAccount: expect.objectContaining({
        id: 'console-a',
        platform: 'claude-console',
        supportedModels: ['claude-sonnet-4-6']
      }),
      daily: expect.objectContaining({ quota: 600, usage: 215.45 }),
      modelMapping: expect.objectContaining({
        selected: expect.objectContaining({
          sourceModel: 'claude-sonnet-4-6',
          mappedModel: 'claude-sonnet-4-6'
        })
      }),
      live: expect.objectContaining({ rpm: 0.4, tpm: 1800, rateLimitedCount: 1 })
    })
    expect(routable.health.availabilityPercent).toBe(50)
    expect(routable.live.history).toHaveLength(60)
    expect(excluded.routeStatus).toBe('excluded')
    expect(excluded.excludedReasons).toEqual(expect.arrayContaining(['model_not_supported']))
  })

  test('uses ccr account pool when claude model has ccr prefix', async () => {
    claudeConsoleAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'console-a',
        name: 'ai-pincc-cc',
        priority: 49,
        supportedModels: ['claude-sonnet-4-6'],
        isActive: true,
        status: 'active',
        schedulable: true
      }
    ])
    ccrAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'ccr-a',
        name: 'ccr-shared',
        priority: 10,
        supportedModels: ['claude-sonnet-4-6'],
        isActive: true,
        status: 'active',
        schedulable: true
      }
    ])

    const result = await routeRulesVisualizationService.getExplain({
      endpoint: 'claude',
      model: 'ccr,claude-sonnet-4-6'
    })

    const ccrAccount = result.accounts.find((account) => account.id === 'ccr-a')
    const consoleAccount = result.accounts.find((account) => account.id === 'console-a')

    expect(result.routeAccountTypes).toEqual(['ccr'])
    expect(ccrAccount.routeStatus).toBe('routable')
    expect(consoleAccount.routeStatus).toBe('excluded')
    expect(consoleAccount.excludedReasons).toContain('endpoint_pool_mismatch')
  })

  test('merges accepted model list from account supported model mappings', async () => {
    claudeConsoleAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'console-custom',
        name: 'custom-console',
        priority: 20,
        supportedModels: {
          'custom-sonnet': 'claude-sonnet-4-6',
          'aliyun-claude': 'claude-sonnet-4-20250514',
          Qwen: 'qwen-max',
          Kimi: 'kimi-k2',
          GLM: 'glm-5.1',
          'deepseek-chat': 'deepseek-chat'
        },
        isActive: true,
        status: 'active',
        schedulable: true
      }
    ])
    ccrAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'ccr-custom',
        name: 'custom-ccr',
        priority: 30,
        supportedModels: {
          'vendor-sonnet': 'claude-sonnet-4-6'
        },
        isActive: true,
        status: 'active',
        schedulable: true
      }
    ])

    const result = await routeRulesVisualizationService.getExplain({
      endpoint: 'claude',
      model: 'custom-sonnet'
    })

    const modelIds = result.modelRoutes.map((model) => model.id)
    const customRoute = result.modelRoutes.find((model) => model.id === 'custom-sonnet')

    expect(modelIds).toEqual(
      expect.arrayContaining([
        'custom-sonnet',
        'Qwen',
        'Kimi',
        'GLM',
        'deepseek-chat',
        'ccr,vendor-sonnet'
      ])
    )
    expect(modelIds).not.toContain('aliyun-claude')
    expect(customRoute).toMatchObject({
      selected: true,
      candidateCount: 1,
      routableCount: 1
    })
  })

  test('limits OpenAI Chat route rules to chat-completions OpenAI-Responses accounts', async () => {
    openaiAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'oauth-openai',
        name: 'OAuth OpenAI',
        priority: 10,
        supportedModels: ['glm-5.2'],
        isActive: true,
        status: 'active',
        schedulable: true
      }
    ])
    openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
      {
        id: 'responses-provider',
        name: 'Responses provider',
        priority: 20,
        providerEndpoint: 'responses',
        supportedModels: { 'kimi-k2.7': 'kimi-k2.7' },
        isActive: true,
        status: 'active',
        schedulable: true,
        accountType: 'shared'
      },
      {
        id: 'chat-provider',
        name: 'Chat provider',
        priority: 30,
        providerEndpoint: 'chat-completions',
        supportedModels: { 'glm-5.2': 'glm-5.2' },
        isActive: true,
        status: 'active',
        schedulable: true,
        accountType: 'shared'
      }
    ])

    const result = await routeRulesVisualizationService.getExplain({
      endpoint: 'openai',
      model: 'glm-5.2'
    })

    expect(result.routeAccountTypes).toEqual(['openai-responses'])
    expect(result.accounts.map((account) => account.id)).toEqual(['chat-provider'])
    expect(result.modelRoutes.map((model) => model.id)).toEqual(expect.arrayContaining(['glm-5.2']))
    expect(result.modelRoutes.map((model) => model.id)).not.toContain('kimi-k2.7')
    expect(openaiAccountService.getAllAccounts).not.toHaveBeenCalled()
  })
})
