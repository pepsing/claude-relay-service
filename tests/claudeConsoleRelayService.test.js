jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('axios', () => jest.fn())

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn(),
  _createProxyAgent: jest.fn(),
  isAccountRateLimited: jest.fn(),
  removeAccountRateLimit: jest.fn(),
  isAccountOverloaded: jest.fn(),
  removeAccountOverload: jest.fn(),
  markAccountRateLimited: jest.fn(),
  checkQuotaUsage: jest.fn(),
  markKimiBillingCycleQuotaExceeded: jest.fn(),
  markVolcengineArkMonthlyQuotaExceeded: jest.fn(),
  isZhipuCodingPlanAccount: jest.fn(() => false),
  refreshZhipuCodingQuotaProtection: jest.fn()
}))

jest.mock('../src/services/userMessageQueueService', () => ({
  isUserMessageRequest: jest.fn(() => false),
  acquireQueueLock: jest.fn(),
  releaseQueueLock: jest.fn()
}))

jest.mock('../config/config', () => ({}), {
  virtual: true
})
jest.mock('../src/models/redis', () => ({}))

jest.mock('../src/utils/testPayloadHelper', () => ({
  createClaudeTestPayload: jest.fn(),
  getClaudeCodeTestHeaders: jest.fn(() => ({
    'User-Agent': 'claude-cli/2.0.52 (external, cli)',
    'anthropic-version': '2023-06-01',
    'x-app': 'claude-code',
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14'
  })),
  sanitizeTestPrompt: jest.fn((value) => value || 'hi'),
  sendStreamTestRequest: jest.fn()
}))

const claudeConsoleRelayService = require('../src/services/relay/claudeConsoleRelayService')
const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const {
  createClaudeTestPayload,
  getClaudeCodeTestHeaders,
  sendStreamTestRequest
} = require('../src/utils/testPayloadHelper')
const axios = require('axios')
const { EventEmitter, PassThrough } = require('stream')

function createResponseStream() {
  const responseStream = new EventEmitter()
  responseStream.headersSent = false
  responseStream.destroyed = false
  responseStream.writableEnded = false
  responseStream.socket = {
    destroyed: false,
    bytesWritten: 0,
    setNoDelay: jest.fn()
  }
  responseStream.getHeader = jest.fn()
  responseStream.writeHead = jest.fn(() => {
    responseStream.headersSent = true
  })
  responseStream.write = jest.fn(() => true)
  responseStream.end = jest.fn((callback) => {
    responseStream.writableEnded = true
    responseStream.emit('finish')
    if (typeof callback === 'function') {
      callback()
    }
    responseStream.emit('close')
  })
  return responseStream
}

describe('claudeConsoleRelayService.testAccountConnection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    claudeConsoleAccountService.isAccountRateLimited.mockResolvedValue(false)
    claudeConsoleAccountService.isAccountOverloaded.mockResolvedValue(false)
    claudeConsoleAccountService.markKimiBillingCycleQuotaExceeded.mockResolvedValue({
      success: true
    })
    claudeConsoleAccountService.markVolcengineArkMonthlyQuotaExceeded.mockResolvedValue({
      success: true
    })
    claudeConsoleAccountService.isZhipuCodingPlanAccount.mockReturnValue(false)
    claudeConsoleAccountService.refreshZhipuCodingQuotaProtection.mockResolvedValue({
      checked: true,
      exhausted: false
    })
  })

  it('passes selected model stream payload and bearer auth for non sk-ant key', async () => {
    claudeConsoleAccountService.getAccount.mockResolvedValue({
      name: 'Console A1',
      apiUrl: 'https://console.example.com',
      apiKey: 'test-key',
      proxy: null,
      userAgent: null
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)

    const payload = {
      model: 'claude-sonnet-4-6',
      stream: true
    }
    createClaudeTestPayload.mockReturnValue(payload)
    sendStreamTestRequest.mockResolvedValue(undefined)

    const res = {}
    await claudeConsoleRelayService.testAccountConnection(
      'a1',
      res,
      'claude-sonnet-4-6',
      'custom test prompt'
    )

    expect(createClaudeTestPayload).toHaveBeenCalledWith('claude-sonnet-4-6', {
      stream: true,
      prompt: 'custom test prompt'
    })
    expect(sendStreamTestRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload,
        authorization: 'Bearer test-key',
        extraHeaders: getClaudeCodeTestHeaders()
      })
    )
  })

  it('passes selected model stream payload and x-api-key for sk-ant key', async () => {
    claudeConsoleAccountService.getAccount.mockResolvedValue({
      name: 'Console A1',
      apiUrl: 'https://console.example.com',
      apiKey: 'sk-ant-test-key',
      proxy: null,
      userAgent: null
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)

    const payload = {
      model: 'claude-sonnet-4-6',
      stream: true
    }
    createClaudeTestPayload.mockReturnValue(payload)
    sendStreamTestRequest.mockResolvedValue(undefined)

    const res = {}
    await claudeConsoleRelayService.testAccountConnection('a1', res, 'claude-sonnet-4-6')

    expect(createClaudeTestPayload).toHaveBeenCalledWith('claude-sonnet-4-6', {
      stream: true,
      prompt: 'hi'
    })
    const requestOptions = sendStreamTestRequest.mock.calls[0][0]
    expect(requestOptions).toEqual(
      expect.objectContaining({
        payload,
        extraHeaders: expect.objectContaining({
          ...getClaudeCodeTestHeaders(),
          'x-api-key': 'sk-ant-test-key'
        })
      })
    )
    expect(requestOptions).not.toHaveProperty('authorization')
  })

  it('suspends Kimi account scheduling when account test returns billing-cycle 403', async () => {
    claudeConsoleAccountService.getAccount.mockResolvedValue({
      name: 'kimi-亮哥',
      apiUrl: 'https://api.kimi.com/coding/',
      apiKey: 'kimi-api-key',
      proxy: null,
      userAgent: null,
      disableAutoProtection: false
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)
    createClaudeTestPayload.mockReturnValue({
      model: 'claude-sonnet-4-6',
      stream: true
    })
    sendStreamTestRequest.mockImplementation(async (requestOptions) => {
      await requestOptions.onErrorResponse({
        status: 403,
        data: JSON.stringify({
          error: {
            message:
              "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle."
          }
        })
      })
    })

    const res = {}
    await claudeConsoleRelayService.testAccountConnection(
      'kimi-account-1',
      res,
      'claude-sonnet-4-6'
    )

    expect(claudeConsoleAccountService.markKimiBillingCycleQuotaExceeded).toHaveBeenCalledWith(
      'kimi-account-1',
      expect.stringContaining('billing cycle')
    )
  })

  it('suspends Volcengine Ark account scheduling until reset time when account test returns monthly quota 429', async () => {
    claudeConsoleAccountService.getAccount.mockResolvedValue({
      name: '火山',
      apiUrl: 'https://ark.cn-beijing.volces.com/api/coding',
      apiKey: 'ark-api-key',
      proxy: null,
      userAgent: null,
      disableAutoProtection: true
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)
    createClaudeTestPayload.mockReturnValue({
      model: 'deepseek-v4-pro',
      stream: true
    })
    sendStreamTestRequest.mockImplementation(async (requestOptions) => {
      await requestOptions.onErrorResponse({
        status: 429,
        data: 'You have exceeded the monthly usage quota. It will reset at 2026-06-26 23:59:59 +0800 CST.'
      })
    })

    const res = {}
    await claudeConsoleRelayService.testAccountConnection('ark-account-1', res, 'deepseek-v4-pro')

    expect(claudeConsoleAccountService.markVolcengineArkMonthlyQuotaExceeded).toHaveBeenCalledWith(
      'ark-account-1',
      expect.objectContaining({
        resetAt: '2026-06-26T15:59:59.000Z',
        resetAtText: '2026-06-26 23:59:59 +0800 CST',
        errorDetails: expect.stringContaining('monthly usage quota')
      })
    )
  })
})

describe('claudeConsoleRelayService.relayRequest Kimi quota handling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    claudeConsoleAccountService.isAccountRateLimited.mockResolvedValue(false)
    claudeConsoleAccountService.isAccountOverloaded.mockResolvedValue(false)
    claudeConsoleAccountService.markKimiBillingCycleQuotaExceeded.mockResolvedValue({
      success: true
    })
    claudeConsoleAccountService.markVolcengineArkMonthlyQuotaExceeded.mockResolvedValue({
      success: true
    })
    claudeConsoleAccountService.markAccountRateLimited.mockResolvedValue({
      success: true
    })
    claudeConsoleAccountService.checkQuotaUsage.mockResolvedValue(undefined)
    claudeConsoleAccountService.isZhipuCodingPlanAccount.mockReturnValue(false)
    claudeConsoleAccountService.refreshZhipuCodingQuotaProtection.mockResolvedValue({
      checked: true,
      exhausted: false
    })
  })

  it('suspends scheduling for Kimi Coding billing-cycle 403 errors', async () => {
    const updateLastUsedTime = jest
      .spyOn(claudeConsoleRelayService, '_updateLastUsedTime')
      .mockResolvedValue(undefined)

    claudeConsoleAccountService.getAccount.mockResolvedValue({
      id: 'kimi-account-1',
      name: 'kimi-亮哥',
      apiUrl: 'https://api.kimi.com/coding/',
      apiKey: 'kimi-api-key',
      supportedModels: [],
      maxConcurrentTasks: 0,
      disableAutoProtection: false
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)
    axios.mockResolvedValue({
      status: 403,
      headers: {},
      data: {
        error: {
          message:
            "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle."
        }
      }
    })

    const response = await claudeConsoleRelayService.relayRequest(
      { model: 'claude-sonnet-4-6', messages: [] },
      { id: 'key-1', name: 'test-key' },
      null,
      null,
      {},
      'kimi-account-1'
    )

    expect(response.statusCode).toBe(403)
    expect(claudeConsoleAccountService.markKimiBillingCycleQuotaExceeded).toHaveBeenCalledWith(
      'kimi-account-1',
      expect.stringContaining('billing cycle')
    )

    updateLastUsedTime.mockRestore()
  })

  it('suspends Kimi billing-cycle 403 errors even when auto protection is disabled', async () => {
    const updateLastUsedTime = jest
      .spyOn(claudeConsoleRelayService, '_updateLastUsedTime')
      .mockResolvedValue(undefined)

    claudeConsoleAccountService.getAccount.mockResolvedValue({
      id: 'kimi-account-2',
      name: 'kimi-祥总',
      apiUrl: 'https://api.kimi.com/coding/',
      apiKey: 'kimi-api-key',
      supportedModels: [],
      maxConcurrentTasks: 0,
      disableAutoProtection: true
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)
    axios.mockResolvedValue({
      status: 403,
      headers: {},
      data: {
        error: {
          message:
            "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle."
        }
      }
    })

    await claudeConsoleRelayService.relayRequest(
      { model: 'claude-sonnet-4-6', messages: [] },
      { id: 'key-1', name: 'test-key' },
      null,
      null,
      {},
      'kimi-account-2'
    )

    expect(claudeConsoleAccountService.markKimiBillingCycleQuotaExceeded).toHaveBeenCalledWith(
      'kimi-account-2',
      expect.stringContaining('billing cycle')
    )

    updateLastUsedTime.mockRestore()
  })

  it('uses Zhipu quota API protection instead of generic 429 rate-limit suspension', async () => {
    const updateLastUsedTime = jest
      .spyOn(claudeConsoleRelayService, '_updateLastUsedTime')
      .mockResolvedValue(undefined)

    claudeConsoleAccountService.getAccount.mockResolvedValue({
      id: 'zhipu-account-1',
      name: 'zhipu-coding',
      apiUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'zhipu-api-key',
      supportedModels: [],
      maxConcurrentTasks: 0,
      disableAutoProtection: false
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)
    claudeConsoleAccountService.isZhipuCodingPlanAccount.mockReturnValue(true)
    claudeConsoleAccountService.refreshZhipuCodingQuotaProtection.mockResolvedValue({
      checked: true,
      exhausted: true,
      suspended: true
    })
    axios.mockResolvedValue({
      status: 429,
      headers: {},
      data: {
        error: {
          message: 'rate limit reached'
        }
      }
    })

    const response = await claudeConsoleRelayService.relayRequest(
      { model: 'claude-sonnet-4-6', messages: [] },
      { id: 'key-1', name: 'test-key' },
      null,
      null,
      {},
      'zhipu-account-1'
    )

    expect(response.statusCode).toBe(429)
    expect(claudeConsoleAccountService.refreshZhipuCodingQuotaProtection).toHaveBeenCalledWith(
      'zhipu-account-1',
      expect.objectContaining({
        account: expect.objectContaining({ apiUrl: 'https://open.bigmodel.cn/api/anthropic' })
      })
    )
    expect(claudeConsoleAccountService.markAccountRateLimited).not.toHaveBeenCalled()

    updateLastUsedTime.mockRestore()
  })

  it('uses Zhipu quota API protection even when auto protection is disabled', async () => {
    const updateLastUsedTime = jest
      .spyOn(claudeConsoleRelayService, '_updateLastUsedTime')
      .mockResolvedValue(undefined)

    claudeConsoleAccountService.getAccount.mockResolvedValue({
      id: 'zhipu-account-2',
      name: 'zhipu-coding-disabled-protection',
      apiUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'zhipu-api-key',
      supportedModels: [],
      maxConcurrentTasks: 0,
      disableAutoProtection: true
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)
    claudeConsoleAccountService.isZhipuCodingPlanAccount.mockReturnValue(true)
    claudeConsoleAccountService.refreshZhipuCodingQuotaProtection.mockResolvedValue({
      checked: true,
      exhausted: true,
      suspended: true
    })
    axios.mockResolvedValue({
      status: 429,
      headers: {},
      data: {
        error: {
          message: 'rate limit reached'
        }
      }
    })

    await claudeConsoleRelayService.relayRequest(
      { model: 'claude-sonnet-4-6', messages: [] },
      { id: 'key-1', name: 'test-key' },
      null,
      null,
      {},
      'zhipu-account-2'
    )

    expect(claudeConsoleAccountService.refreshZhipuCodingQuotaProtection).toHaveBeenCalledWith(
      'zhipu-account-2',
      expect.objectContaining({
        account: expect.objectContaining({ disableAutoProtection: true })
      })
    )
    expect(claudeConsoleAccountService.markAccountRateLimited).not.toHaveBeenCalled()

    updateLastUsedTime.mockRestore()
  })

  it('suspends Volcengine Ark monthly quota 429 errors until the reset time', async () => {
    const updateLastUsedTime = jest
      .spyOn(claudeConsoleRelayService, '_updateLastUsedTime')
      .mockResolvedValue(undefined)

    claudeConsoleAccountService.getAccount.mockResolvedValue({
      id: 'ark-account-1',
      name: '火山',
      apiUrl: 'https://ark.cn-beijing.volces.com/api/coding',
      apiKey: 'ark-api-key',
      supportedModels: [],
      maxConcurrentTasks: 0,
      disableAutoProtection: true
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)
    axios.mockResolvedValue({
      status: 429,
      headers: {},
      data: {
        error: {
          message:
            'You have exceeded the monthly usage quota. It will reset at 2026-06-26 23:59:59 +0800 CST.'
        }
      }
    })

    const response = await claudeConsoleRelayService.relayRequest(
      { model: 'deepseek-v4-pro', messages: [] },
      { id: 'key-1', name: 'test-key' },
      null,
      null,
      {},
      'ark-account-1'
    )

    expect(response.statusCode).toBe(429)
    expect(claudeConsoleAccountService.markVolcengineArkMonthlyQuotaExceeded).toHaveBeenCalledWith(
      'ark-account-1',
      expect.objectContaining({
        resetAt: '2026-06-26T15:59:59.000Z',
        resetAtText: '2026-06-26 23:59:59 +0800 CST'
      })
    )
    expect(claudeConsoleAccountService.markAccountRateLimited).not.toHaveBeenCalled()

    updateLastUsedTime.mockRestore()
  })

  it('does not suspend non-Kimi accounts for the same 403 text', async () => {
    const updateLastUsedTime = jest
      .spyOn(claudeConsoleRelayService, '_updateLastUsedTime')
      .mockResolvedValue(undefined)

    claudeConsoleAccountService.getAccount.mockResolvedValue({
      id: 'console-account-1',
      name: 'console-account',
      apiUrl: 'https://console.example.com/',
      apiKey: 'console-api-key',
      supportedModels: [],
      maxConcurrentTasks: 0,
      disableAutoProtection: false
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)
    axios.mockResolvedValue({
      status: 403,
      headers: {},
      data: {
        error: {
          message:
            "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle."
        }
      }
    })

    await claudeConsoleRelayService.relayRequest(
      { model: 'claude-sonnet-4-6', messages: [] },
      { id: 'key-1', name: 'test-key' },
      null,
      null,
      {},
      'console-account-1'
    )

    expect(claudeConsoleAccountService.markKimiBillingCycleQuotaExceeded).not.toHaveBeenCalled()

    updateLastUsedTime.mockRestore()
  })
})

describe('claudeConsoleRelayService._makeClaudeConsoleStreamRequest', () => {
  const originalMaxLifetime = process.env.CONCURRENCY_MAX_LIFETIME_MINUTES
  const originalEndFallback = process.env.CONSOLE_STREAM_END_FALLBACK_MS

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    delete process.env.CONCURRENCY_MAX_LIFETIME_MINUTES
    delete process.env.CONSOLE_STREAM_END_FALLBACK_MS
    claudeConsoleAccountService.isZhipuCodingPlanAccount.mockReturnValue(false)
    claudeConsoleAccountService.refreshZhipuCodingQuotaProtection.mockResolvedValue({
      checked: true,
      exhausted: false
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    if (originalMaxLifetime === undefined) {
      delete process.env.CONCURRENCY_MAX_LIFETIME_MINUTES
    } else {
      process.env.CONCURRENCY_MAX_LIFETIME_MINUTES = originalMaxLifetime
    }
    if (originalEndFallback === undefined) {
      delete process.env.CONSOLE_STREAM_END_FALLBACK_MS
    } else {
      process.env.CONSOLE_STREAM_END_FALLBACK_MS = originalEndFallback
    }
  })

  it('destroys upstream stream when client disconnects', async () => {
    const upstreamStream = new PassThrough()
    axios.mockResolvedValue({
      status: 200,
      data: upstreamStream,
      headers: {}
    })

    const responseStream = createResponseStream()
    const promise = claudeConsoleRelayService._makeClaudeConsoleStreamRequest(
      { model: 'claude-sonnet-4-6' },
      {
        name: 'Console A1',
        apiUrl: 'https://console.example.com',
        apiKey: 'test-key'
      },
      null,
      {},
      responseStream,
      'a1',
      jest.fn()
    )

    await new Promise((resolve) => setImmediate(resolve))
    responseStream.emit('close')

    await expect(promise).rejects.toThrow('Client disconnected')
    expect(upstreamStream.destroyed).toBe(true)
  })

  it('destroys upstream stream after max lifetime', async () => {
    jest.useFakeTimers()
    process.env.CONCURRENCY_MAX_LIFETIME_MINUTES = '1'

    const upstreamStream = new PassThrough()
    axios.mockResolvedValue({
      status: 200,
      data: upstreamStream,
      headers: {}
    })

    const responseStream = createResponseStream()
    const promise = claudeConsoleRelayService._makeClaudeConsoleStreamRequest(
      { model: 'claude-sonnet-4-6' },
      {
        name: 'Console A1',
        apiUrl: 'https://console.example.com',
        apiKey: 'test-key'
      },
      null,
      {},
      responseStream,
      'a1',
      jest.fn()
    )

    await Promise.resolve()
    jest.advanceTimersByTime(60 * 1000)

    await expect(promise).rejects.toThrow('Claude Console stream exceeded max lifetime')
    expect(upstreamStream.destroyed).toBe(true)
  })

  it('settles when response end callback is not fired', async () => {
    process.env.CONSOLE_STREAM_END_FALLBACK_MS = '5'
    const upstreamStream = new PassThrough()
    axios.mockResolvedValue({
      status: 200,
      data: upstreamStream,
      headers: {}
    })

    const responseStream = createResponseStream()
    responseStream.end = jest.fn(() => {
      responseStream.writableEnded = true
    })

    const promise = claudeConsoleRelayService._makeClaudeConsoleStreamRequest(
      { model: 'claude-sonnet-4-6' },
      {
        name: 'Console A1',
        apiUrl: 'https://console.example.com',
        apiKey: 'test-key'
      },
      null,
      {},
      responseStream,
      'a1',
      jest.fn()
    )

    await new Promise((resolve) => setImmediate(resolve))
    upstreamStream.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(responseStream.end).toHaveBeenCalledTimes(1)

    await expect(promise).resolves.toBeUndefined()
  })
})
