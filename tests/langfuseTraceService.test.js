jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../config/config', () => ({
  langfuse: {
    enabled: true,
    requestTracesEnabled: true,
    quotaCyclesEnabled: true,
    requestPayloadsEnabled: true,
    successSampleRate: 1,
    captureSlowRequests: true,
    slowRequestThresholdMs: 30000,
    baseUrl: 'http://langfuse.local:3300/',
    publicKey: 'pk-test',
    secretKey: 'sk-test',
    timeoutMs: 1234,
    environment: 'test'
  }
}))

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  start: jest.fn()
}))

const axios = require('axios')
const config = require('../config/config')
const langfuseTraceService = require('../src/services/langfuseTraceService')

describe('langfuseTraceService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    config.langfuse.enabled = true
    config.langfuse.requestTracesEnabled = true
    config.langfuse.quotaCyclesEnabled = true
    config.langfuse.requestPayloadsEnabled = true
    config.langfuse.successSampleRate = 1
    axios.post.mockResolvedValue({
      data: {
        successes: [{ id: 'req_1-trace-create', status: 201 }],
        errors: []
      }
    })
  })

  test('captures sampled request detail with payloads only on the generation', async () => {
    const result = await langfuseTraceService.captureRequestDetail({
      requestId: 'req_1',
      timestamp: '2026-06-04T07:00:00.000Z',
      requestStartedAt: '2026-06-04T07:00:00.000Z',
      responseCompletedAt: '2026-06-04T07:00:02.000Z',
      endpoint: '/api/v1/messages',
      method: 'POST',
      statusCode: 200,
      stream: true,
      apiKeyId: 'key_1',
      apiKeyName: '吴满江',
      accountId: 'acct_1',
      accountName: 'Claude Console Main',
      accountType: 'claude-console',
      accountTypeName: 'Claude Console',
      model: 'gpt-5.5',
      sessionHash: 'session_hash_1',
      metadataUserId:
        '{"device_id":"device_123","account_uuid":"","session_id":"session_from_metadata"}',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheCreateTokens: 2,
      totalTokens: 20,
      cost: 0.123456,
      realCost: 0.012345,
      realCostBreakdown: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0.003,
        cacheCreate: 0.004,
        total: 0.012345
      },
      requestBody: {
        apiKey: 'raw-secret',
        messages: [{ role: 'user', content: 'hello' }]
      },
      responseBody: {
        id: 'resp_1',
        content: 'world'
      }
    })

    expect(result).toEqual({ captured: true, requestId: 'req_1' })
    expect(axios.post).toHaveBeenCalledWith(
      'http://langfuse.local:3300/api/public/ingestion',
      expect.objectContaining({
        batch: expect.arrayContaining([
          expect.objectContaining({ type: 'trace-create' }),
          expect.objectContaining({ type: 'generation-create' })
        ])
      }),
      expect.objectContaining({
        auth: {
          username: 'pk-test',
          password: 'sk-test'
        },
        timeout: 1234
      })
    )

    const payload = axios.post.mock.calls[0][1]
    const traceEvent = payload.batch.find((event) => event.type === 'trace-create')
    const generationEvent = payload.batch.find((event) => event.type === 'generation-create')

    expect(traceEvent.body).toEqual(
      expect.objectContaining({
        id: 'req_1',
        name: '/api/v1/messages',
        userId: '吴满江',
        sessionId: 'session_hash_1',
        tags: expect.arrayContaining([
          'crs',
          'test',
          'claude-console',
          'account:Claude Console Main',
          'account_id:acct_1',
          'gpt-5.5',
          'stream'
        ])
      })
    )
    expect(traceEvent.body).not.toHaveProperty('input')
    expect(traceEvent.body).not.toHaveProperty('output')
    expect(traceEvent.body.metadata.detail).toBeUndefined()
    expect(traceEvent.body.metadata.accountName).toBe('Claude Console Main')
    expect(traceEvent.body.metadata.accountTypeName).toBe('Claude Console')
    expect(traceEvent.body.metadata.metadataDeviceId).toBe('device_123')
    expect(traceEvent.body.metadata.metadataSessionId).toBe('session_from_metadata')
    expect(generationEvent.body).toEqual(
      expect.objectContaining({
        id: 'req_1-generation',
        traceId: 'req_1',
        model: 'gpt-5.5',
        input: expect.objectContaining({ apiKey: 'raw-secret' }),
        output: expect.objectContaining({ id: 'resp_1' }),
        usage: expect.objectContaining({
          input: 10,
          output: 5,
          total: 20,
          cacheReadTokens: 3,
          cacheCreateTokens: 2
        }),
        usageDetails: {
          input: 10,
          output: 5,
          cache_read_input: 3,
          cache_creation_input: 2,
          total: 20
        },
        costDetails: expect.objectContaining({
          input: 0.001,
          output: 0.002,
          cache_read_input: 0.003,
          cache_creation_input: 0.004,
          total: 0.012345
        })
      })
    )
  })

  test('omits request payloads and large response metadata by default', async () => {
    config.langfuse.requestPayloadsEnabled = false

    const result = await langfuseTraceService.captureRequestDetail({
      requestId: 'req_minimal',
      statusCode: 500,
      durationMs: 10,
      model: 'gpt-5.5',
      requestBody: { secret: 'do-not-copy' },
      responseBody: { content: 'do-not-copy' },
      responseHeaders: { authorization: 'do-not-copy' },
      responseTextPreview: 'do-not-copy',
      responseMetadata: { raw: 'do-not-copy' },
      metadata: { raw: 'do-not-copy' }
    })

    expect(result).toEqual({ captured: true, requestId: 'req_minimal' })
    const payload = axios.post.mock.calls[0][1]
    for (const event of payload.batch) {
      expect(event.body).not.toHaveProperty('input')
      expect(event.body).not.toHaveProperty('output')
    }
    expect(payload.batch[0].body.metadata).not.toHaveProperty('responseHeaders')
    expect(payload.batch[0].body.metadata).not.toHaveProperty('responseTextPreview')
    expect(payload.batch[0].body.metadata).not.toHaveProperty('responseMetadata')
    expect(payload.batch[0].body.metadata).not.toHaveProperty('metadata')
  })

  test('always captures errors and slow requests but samples ordinary successes', async () => {
    config.langfuse.requestPayloadsEnabled = false
    config.langfuse.successSampleRate = 0
    config.langfuse.slowRequestThresholdMs = 1000

    await expect(
      langfuseTraceService.captureRequestDetail({
        requestId: 'req_success',
        statusCode: 200,
        durationMs: 20
      })
    ).resolves.toEqual({ captured: false, reason: 'sampled_out' })
    await expect(
      langfuseTraceService.captureRequestDetail({
        requestId: 'req_error',
        statusCode: 500,
        durationMs: 20
      })
    ).resolves.toEqual({ captured: true, requestId: 'req_error' })
    await expect(
      langfuseTraceService.captureRequestDetail({
        requestId: 'req_slow',
        statusCode: 200,
        durationMs: 1000
      })
    ).resolves.toEqual({ captured: true, requestId: 'req_slow' })
    expect(axios.post).toHaveBeenCalledTimes(2)
  })

  test('captures a body-free quota cycle trace with one deterministic generation per model', async () => {
    const summary = {
      cycleId: 'cycle_glm_weekly_1',
      quotaGroupId: 'quota_group_1',
      provider: 'glm',
      windowType: 'weekly',
      completeness: 'complete',
      status: 'exceeded',
      boundarySource: 'provider',
      windowStartAt: '2026-06-01T00:00:00.000Z',
      firstExceededAt: '2026-06-07T20:00:00.000Z',
      resetAt: '2026-06-08T00:00:00.000Z',
      accountRefs: [
        {
          accountId: 'acct_1',
          accountName: 'GLM Main',
          accountType: 'claude-console'
        }
      ],
      providerSnapshot: {
        percentage: 100,
        total: 1000,
        used: 1000,
        remaining: 0,
        resetAt: '2026-06-08T00:00:00.000Z',
        rawData: {
          shouldNotBeSent: true
        }
      },
      usageSummary: {
        source: 'usage_events',
        semantics: 'crs_observed_usage',
        observedFromAt: '2026-06-01T00:00:00.000Z',
        observedThroughAt: '2026-06-07T20:00:00.000Z',
        totals: {
          requests: 15,
          inputTokens: 140,
          outputTokens: 60,
          cacheReadTokens: 30,
          cacheCreateTokens: 20,
          totalTokens: 250,
          cost: 1.5
        }
      },
      models: [
        {
          model: 'glm-5',
          requests: 12,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 30,
          cacheCreateTokens: 20,
          totalTokens: 200,
          cost: 1.25
        },
        {
          model: 'glm-4.7',
          requests: 3,
          inputTokens: 40,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          totalTokens: 50,
          cost: 0.25
        }
      ]
    }

    const result = await langfuseTraceService.captureQuotaCycleSummary(summary)

    expect(result).toEqual({
      captured: true,
      cycleId: 'cycle_glm_weekly_1',
      traceId: langfuseTraceService._private.buildQuotaCycleTraceId('cycle_glm_weekly_1')
    })
    expect(axios.post).toHaveBeenCalledWith(
      'http://langfuse.local:3300/api/public/ingestion',
      expect.objectContaining({
        batch: expect.any(Array)
      }),
      expect.objectContaining({
        auth: {
          username: 'pk-test',
          password: 'sk-test'
        },
        timeout: 1234
      })
    )

    const payload = axios.post.mock.calls[0][1]
    const traceEvent = payload.batch.find((event) => event.type === 'trace-create')
    const generationEvents = payload.batch.filter((event) => event.type === 'generation-create')
    const glm5Generation = generationEvents.find((event) => event.body.model === 'glm-5')

    expect(payload.batch).toHaveLength(3)
    expect(traceEvent.body).not.toHaveProperty('input')
    expect(traceEvent.body).not.toHaveProperty('output')
    expect(traceEvent.body).toEqual(
      expect.objectContaining({
        name: 'quota-cycle-summary',
        sessionId: 'quota_group_1',
        tags: expect.arrayContaining([
          'quota-cycle',
          'provider:glm',
          'quota-window:weekly',
          'quota-completeness:complete'
        ]),
        metadata: expect.objectContaining({
          cycleId: 'cycle_glm_weekly_1',
          provider: 'glm',
          windowType: 'weekly',
          completeness: 'complete',
          requests: 15,
          totalTokens: 250,
          usageSource: 'usage_events',
          usageSemantics: 'crs_observed_usage',
          observedThroughAt: '2026-06-07T20:00:00.000Z'
        })
      })
    )
    expect(traceEvent.body.metadata.providerSnapshot.rawData).toBeUndefined()
    expect(generationEvents).toHaveLength(2)
    expect(glm5Generation.body).not.toHaveProperty('input')
    expect(glm5Generation.body).not.toHaveProperty('output')
    expect(glm5Generation.body).toEqual(
      expect.objectContaining({
        id: langfuseTraceService._private.buildQuotaCycleGenerationId(
          'cycle_glm_weekly_1',
          'glm-5'
        ),
        traceId: traceEvent.body.id,
        model: 'glm-5',
        usageDetails: {
          input: 100,
          output: 50,
          cache: 50,
          cache_read_input: 30,
          cache_creation_input: 20,
          total: 200,
          requests: 12
        }
      })
    )
  })

  test('builds stable quota cycle ids and supports object or Map model summaries', () => {
    const runtimeConfig = {
      environment: 'test'
    }
    const objectSummary = {
      cycleId: 'cycle_2',
      provider: 'kimi',
      windowType: 'billing_cycle',
      isPartial: true,
      usageSummary: {
        byModel: {
          'kimi-k2': {
            requestCount: 4,
            input: 80,
            output: 20,
            cacheRead: 10,
            total: 110
          }
        }
      }
    }
    const first = langfuseTraceService._private.buildQuotaCycleSummaryPayload(
      objectSummary,
      runtimeConfig
    )
    const second = langfuseTraceService._private.buildQuotaCycleSummaryPayload(
      objectSummary,
      runtimeConfig
    )
    const mapModels = langfuseTraceService._private.normalizeQuotaCycleModels({
      usageSummary: {
        byModel: new Map([
          [
            'doubao-pro',
            {
              calls: 2,
              inputTokens: 10,
              outputTokens: 5
            }
          ]
        ])
      }
    })
    const persistedModels = langfuseTraceService._private.normalizeQuotaCycleModels({
      usageSummary: {
        models: [
          {
            model: 'glm-5',
            requests: 7,
            inputTokens: 30,
            outputTokens: 10,
            realCost: 0.4
          }
        ]
      }
    })

    expect(first.traceId).toBe(second.traceId)
    expect(first.payload.batch.map((event) => event.id)).toEqual(
      second.payload.batch.map((event) => event.id)
    )
    expect(first.payload.batch[0].body.tags).toContain('quota-completeness:partial')
    expect(first.payload.batch[1].body.model).toBe('kimi-k2')
    expect(mapModels).toEqual([
      expect.objectContaining({
        model: 'doubao-pro',
        requests: 2,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      })
    ])
    expect(persistedModels).toEqual([
      expect.objectContaining({
        model: 'glm-5',
        requests: 7,
        totalTokens: 40,
        cost: 0.4
      })
    ])
  })

  test('does not throw or post when quota cycle capture is disabled', async () => {
    config.langfuse.quotaCyclesEnabled = false

    const result = await langfuseTraceService.captureQuotaCycleSummary({
      cycleId: 'cycle_disabled'
    })

    expect(result).toEqual({
      captured: false,
      reason: 'disabled',
      cycleId: 'cycle_disabled',
      traceId: langfuseTraceService._private.buildQuotaCycleTraceId('cycle_disabled')
    })
    expect(axios.post).not.toHaveBeenCalled()
  })
})
