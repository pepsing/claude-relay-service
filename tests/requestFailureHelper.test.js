jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}))

const {
  sanitizeFailureValue,
  extractSseFailure,
  shouldCaptureFinalFailure,
  buildRequestFailureRecord
} = require('../src/utils/requestFailureHelper')

function createRequest(overrides = {}) {
  return {
    requestId: 'req_failure_1',
    requestStartedAt: Date.parse('2026-07-25T08:00:00.000Z'),
    requestTiming: {
      requestStartedAt: Date.parse('2026-07-25T08:00:00.000Z'),
      firstByteAt: Date.parse('2026-07-25T08:00:00.100Z'),
      responseCompletedAt: Date.parse('2026-07-25T08:00:01.000Z')
    },
    originalUrl: '/openai/v1/responses',
    method: 'POST',
    headers: {
      authorization: 'Bearer top-secret-token',
      'x-api-key': 'cr_super_secret_key',
      'user-agent': 'codex-test'
    },
    body: {
      model: 'gpt-5.4',
      stream: false,
      input: 'hello'
    },
    requestFailureIdentity: {
      apiKeyId: 'key_1',
      apiKeyName: 'Primary',
      userId: 'user_1'
    },
    ...overrides
  }
}

function createResponse(statusCode = 503, body = null) {
  return {
    statusCode,
    _responseBody: body,
    getHeader: jest.fn(),
    getHeaders: jest.fn(() => ({ 'content-type': 'application/json' }))
  }
}

describe('requestFailureHelper', () => {
  test('redacts API keys, bearer tokens and sensitive object fields', () => {
    expect(
      sanitizeFailureValue({
        authorization: 'Bearer abc.def',
        nested: {
          api_key: 'cr_should_not_leak',
          apiKey: 'cr_camel_case_secret',
          accessToken: 'secret-access-token',
          clientSecret: 'secret-client-value',
          message: 'failed with Bearer secret-value'
        }
      })
    ).toEqual({
      authorization: '[REDACTED]',
      nested: {
        api_key: '[REDACTED]',
        apiKey: '[REDACTED]',
        accessToken: '[REDACTED]',
        clientSecret: '[REDACTED]',
        message: 'failed with [REDACTED]'
      }
    })
  })

  test('recognizes terminal SSE error events but ignores normal events', () => {
    expect(
      extractSseFailure(
        'event: message_start\ndata: {"type":"message_start"}\n\n' +
          'event: error\ndata: {"type":"error","error":{"message":"upstream failed"}}\n\n'
      )
    ).toEqual(
      expect.objectContaining({
        eventName: 'error',
        payload: expect.objectContaining({ type: 'error' })
      })
    )
    expect(
      extractSseFailure('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n')
    ).toBeNull()
  })

  test('captures only attributable final HTTP failures', () => {
    const req = createRequest()
    expect(shouldCaptureFinalFailure(req, createResponse(429)).failed).toBe(true)
    expect(shouldCaptureFinalFailure(req, createResponse(200)).failed).toBe(false)
    expect(
      shouldCaptureFinalFailure(
        createRequest({ requestFailureIdentity: null }),
        createResponse(503)
      ).failed
    ).toBe(false)
  })

  test('builds a failure record without usage or cost fields', () => {
    const record = buildRequestFailureRecord(
      createRequest(),
      createResponse(503, {
        error: {
          type: 'service_unavailable',
          code: 'no_account',
          message: 'No available upstream account'
        }
      })
    )

    expect(record).toEqual(
      expect.objectContaining({
        requestId: 'req_failure_1',
        apiKeyId: 'key_1',
        userIdAtRequest: 'user_1',
        httpStatus: 503,
        failureOrigin: 'upstream',
        failureType: 'no_available_account',
        errorCode: 'no_account',
        errorSummary: 'No available upstream account'
      })
    )
    expect(record).not.toHaveProperty('inputTokens')
    expect(record).not.toHaveProperty('cost')
    expect(record.requestHeaders).not.toHaveProperty('authorization')
    expect(record.requestHeaders).not.toHaveProperty('x-api-key')
    expect(record.requestHeaders['user-agent']).toBe('codex-test')
  })
})
