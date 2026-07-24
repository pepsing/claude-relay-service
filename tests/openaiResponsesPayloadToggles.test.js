const crypto = require('crypto')
const { PassThrough } = require('stream')

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

jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  markAccountRateLimited: jest.fn(),
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  removeAccountRateLimit: jest.fn(),
  markAccountUnauthorized: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  decrypt: jest.fn(),
  isTokenExpired: jest.fn(() => false),
  refreshAccountToken: jest.fn(),
  updateCodexUsageSnapshot: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({
  handleRequest: jest.fn()
}))

jest.mock('../src/services/claudeRelayConfigService', () => ({
  getConfig: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true),
  recordUsage: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getUsageStats: jest.fn(),
  incrConcurrency: jest.fn(),
  decrConcurrency: jest.fn(),
  refreshConcurrencyLease: jest.fn()
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

const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const axios = require('axios')
const apiKeyService = require('../src/services/apiKeyService')
const redis = require('../src/models/redis')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')
const claudeRelayConfigService = require('../src/services/claudeRelayConfigService')
const errorSanitizer = require('../src/utils/errorSanitizer')
const openaiRoutes = require('../src/routes/openaiRoutes')

function createHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function createReq({
  path = '/v1/responses',
  body = {},
  userAgent = 'my-client/1.0',
  apiKeyOverrides = {},
  fromUnifiedEndpoint = false
} = {}) {
  return {
    method: 'POST',
    path,
    originalUrl: `/openai${path}`,
    headers: {
      'user-agent': userAgent
    },
    body: JSON.parse(JSON.stringify(body)),
    apiKey: {
      id: 'key_1',
      permissions: ['openai'],
      enableOpenAIResponsesCodexAdaptation: true,
      enableOpenAIResponsesPayloadRules: false,
      openaiResponsesPayloadRules: [],
      ...apiKeyOverrides
    },
    _fromUnifiedEndpoint: fromUnifiedEndpoint
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    headers: {},
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((payload) => {
      res.payload = payload
      return res
    }),
    setHeader: jest.fn((key, value) => {
      res.headers[key] = value
    }),
    set: jest.fn((key, value) => {
      res.headers[key] = value
      return res
    })
  }
  return res
}

describe('openai responses payload toggles', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'resp-1',
      accountType: 'openai-responses'
    })

    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-1',
      name: 'Responses Account',
      apiKey: 'sk-responses'
    })

    openaiResponsesRelayService.handleRequest.mockResolvedValue({ ok: true })
    claudeRelayConfigService.getConfig.mockResolvedValue({
      openaiImagesStickySessionEnabled: false
    })
    openaiAccountService.decrypt.mockReturnValue('decrypted-token')
    redis.incrConcurrency.mockResolvedValue(1)
    redis.decrConcurrency.mockResolvedValue(0)
    redis.refreshConcurrencyLease.mockResolvedValue(true)
  })

  test('keeps standard responses payload unchanged for openai-responses when both toggles are off', async () => {
    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        temperature: 0.2,
        service_tier: 'priority',
        prompt_cache_key: 'session-a'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body).toEqual({
      model: 'gpt-5-2025-08-07',
      temperature: 0.2,
      service_tier: 'priority',
      prompt_cache_key: 'session-a'
    })
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('session-a'),
      'gpt-5',
      { requiredProviderEndpoint: 'responses' }
    )
  })

  test.each(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'keeps GPT-5.6 model %s unchanged for scheduling and relay',
    async (model) => {
      const req = createReq({
        body: {
          model,
          prompt_cache_key: `session-${model}`
        },
        apiKeyOverrides: {
          enableOpenAIResponsesCodexAdaptation: false,
          enableOpenAIResponsesPayloadRules: false
        }
      })

      await openaiRoutes.handleResponses(req, createRes())

      expect(req.body.model).toBe(model)
      expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
        req.apiKey,
        createHash(`session-${model}`),
        model,
        { requiredProviderEndpoint: 'responses' }
      )
      expect(openaiResponsesRelayService.handleRequest).toHaveBeenCalledWith(
        req,
        expect.anything(),
        expect.anything(),
        req.apiKey
      )
    }
  )

  test('requires chat-completions provider endpoint for unified chat-completions requests', async () => {
    const req = createReq({
      body: {
        model: 'glm-5.2',
        prompt_cache_key: 'chat-session'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: false
      },
      fromUnifiedEndpoint: true
    })
    req._fromUnifiedChatCompletions = true

    await openaiRoutes.handleResponses(req, createRes())

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('chat-session'),
      'glm-5.2',
      { requiredProviderEndpoint: 'chat-completions' }
    )
  })

  test('returns local model routing errors without replacing them with generic sanitizer text', async () => {
    const error = new Error('No available OpenAI accounts support the requested model: glm-5.2')
    error.statusCode = 400
    unifiedOpenAIScheduler.selectAccountForApiKey.mockRejectedValue(error)
    errorSanitizer.getSafeMessage.mockReturnValue('Internal server error')

    const req = createReq({
      body: {
        model: 'glm-5.2',
        prompt_cache_key: 'chat-session'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: false
      },
      fromUnifiedEndpoint: true
    })
    req._fromUnifiedChatCompletions = true
    const res = createRes()

    await openaiRoutes.handleResponses(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.payload).toEqual({
      error: {
        message: 'No available OpenAI accounts support the requested model: glm-5.2',
        type: 'invalid_request_error',
        code: 'model_not_supported'
      }
    })
    expect(errorSanitizer.getSafeMessage).not.toHaveBeenCalled()
  })

  test('applies Codex adaptation only when adaptation toggle is on', async () => {
    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        temperature: 0.2,
        service_tier: 'priority',
        prompt_cache_key: 'session-b'
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.model).toBe('gpt-5')
    expect(req.body.instructions).toBe(openaiRoutes.CODEX_CLI_INSTRUCTIONS)
    expect(req.body.temperature).toBeUndefined()
    expect(req.body.service_tier).toBeUndefined()
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('session-b'),
      'gpt-5',
      { requiredProviderEndpoint: 'responses' }
    )
  })

  test('applies payload rules directly on the original payload when adaptation is off', async () => {
    const req = createReq({
      body: {
        model: 'gpt-4.1',
        temperature: 0.5,
        prompt_cache_key: 'old-key',
        text: { format: {} }
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'model', valueType: 'string', value: 'gpt-5' },
          { path: 'prompt_cache_key', valueType: 'string', value: 'new-key' },
          { path: 'text.format.type', valueType: 'string', value: 'json_schema' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body).toEqual({
      model: 'gpt-5',
      temperature: 0.5,
      prompt_cache_key: 'new-key',
      text: {
        format: {
          type: 'json_schema'
        }
      }
    })
    expect(req.body.instructions).toBeUndefined()
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('new-key'),
      'gpt-5',
      { requiredProviderEndpoint: 'responses' }
    )
  })

  test('applies payload rules after Codex adaptation when both toggles are on', async () => {
    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        prompt_cache_key: 'legacy-key',
        temperature: 0.2,
        instructions: 'raw'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: true,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'model', valueType: 'string', value: 'gpt-5-codex' },
          { path: 'instructions', valueType: 'string', value: 'custom instructions' },
          { path: 'prompt_cache_key', valueType: 'string', value: 'rule-key' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.model).toBe('gpt-5-codex')
    expect(req.body.instructions).toBe('custom instructions')
    expect(req.body.temperature).toBeUndefined()
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('rule-key'),
      'gpt-5-codex',
      { requiredProviderEndpoint: 'responses' }
    )
  })

  test('normalizes dated gpt-5 models only for scheduling and upstream openai requests when adaptation is off', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        service_tier: 'priority',
        prompt_cache_key: 'compat-key',
        stream: false
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('compat-key'),
      'gpt-5',
      { requiredProviderEndpoint: 'responses' }
    )
    expect(req.body.model).toBe('gpt-5')
    expect(req.body.service_tier).toBe('priority')
    expect(axios.post).toHaveBeenCalled()
    expect(axios.post.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5',
      service_tier: 'priority',
      store: false
    })
  })

  test('normalizes payload-rule gpt-5 aliases for openai scheduling without applying full Codex adaptation', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5',
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          total_tokens: 11
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        text: { format: {} },
        prompt_cache_key: 'rule-model-key',
        stream: false
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'model', valueType: 'string', value: 'gpt-5-2025-08-07' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('rule-model-key'),
      'gpt-5',
      { requiredProviderEndpoint: 'responses' }
    )
    expect(req.body.model).toBe('gpt-5')
    expect(req.body.text).toEqual({ format: {} })
    expect(req.body.instructions).toBeUndefined()
    expect(axios.post.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5',
      text: { format: {} },
      store: false
    })
  })

  test('records the mutated service_tier for standard responses sent through openai accounts', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-4.1',
        usage: {
          input_tokens: 12,
          output_tokens: 6,
          total_tokens: 18
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'tier-rule-key',
        stream: false
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'service_tier', valueType: 'string', value: 'priority' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req._serviceTier).toBe('priority')
    expect(apiKeyService.recordUsage).toHaveBeenCalled()
    expect(apiKeyService.recordUsage.mock.calls[0][8]).toBe('priority')
  })

  test('acquires and releases account concurrency for openai accounts', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1',
      maxConcurrentTasks: 2
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-4.1',
        usage: {
          input_tokens: 6,
          output_tokens: 2,
          total_tokens: 8
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'concurrency-key',
        stream: false
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(redis.incrConcurrency).toHaveBeenCalledWith(
      'openai_account:openai-1',
      expect.any(String),
      600
    )
    const requestId = redis.incrConcurrency.mock.calls[0][1]
    expect(redis.decrConcurrency).toHaveBeenCalledWith('openai_account:openai-1', requestId)
  })

  test('records null service_tier after Codex adaptation removes it for openai accounts', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        model: 'gpt-5',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14
        }
      },
      headers: {}
    })

    const req = createReq({
      body: {
        model: 'gpt-5-2025-08-07',
        temperature: 0.2,
        service_tier: 'priority',
        prompt_cache_key: 'adapt-tier-key',
        stream: false
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.service_tier).toBeUndefined()
    expect(req._serviceTier).toBeNull()
    expect(apiKeyService.recordUsage).toHaveBeenCalled()
    expect(apiKeyService.recordUsage.mock.calls[0][8]).toBeNull()
  })

  test('captures the post-rule service_tier before relaying openai-responses requests', async () => {
    const req = createReq({
      body: {
        model: 'gpt-4.1',
        prompt_cache_key: 'relay-tier-key'
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'service_tier', valueType: 'string', value: 'priority' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req._serviceTier).toBe('priority')
    expect(openaiResponsesRelayService.handleRequest).toHaveBeenCalled()
    expect(openaiResponsesRelayService.handleRequest.mock.calls[0][0]._serviceTier).toBe('priority')
  })

  test('does not apply the new rule flow to compact responses routes', async () => {
    const req = createReq({
      path: '/v1/responses/compact',
      body: {
        model: 'o1-mini',
        prompt_cache_key: 'compact-key',
        temperature: 0.1
      },
      apiKeyOverrides: {
        enableOpenAIResponsesCodexAdaptation: false,
        enableOpenAIResponsesPayloadRules: true,
        openaiResponsesPayloadRules: [
          { path: 'model', valueType: 'string', value: 'gpt-5' },
          { path: 'prompt_cache_key', valueType: 'string', value: 'rule-key' }
        ]
      }
    })

    await openaiRoutes.handleResponses(req, createRes())

    expect(req.body.model).toBe('o1-mini')
    expect(req.body.prompt_cache_key).toBe('compact-key')
    expect(req.body.instructions).toBe(openaiRoutes.CODEX_CLI_INSTRUCTIONS)
  })
})

describe('openai images generations', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-images-1',
      accountType: 'openai'
    })
    unifiedOpenAIScheduler.isAccountRateLimited.mockResolvedValue(false)
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-images-1',
      name: 'Images Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1',
      maxConcurrentTasks: 2,
      supportsImagesGenerations: true
    })
    openaiAccountService.decrypt.mockReturnValue('decrypted-token')
    redis.incrConcurrency.mockResolvedValue(1)
    redis.decrConcurrency.mockResolvedValue(0)
    redis.refreshConcurrencyLease.mockResolvedValue(true)
    apiKeyService.recordUsage.mockResolvedValue({ totalCost: 0 })
  })

  function createImagesReq(body = {}) {
    const req = createReq({
      path: '/v1/images/generations',
      body
    })
    req.on = jest.fn()
    req.socket = { destroyed: false }
    return req
  }

  test('requires an OpenAI API key permission', async () => {
    apiKeyService.hasPermission.mockReturnValueOnce(false)
    const res = createRes()

    await openaiRoutes.handleImages(createImagesReq({ prompt: 'draw a whale' }), res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  })

  test('returns a clear error when no account enables images generations', async () => {
    const error = new Error('No available OpenAI accounts support /v1/images/generations')
    error.statusCode = 400
    unifiedOpenAIScheduler.selectAccountForApiKey.mockRejectedValueOnce(error)
    const res = createRes()

    await openaiRoutes.handleImages(createImagesReq({ prompt: 'draw a whale' }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.payload).toEqual({
      error: {
        message: 'No available OpenAI accounts support /v1/images/generations',
        type: 'invalid_request_error'
      }
    })
    expect(axios.post).not.toHaveBeenCalled()
  })

  test('selects an enabled OAuth account and releases concurrency after a generated image', async () => {
    const upstream = new PassThrough()
    axios.post.mockResolvedValue({
      status: 200,
      data: upstream
    })
    const req = createImagesReq({
      prompt: 'draw a whale',
      model: 'gpt-image-2',
      size: '1024x1024',
      prompt_cache_key: 'images-session'
    })
    const res = createRes()

    await openaiRoutes.handleImages(req, res)

    const completed = new Promise((resolve) => upstream.once('end', () => setImmediate(resolve)))
    upstream.write(
      `data: ${JSON.stringify({
        partial_image_index: 0,
        partial_image_b64: 'image-base64'
      })}\n`
    )
    upstream.write(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          tools: [{ size: '1024x1024', quality: 'high', output_format: 'png' }],
          usage: { input_tokens: 8, output_tokens: 3 }
        }
      })}\n`
    )
    upstream.end('data: [DONE]\n')
    await completed

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      null,
      'gpt-image-2',
      { requireImagesGenerations: true }
    )
    expect(axios.post.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5.4-mini',
      tool_choice: { type: 'image_generation' },
      tools: [
        expect.objectContaining({
          type: 'image_generation',
          model: 'gpt-image-2',
          size: '1024x1024'
        })
      ]
    })
    expect(res.payload).toMatchObject({
      data: [{ b64_json: 'image-base64' }],
      size: '1024x1024',
      quality: 'high',
      output_format: 'png'
    })
    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key_1',
      8,
      3,
      0,
      0,
      'gpt-image-2',
      'openai-images-1',
      'openai',
      null,
      null
    )
    expect(redis.incrConcurrency).toHaveBeenCalledWith(
      'openai_account:openai-images-1',
      expect.any(String),
      600
    )
    const requestId = redis.incrConcurrency.mock.calls[0][1]
    expect(redis.decrConcurrency).toHaveBeenCalledWith('openai_account:openai-images-1', requestId)
  })

  test('uses an independent sticky namespace when images sticky sessions are enabled', async () => {
    claudeRelayConfigService.getConfig.mockResolvedValueOnce({
      openaiImagesStickySessionEnabled: true
    })
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValueOnce({
      accountId: 'responses-images-1',
      accountType: 'openai-responses'
    })
    openaiResponsesAccountService.getAccount.mockResolvedValueOnce({
      id: 'responses-images-1',
      name: 'Responses Images Account',
      apiKey: 'provider-key',
      supportsImagesGenerations: true
    })
    const req = createImagesReq({
      prompt: 'draw a whale',
      model: 'gpt-image-2',
      prompt_cache_key: 'shared-session'
    })

    await openaiRoutes.handleImages(req, createRes())

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      createHash('openai-images:shared-session'),
      'gpt-image-2',
      { requireImagesGenerations: true }
    )
  })

  test('relays images generations through an enabled OpenAI-Responses account', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValueOnce({
      accountId: 'responses-images-1',
      accountType: 'openai-responses'
    })
    openaiResponsesAccountService.getAccount.mockResolvedValueOnce({
      id: 'responses-images-1',
      name: 'Responses Images Account',
      apiKey: 'provider-key',
      supportsImagesGenerations: true
    })
    const req = createImagesReq({
      prompt: 'draw a whale',
      model: 'provider-image-model',
      response_format: 'b64_json'
    })
    const res = createRes()

    await openaiRoutes.handleImages(req, res)

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      null,
      'provider-image-model',
      { requireImagesGenerations: true }
    )
    expect(openaiResponsesRelayService.handleRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/images/generations',
        body: expect.objectContaining({
          prompt: 'draw a whale',
          model: 'provider-image-model',
          response_format: 'b64_json'
        })
      }),
      res,
      expect.objectContaining({ id: 'responses-images-1' }),
      req.apiKey
    )
    expect(axios.post).not.toHaveBeenCalled()
  })

  test('marks an images account rate limited and releases concurrency on 429', async () => {
    const upstream = new PassThrough()
    axios.post.mockResolvedValue({
      status: 429,
      data: upstream
    })
    const req = createImagesReq({
      prompt: 'draw a whale',
      prompt_cache_key: 'rate-limit-session'
    })
    const res = createRes()

    const requestPromise = openaiRoutes.handleImages(req, res)
    setImmediate(() => {
      upstream.end(
        JSON.stringify({
          error: {
            type: 'usage_limit_reached',
            message: 'limit reached',
            resets_in_seconds: 120
          }
        })
      )
    })
    await requestPromise

    expect(unifiedOpenAIScheduler.markAccountRateLimited).toHaveBeenCalledWith(
      'openai-images-1',
      'openai',
      null,
      120
    )
    expect(res.status).toHaveBeenCalledWith(429)
    const requestId = redis.incrConcurrency.mock.calls[0][1]
    expect(redis.decrConcurrency).toHaveBeenCalledWith('openai_account:openai-images-1', requestId)
  })
})
