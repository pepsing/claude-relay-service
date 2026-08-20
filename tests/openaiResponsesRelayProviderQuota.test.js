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
const redis = require('../src/models/redis')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

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
    this.flushHeaders = jest.fn(() => {
      this.headersSent = true
    })
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
    this.headersSent = true
    this.writableEnded = true
    this.emit('finished')
  }
}

class FakeUpstream extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
    this.unpipe = jest.fn()
    this.pipe = jest.fn(() => this)
    this.pause = jest.fn(() => this)
    this.resume = jest.fn(() => this)
    this.destroy = jest.fn(() => {
      this.destroyed = true
      this.emit('close')
      return this
    })
  }
}

function createStreamingAccount(overrides = {}) {
  return {
    id: 'responses-streaming',
    name: 'responses-streaming',
    baseApi: 'https://api.example.com/v1',
    apiKey: 'test-key',
    providerEndpoint: 'responses',
    supportedModels: {},
    maxConcurrentTasks: 0,
    ...overrides
  }
}

function createStreamingRequest(overrides = {}) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.path = '/v1/responses'
  req.headers = {}
  req.body = { model: 'gpt-5', input: 'hi', stream: true }
  req.complete = true
  req.socket = { destroyed: false }
  Object.assign(req, overrides)
  return req
}

describe('OpenAI Responses relay provider subscription quota handling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    axios.mockReset()
    upstreamErrorHelper.markTempUnavailable.mockResolvedValue(undefined)
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

  it('defers a retryable HTTP error without writing it to the client', async () => {
    const account = {
      id: 'responses-primary',
      name: 'responses-primary',
      baseApi: 'https://api.example.com/v1',
      apiKey: 'test-key',
      providerEndpoint: 'responses',
      supportedModels: {},
      maxConcurrentTasks: 0
    }
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    openaiResponsesAccountService.handleProviderQuotaError.mockResolvedValue({
      handled: false
    })
    axios.mockResolvedValue({
      status: 503,
      statusText: 'Service Unavailable',
      headers: {},
      data: {
        error: {
          message: 'Provider unavailable'
        }
      }
    })

    const req = new EventEmitter()
    req.method = 'POST'
    req.path = '/v1/responses'
    req.headers = {}
    req.body = { model: 'gpt-5', stream: false }
    req.socket = { destroyed: false }
    const res = new FakeResponse()

    await expect(
      openaiResponsesRelayService.handleRequest(
        req,
        res,
        { id: account.id, name: account.name },
        { id: 'api-key-1' },
        { deferRetryableErrors: true }
      )
    ).rejects.toMatchObject({
      code: 'OPENAI_ACCOUNT_FAILOVER',
      statusCode: 503,
      accountId: 'responses-primary',
      responseData: {
        error: {
          message: 'Provider unavailable'
        }
      }
    })
    expect(res.body).toBeNull()
    expect(res.statusCode).toBe(200)
  })

  it('defers an upstream network error without writing it to the client', async () => {
    const account = {
      id: 'responses-network-primary',
      name: 'responses-network-primary',
      baseApi: 'https://api.example.com/v1',
      apiKey: 'test-key',
      providerEndpoint: 'responses',
      supportedModels: {},
      maxConcurrentTasks: 0
    }
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    const networkError = new Error('connect ETIMEDOUT')
    networkError.code = 'ETIMEDOUT'
    axios.mockRejectedValue(networkError)

    const req = new EventEmitter()
    req.method = 'POST'
    req.path = '/v1/responses'
    req.headers = {}
    req.body = { model: 'gpt-5', stream: false }
    req.socket = { destroyed: false }
    const res = new FakeResponse()

    await expect(
      openaiResponsesRelayService.handleRequest(
        req,
        res,
        { id: account.id, name: account.name },
        { id: 'api-key-1' },
        { deferRetryableErrors: true }
      )
    ).rejects.toMatchObject({
      code: 'OPENAI_ACCOUNT_FAILOVER',
      statusCode: 503,
      accountId: 'responses-network-primary'
    })
    expect(res.body).toBeNull()
    expect(res.statusCode).toBe(200)
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

  it('records upstream first byte, first token, and total duration from the actual attempt', async () => {
    jest.useFakeTimers().setSystemTime(Date.parse('2026-08-13T10:00:00.000Z'))

    try {
      const account = {
        id: 'responses-timing',
        name: 'responses-timing',
        baseApi: 'https://api.example.com/v1',
        apiKey: 'test-key',
        providerEndpoint: 'responses',
        supportedModels: {},
        maxConcurrentTasks: 0
      }
      const upstream = new PassThrough()
      openaiResponsesAccountService.getAccount.mockResolvedValue(account)
      axios.mockResolvedValue({ status: 200, headers: {}, data: upstream })

      const req = new EventEmitter()
      req.method = 'POST'
      req.path = '/v1/responses'
      req.headers = {}
      req.body = { model: 'gpt-5', input: 'hi', stream: true }
      req.socket = { destroyed: false }
      const res = new FakeResponse()

      await openaiResponsesRelayService.handleRequest(
        req,
        res,
        { id: account.id, name: account.name },
        { id: 'api-key-1' }
      )

      const attemptStartedAt = req.requestTiming.upstreamAttemptStartedAt
      jest.advanceTimersByTime(200)
      upstream.write(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' })}\n\n`
      )
      jest.advanceTimersByTime(1000)

      const finished = new Promise((resolve) => res.once('finished', resolve))
      upstream.end()
      await finished

      expect(req.requestTiming).toEqual(
        expect.objectContaining({
          upstreamAttemptCount: 1,
          upstreamAttemptStartedAt: attemptStartedAt,
          upstreamFirstByteAt: attemptStartedAt + 200,
          upstreamFirstTokenAt: attemptStartedAt + 200,
          upstreamResponseCompletedAt: attemptStartedAt + 1200
        })
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it('resets upstream timing to the retried account attempt while preserving attempt count', async () => {
    jest.useFakeTimers().setSystemTime(Date.parse('2026-08-13T11:00:00.000Z'))

    try {
      const account = {
        id: 'responses-retry-timing',
        name: 'responses-retry-timing',
        baseApi: 'https://api.example.com/v1',
        apiKey: 'test-key',
        providerEndpoint: 'responses',
        supportedModels: {},
        maxConcurrentTasks: 0,
        disableAutoProtection: true
      }
      openaiResponsesAccountService.getAccount.mockResolvedValue(account)
      openaiResponsesAccountService.handleProviderQuotaError.mockResolvedValue({ handled: false })
      axios
        .mockResolvedValueOnce({
          status: 503,
          statusText: 'Service Unavailable',
          headers: {},
          data: { error: { message: 'retry me' } }
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          data: { id: 'resp_retry_success', status: 'completed' }
        })

      const req = new EventEmitter()
      req.method = 'POST'
      req.path = '/v1/responses'
      req.headers = {}
      req.body = { model: 'gpt-5', input: 'hi', stream: false }
      req.socket = { destroyed: false }

      await expect(
        openaiResponsesRelayService.handleRequest(
          req,
          new FakeResponse(),
          { id: account.id, name: account.name },
          { id: 'api-key-1' },
          { deferRetryableErrors: true }
        )
      ).rejects.toMatchObject({ code: 'OPENAI_ACCOUNT_FAILOVER' })
      const failedAttemptStartedAt = req.requestTiming.upstreamAttemptStartedAt

      jest.advanceTimersByTime(500)
      await openaiResponsesRelayService.handleRequest(
        req,
        new FakeResponse(),
        { id: account.id, name: account.name },
        { id: 'api-key-1' }
      )

      expect(req.requestTiming.upstreamAttemptCount).toBe(2)
      expect(req.requestTiming.upstreamAttemptStartedAt).toBe(failedAttemptStartedAt + 500)
      expect(req.requestTiming.upstreamResponseHeadersAt).toBe(failedAttemptStartedAt + 500)
      expect(req.requestTiming.upstreamFirstByteAt).toBeNull()
      expect(req.requestTiming.upstreamFirstTokenAt).toBeNull()
      expect(req.requestTiming.upstreamResponseCompletedAt).toBe(failedAttemptStartedAt + 500)
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not abort an established stream when a completed request emits close', async () => {
    const account = createStreamingAccount({ id: 'completed-request-close' })
    const upstream = new FakeUpstream()
    const req = createStreamingRequest()
    const res = new FakeResponse()
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    axios.mockResolvedValue({ status: 200, headers: {}, data: upstream })

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )

    expect(res.flushHeaders).toHaveBeenCalledTimes(1)

    req.destroyed = true
    req.socket.destroyed = true
    req.emit('close')

    expect(axios.mock.calls[0][0].signal.aborted).toBe(false)
    expect(upstream.destroy).not.toHaveBeenCalled()

    upstream.emit(
      'data',
      Buffer.from('data: {"type":"response.output_text.delta","delta":"hi"}\n\n')
    )
    expect(res.body).toContain('response.output_text.delta')

    const finished = new Promise((resolve) => res.once('finished', resolve))
    upstream.emit('end')
    await finished
  })

  it('aborts and records the source when the response closes before it ends', async () => {
    const account = createStreamingAccount({ id: 'response-close' })
    const upstream = new FakeUpstream()
    const req = createStreamingRequest()
    const res = new FakeResponse()
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    axios.mockResolvedValue({ status: 200, headers: {}, data: upstream })

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )
    res.emit('close')

    expect(axios.mock.calls[0][0].signal.aborted).toBe(true)
    expect(upstream.destroy).toHaveBeenCalledTimes(1)
    expect(req.requestFailureContext).toEqual(
      expect.objectContaining({
        accountId: account.id,
        accountType: 'openai-responses',
        failed: true,
        adminDiagnostics: expect.objectContaining({
          openaiResponsesLifecycle: expect.objectContaining({
            disconnectSource: 'response_close_before_end'
          })
        })
      })
    )
  })

  it('does not abort when response close follows res.end()', async () => {
    const account = createStreamingAccount({ id: 'response-ended' })
    const upstream = new FakeUpstream()
    const req = createStreamingRequest()
    const res = new FakeResponse()
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    axios.mockResolvedValue({ status: 200, headers: {}, data: upstream })

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )
    res.end()
    res.emit('close')

    expect(axios.mock.calls[0][0].signal.aborted).toBe(false)
    expect(upstream.destroy).not.toHaveBeenCalled()

    upstream.emit('end')
  })

  it('ignores a response error emitted after the response has ended', async () => {
    const account = createStreamingAccount({ id: 'response-error-after-end' })
    const upstream = new FakeUpstream()
    const req = createStreamingRequest()
    const res = new FakeResponse()
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    axios.mockResolvedValue({ status: 200, headers: {}, data: upstream })

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )
    res.end()
    res.emit('error', Object.assign(new Error('late socket error'), { code: 'EPIPE' }))

    expect(axios.mock.calls[0][0].signal.aborted).toBe(false)
    expect(req.requestFailureContext.failed).toBeUndefined()
    expect(upstream.destroy).not.toHaveBeenCalled()

    upstream.emit('end')
  })

  it('aborts an incomplete request close while the stream is active', async () => {
    const account = createStreamingAccount({ id: 'incomplete-request-close' })
    const upstream = new FakeUpstream()
    const req = createStreamingRequest({ complete: false })
    const res = new FakeResponse()
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    axios.mockResolvedValue({ status: 200, headers: {}, data: upstream })

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )
    req.emit('close')

    expect(axios.mock.calls[0][0].signal.aborted).toBe(true)
    expect(upstream.destroy).toHaveBeenCalledTimes(1)
    expect(
      req.requestFailureContext.adminDiagnostics.openaiResponsesLifecycle.disconnectSource
    ).toBe('request_close_incomplete')
  })

  it('pauses the upstream stream for backpressure and resumes it on drain', async () => {
    const account = createStreamingAccount({ id: 'backpressure-resume' })
    const upstream = new FakeUpstream()
    const req = createStreamingRequest()
    const res = new FakeResponse()
    const originalWrite = res.write.bind(res)
    res.write = jest.fn((chunk) => {
      originalWrite(chunk)
      return false
    })
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    axios.mockResolvedValue({ status: 200, headers: {}, data: upstream })

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )
    upstream.emit(
      'data',
      Buffer.from('data: {"type":"response.output_text.delta","delta":"hi"}\n\n')
    )

    expect(upstream.pause).toHaveBeenCalledTimes(1)
    expect(res.listenerCount('drain')).toBe(1)

    res.emit('drain')

    expect(upstream.resume).toHaveBeenCalledTimes(1)
    expect(res.listenerCount('drain')).toBe(0)
  })

  it('does not resume a paused upstream stream after the client aborts', async () => {
    const account = createStreamingAccount({ id: 'backpressure-abort' })
    const upstream = new FakeUpstream()
    const req = createStreamingRequest()
    const res = new FakeResponse()
    const originalWrite = res.write.bind(res)
    res.write = jest.fn((chunk) => {
      originalWrite(chunk)
      return false
    })
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    axios.mockResolvedValue({ status: 200, headers: {}, data: upstream })

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )
    upstream.emit(
      'data',
      Buffer.from('data: {"type":"response.output_text.delta","delta":"hi"}\n\n')
    )
    expect(upstream.pause).toHaveBeenCalledTimes(1)

    req.aborted = true
    req.emit('aborted')
    res.emit('drain')

    expect(axios.mock.calls[0][0].signal.aborted).toBe(true)
    expect(upstream.destroy).toHaveBeenCalledTimes(1)
    expect(upstream.resume).not.toHaveBeenCalled()
    expect(res.listenerCount('drain')).toBe(0)
    expect(
      req.requestFailureContext.adminDiagnostics.openaiResponsesLifecycle.disconnectSource
    ).toBe('request_aborted')
  })

  it('ends a flushed SSE response rather than attempting a JSON error on upstream failure', async () => {
    const account = createStreamingAccount({ id: 'flushed-stream-error' })
    const upstream = new FakeUpstream()
    const req = createStreamingRequest()
    const res = new FakeResponse()
    const statusSpy = jest.spyOn(res, 'status')
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    axios.mockResolvedValue({ status: 200, headers: {}, data: upstream })

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )
    expect(res.headersSent).toBe(true)

    const finished = new Promise((resolve) => res.once('finished', resolve))
    upstream.emit('error', new Error('upstream stream failed before first chunk'))
    await finished

    expect(statusSpy).not.toHaveBeenCalled()
    expect(res.writableEnded).toBe(true)
  })

  it('finalizes the account lease when an upstream stream closes without end', async () => {
    const account = createStreamingAccount({
      id: 'upstream-close',
      maxConcurrentTasks: 1
    })
    const upstream = new FakeUpstream()
    const req = createStreamingRequest()
    const res = new FakeResponse()
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    redis.incrConcurrency.mockResolvedValue(1)
    redis.decrConcurrency.mockResolvedValue(0)
    axios.mockResolvedValue({ status: 200, headers: {}, data: upstream })

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )

    const finished = new Promise((resolve) => res.once('finished', resolve))
    upstream.emit('close')
    await finished
    await Promise.resolve()

    expect(redis.decrConcurrency).toHaveBeenCalledTimes(1)
    expect(res.writableEnded).toBe(true)
  })

  it('releases a leased stream exactly once when the response and upstream close together', async () => {
    const account = createStreamingAccount({
      id: 'response-close-single-release',
      maxConcurrentTasks: 1
    })
    const upstream = new FakeUpstream()
    const req = createStreamingRequest()
    const res = new FakeResponse()
    openaiResponsesAccountService.getAccount.mockResolvedValue(account)
    redis.incrConcurrency.mockResolvedValue(1)
    redis.decrConcurrency.mockResolvedValue(0)
    axios.mockResolvedValue({ status: 200, headers: {}, data: upstream })

    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )
    res.emit('close')
    upstream.emit('close')
    await new Promise((resolve) => setImmediate(resolve))

    expect(upstream.destroy).toHaveBeenCalledTimes(1)
    expect(redis.decrConcurrency).toHaveBeenCalledTimes(1)
  })

  it('does not start an upstream request after the client leaves during account lookup', async () => {
    const account = createStreamingAccount({ id: 'disconnect-before-account' })
    const req = createStreamingRequest()
    const res = new FakeResponse()
    let resolveAccount
    openaiResponsesAccountService.getAccount.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccount = resolve
        })
    )

    const pendingRequest = openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: account.id, name: account.name },
      { id: 'api-key-1' }
    )

    res.emit('close')
    resolveAccount(account)
    await pendingRequest

    expect(axios).not.toHaveBeenCalled()
  })
})
