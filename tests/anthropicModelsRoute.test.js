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

jest.mock('../src/services/relay/claudeRelayService', () => ({}))
jest.mock('../src/services/relay/claudeConsoleRelayService', () => ({}))
jest.mock('../src/services/relay/bedrockRelayService', () => ({}))
jest.mock('../src/services/relay/ccrRelayService', () => ({}))
jest.mock('../src/services/account/bedrockAccountService', () => ({}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({}))
jest.mock('../src/utils/sessionHelper', () => ({}))
jest.mock('../src/services/claudeRelayConfigService', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({}))
jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))
jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((_req, _res, next) => next())
}))
jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true)
}))
jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  security: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}))
jest.mock('../src/utils/modelHelper', () => ({
  getEffectiveModel: jest.fn((model) => String(model || '').replace(/^ccr,/, '')),
  parseVendorPrefixedModel: jest.fn((model) => ({ vendor: null, model }))
}))
jest.mock('../src/utils/warmupInterceptor', () => ({
  isWarmupRequest: jest.fn(() => false),
  buildMockWarmupResponse: jest.fn(),
  sendMockWarmupStream: jest.fn()
}))
jest.mock('../src/utils/errorSanitizer', () => ({
  sanitizeUpstreamError: jest.fn((error) => error)
}))
jest.mock('../src/utils/anthropicRequestDump', () => ({
  dumpAnthropicMessagesRequest: jest.fn()
}))
jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => null)
}))
jest.mock('../src/services/anthropicGeminiBridgeService', () => ({
  handleAnthropicMessagesToGemini: jest.fn(),
  handleAnthropicCountTokensToGemini: jest.fn()
}))
jest.mock('../config/models', () => ({
  CLAUDE_MODELS: [
    { value: 'claude-sonnet-5', label: 'claude-sonnet-5' },
    { value: 'claude-fable-5', label: 'claude-fable-5' },
    { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001' }
  ]
}))

const apiKeyService = require('../src/services/apiKeyService')
const apiRoutes = require('../src/routes/api')
const registeredGetRoutes = [...mockRouter.get.mock.calls]

function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
    json: jest.fn((payload) => {
      res.body = payload
      return res
    }),
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    })
  }
  return res
}

function findGetHandler(path) {
  const route = registeredGetRoutes.find((call) => call[0] === path)
  return route?.filter((item) => typeof item === 'function').pop()
}

describe('Anthropic models route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.hasPermission.mockReturnValue(true)
  })

  test('returns Anthropic-native model list shape with pagination metadata', async () => {
    const handler = findGetHandler('/v1/models')
    const res = createResponse()

    await handler(
      {
        apiKey: { permissions: ['claude'] },
        query: { limit: '2' }
      },
      res
    )

    expect(res.body).toEqual({
      data: [
        expect.objectContaining({
          type: 'model',
          id: 'claude-sonnet-5',
          display_name: 'Claude Sonnet 5',
          created_at: '1970-01-01T00:00:00Z',
          max_input_tokens: 200000,
          max_tokens: 64000,
          capabilities: expect.any(Object)
        }),
        expect.objectContaining({
          type: 'model',
          id: 'claude-fable-5'
        })
      ],
      first_id: 'claude-sonnet-5',
      has_more: true,
      last_id: 'claude-fable-5'
    })
    expect(res.body.data[0].object).toBeUndefined()
    expect(res.body.object).toBeUndefined()
  })

  test('filters restricted models as a blacklist', async () => {
    const models = apiRoutes.getAnthropicModelInfos({
      enableModelRestriction: true,
      restrictedModels: ['claude-fable-5']
    })

    expect(models.map((model) => model.id)).toEqual([
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001'
    ])
  })

  test('returns Anthropic error shape for invalid pagination parameters', async () => {
    const handler = findGetHandler('/v1/models')
    const res = createResponse()

    await handler(
      {
        apiKey: { permissions: ['claude'] },
        query: { limit: '0' }
      },
      res
    )

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.body).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'limit must be an integer between 1 and 1000'
      }
    })
  })
})
