jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn(),
  isTokenExpired: jest.fn(),
  refreshAccountToken: jest.fn(),
  recordUsage: jest.fn(),
  setAccountRateLimited: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  checkAndClearRateLimit: jest.fn(),
  getAllAccounts: jest.fn(),
  getAccount: jest.fn(),
  getMappedModel: jest.fn(),
  isModelSupported: jest.fn(),
  isSubscriptionExpired: jest.fn(),
  markAccountRateLimited: jest.fn(),
  recordUsage: jest.fn(),
  updateAccount: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/models/redis', () => ({
  getConcurrency: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))
jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn((value) => value !== false && value !== 'false'),
  sortAccountsByPriority: jest.fn((accounts) => accounts)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  isTempUnavailable: jest.fn()
}))

const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const redis = require('../src/models/redis')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')

const modelMappingSupports = (modelMapping, requestedModel) => {
  if (!requestedModel) {
    return true
  }
  const keys = Object.keys(modelMapping || {})
  if (keys.length === 0) {
    return true
  }
  return keys.some((model) => model.toLowerCase() === requestedModel.toLowerCase())
}

describe('UnifiedOpenAIScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    openaiAccountService.getAllAccounts.mockResolvedValue([])
    openaiAccountService.isTokenExpired.mockReturnValue(false)
    openaiResponsesAccountService.getAllAccounts.mockResolvedValue([])
    openaiResponsesAccountService.checkAndClearRateLimit.mockResolvedValue(true)
    openaiResponsesAccountService.isSubscriptionExpired.mockReturnValue(false)
    openaiResponsesAccountService.isModelSupported.mockImplementation(modelMappingSupports)
    openaiResponsesAccountService.recordUsage.mockResolvedValue(undefined)
    redis.getConcurrency.mockResolvedValue(0)
    upstreamErrorHelper.isTempUnavailable.mockResolvedValue(false)
  })

  describe('markAccountRateLimited', () => {
    it('does not disable scheduling again when OpenAI-Responses auto protection is disabled', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'true'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.markAccountRateLimited).toHaveBeenCalledWith(
        'account-1',
        2
      )
      expect(openaiResponsesAccountService.updateAccount).not.toHaveBeenCalled()
    })

    it('keeps disabling scheduling for protected OpenAI-Responses accounts', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'false'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.updateAccount).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({
          schedulable: 'false'
        })
      )
    })
  })

  describe('selectAccountForApiKey', () => {
    it('uses only chat-completions OpenAI-Responses accounts when the endpoint requires it', async () => {
      openaiAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'oauth-1',
          name: 'OAuth',
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          supportedModels: ['glm-5.2']
        }
      ])
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'responses-1',
          name: 'Responses provider',
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          providerEndpoint: 'responses',
          supportedModels: { 'glm-5.2': 'glm-5.2' }
        },
        {
          id: 'chat-1',
          name: 'Chat provider',
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          providerEndpoint: 'chat-completions',
          supportedModels: { 'glm-5.2': 'glm-5.2' }
        }
      ])

      const result = await unifiedOpenAIScheduler.selectAccountForApiKey(
        { name: 'test-key' },
        null,
        'glm-5.2',
        { requiredProviderEndpoint: 'chat-completions' }
      )

      expect(result).toEqual({ accountId: 'chat-1', accountType: 'openai-responses' })
      expect(openaiAccountService.getAllAccounts).not.toHaveBeenCalled()
    })

    it('rejects chat-completions selection when no matching model is configured', async () => {
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([
        {
          id: 'chat-1',
          name: 'Chat provider',
          isActive: true,
          status: 'active',
          accountType: 'shared',
          schedulable: true,
          providerEndpoint: 'chat-completions',
          supportedModels: { 'kimi-k2.7': 'kimi-k2.7' }
        }
      ])

      await expect(
        unifiedOpenAIScheduler.selectAccountForApiKey({ name: 'test-key' }, null, 'glm-5.2', {
          requiredProviderEndpoint: 'chat-completions'
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'No available OpenAI accounts support the requested model: glm-5.2'
      })
    })

    it('rejects a dedicated OpenAI-Responses account with the wrong provider endpoint', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'responses-1',
        name: 'Responses provider',
        isActive: true,
        status: 'active',
        schedulable: true,
        providerEndpoint: 'responses',
        supportedModels: { 'glm-5.2': 'glm-5.2' }
      })

      await expect(
        unifiedOpenAIScheduler.selectAccountForApiKey(
          { name: 'test-key', openaiAccountId: 'responses:responses-1' },
          null,
          'glm-5.2',
          { requiredProviderEndpoint: 'chat-completions' }
        )
      ).rejects.toMatchObject({
        statusCode: 400
      })
    })

    it('allows a dedicated chat-completions account with same-name model mapping', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'chat-1',
        name: 'Chat provider',
        isActive: true,
        status: 'active',
        schedulable: true,
        providerEndpoint: 'chat-completions',
        supportedModels: { 'glm-5.2': 'glm-5.2' }
      })

      const result = await unifiedOpenAIScheduler.selectAccountForApiKey(
        { name: 'test-key', openaiAccountId: 'responses:chat-1' },
        null,
        'glm-5.2',
        { requiredProviderEndpoint: 'chat-completions' }
      )

      expect(result).toEqual({ accountId: 'chat-1', accountType: 'openai-responses' })
      expect(openaiResponsesAccountService.recordUsage).toHaveBeenCalledWith('chat-1', 0)
    })
  })
})
