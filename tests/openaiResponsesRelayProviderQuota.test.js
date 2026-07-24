const { EventEmitter } = require('events')
const { PassThrough } = require('stream')

jest.mock('axios', () => jest.fn())
jest.mock('../config/config', () => ({ requestTimeout: 30000 }))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn(),
  isBrokenPipeError: jest.fn(() => false)
}))
jest.mock('../src/models/redis', () => ({
  incrConcurrency: jest.fn(),
  decrConcurrency: jest.fn(),
  refreshConcurrencyLease: jest.fn()
}))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  getMappedModel: jest.fn((_, model) => model),
  handleProviderQuotaError: jest.fn(),
  updateAccount: jest.fn(),
  updateAccountUsage: jest.fn(),
  updateUsageQuota: jest.fn()
}))
jest.mock('../src/services/apiKeyService', () => ({ recordUsage: jest.fn() }))
jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  _deleteSessionMapping: jest.fn().mockResolvedValue(undefined),
  _getSessionMapping: jest.fn(),
  markAccountRateLimited: jest.fn()
}))
jest.mock('../src/services/accountConcurrencyQueueService', () => ({
  waitForSlot: jest.fn()
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  sanitizeErrorForClient: jest.fn((data) => data),
  markTempUnavailable: jest.fn(),
  parseRetryAfter: jest.fn()
}))

const axios = require('axios')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')

class FakeResponse extends EventEmitter {
  constructor() {
    super()
    this.headersSent = false
    this.destroyed = false
    this.writableEnded = false
    this.closed = false
    this.statusCode = 200
    this.body = null
    this.headers = {}
  }

  status(code) {
    this.statusCode = code
    return this
  }

  json(body) {
    this.body = body
    return this
  }

  setHeader(name, value) {
    this.headers[name] = value
  }

  write(chunk) {
    this.body = `${this.body || ''}${chunk.toString()}`
    return true
  }

  end() {
    this.writableEnded = true
    this.emit('finished')
  }
}

describe('OpenAI Responses relay provider subscription quota handling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('preserves images generations for accounts configured as Chat Completions providers', async () => {
    const account = {
      id: 'images-chat-provider',
      name: 'images-chat-provider',
      baseApi: 'https://api.example.com/v1',
      apiKey: 'test-key',
      providerEndpoint: 'chat-completions',
      supportedModels: { 'gpt-image-2': 'provider-image-model' },
      maxConcurrentTasks: 0
    }
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    openaiResponsesAccountService.getMappedModel.mockReturnValue('provider-image-model')
    axios.mockResolvedValue({
      status: 200,
      headers: {},
      data: { created: 123, data: [{ b64_json: 'image-data' }] }
    })

    const req = new EventEmitter()
    req.method = 'POST'
    req.path = '/v1/images/generations'
    req.headers = {}
    req.body = {
      model: 'gpt-image-2',
      prompt: 'draw a whale',
      response_format: 'b64_json'
    }
    req.socket = { destroyed: false }
    const res = new FakeResponse()

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )

    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.example.com/v1/images/generations',
        data: {
          model: 'provider-image-model',
          prompt: 'draw a whale',
          response_format: 'b64_json'
        }
      })
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ created: 123, data: [{ b64_json: 'image-data' }] })
  })

  it('handles a streaming Chat Completions request that receives an HTTP-level Kimi 403', async () => {
    const account = {
      id: 'kimi-chat-1',
      name: 'kimi-chat',
      baseApi: 'https://api.kimi.com/coding',
      apiKey: 'test-key',
      providerEndpoint: 'chat-completions',
      supportedModels: {},
      maxConcurrentTasks: 0,
      disableAutoProtection: 'true'
    }
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    openaiResponsesAccountService.handleProviderQuotaError.mockResolvedValue({
      handled: true,
      provider: 'kimi',
      quotaType: 'billing_cycle'
    })
    axios.mockResolvedValue({
      status: 403,
      statusText: 'Forbidden',
      headers: {},
      data: {
        error: {
          type: 'access_terminated_error',
          message: 'Quota will be refreshed in the next cycle.'
        }
      }
    })

    const req = new EventEmitter()
    req.method = 'POST'
    req.path = '/v1/chat/completions'
    req.headers = { 'x-session-id': 'session-1' }
    req.body = { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }], stream: true }
    req.socket = { destroyed: false }
    const res = new FakeResponse()

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )

    expect(openaiResponsesAccountService.handleProviderQuotaError).toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({ account, status: 403 })
    )
    expect(unifiedOpenAIScheduler._deleteSessionMapping).toHaveBeenCalledWith(expect.any(String))
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual(expect.objectContaining({ error: expect.any(Object) }))
  })

  it('handles a Kimi usage_limit_reached event inside a successful SSE response', async () => {
    const account = {
      id: 'kimi-chat-2',
      name: 'kimi-chat',
      baseApi: 'https://api.kimi.com/coding',
      apiKey: 'test-key',
      providerEndpoint: 'chat-completions',
      supportedModels: {},
      maxConcurrentTasks: 0,
      disableAutoProtection: 'true'
    }
    const upstream = new PassThrough()
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    openaiResponsesAccountService.handleProviderQuotaError.mockResolvedValue({
      handled: true,
      provider: 'kimi',
      quotaType: 'billing_cycle'
    })
    axios.mockResolvedValue({ status: 200, headers: {}, data: upstream })

    const req = new EventEmitter()
    req.method = 'POST'
    req.path = '/v1/chat/completions'
    req.headers = { 'x-session-id': 'session-2' }
    req.body = { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }], stream: true }
    req.socket = { destroyed: false }
    const res = new FakeResponse()

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )
    const finished = new Promise((resolve) => res.once('finished', resolve))
    upstream.end(
      `data: ${JSON.stringify({
        error: { type: 'usage_limit_reached', message: 'Billing cycle quota exhausted' }
      })}\n\n`
    )
    await finished

    expect(openaiResponsesAccountService.handleProviderQuotaError).toHaveBeenCalledWith(
      account.id,
      expect.objectContaining({ status: 403 })
    )
    expect(unifiedOpenAIScheduler.markAccountRateLimited).not.toHaveBeenCalled()
  })
})
