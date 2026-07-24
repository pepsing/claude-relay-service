const express = require('express')
const request = require('supertest')

jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (_req, _res, next) => next()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  getMappedModel: jest.fn((modelMapping, model) => modelMapping?.[model] || model),
  handleProviderQuotaError: jest.fn()
}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/services/stickySessionGroupService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/utils/webhookNotifier', () => ({}))
jest.mock('../src/utils/proxyHelper', () => ({
  getProxyAgent: jest.fn(() => null)
}))
jest.mock('../src/routes/admin/utils', () => ({
  formatAccountExpiry: jest.fn((account) => account),
  mapExpiryField: jest.fn((updates) => updates)
}))

const axios = require('axios')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const openaiResponsesAccountsRouter = require('../src/routes/admin/openaiResponsesAccounts')

describe('POST /admin/openai-responses-accounts/:accountId/test', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/admin', openaiResponsesAccountsRouter)
    return app
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rejects image tests when the account capability is disabled', async () => {
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'responses-1',
      name: 'Responses account',
      apiKey: 'provider-secret',
      supportsImagesGenerations: false
    })

    const response = await request(buildApp())
      .post('/admin/openai-responses-accounts/responses-1/test')
      .send({
        testType: 'image',
        model: 'gpt-image-2',
        prompt: 'Draw a blue circle'
      })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      success: false,
      error: 'Images generations is not enabled for this account'
    })
    expect(axios.post).not.toHaveBeenCalled()
  })

  it('generates and returns an image through the selected account', async () => {
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'responses-1',
      name: 'Responses account',
      apiKey: 'provider-secret',
      baseApi: 'https://api.example.com/v1',
      providerEndpoint: 'chat-completions',
      supportsImagesGenerations: true,
      supportedModels: {
        'gpt-image-2': 'provider-image-model'
      }
    })
    axios.post.mockResolvedValue({
      data: {
        output_format: 'png',
        data: [
          {
            b64_json: 'generated-image-base64',
            revised_prompt: 'A revised blue circle'
          }
        ]
      }
    })

    const response = await request(buildApp())
      .post('/admin/openai-responses-accounts/responses-1/test')
      .send({
        testType: 'image',
        model: 'gpt-image-2',
        prompt: 'Draw a blue circle'
      })

    expect(response.status).toBe(200)
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.example.com/v1/images/generations',
      {
        model: 'provider-image-model',
        prompt: 'Draw a blue circle',
        n: 1
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer provider-secret'
        }),
        timeout: 180000,
        maxContentLength: 25 * 1024 * 1024
      })
    )
    expect(response.body).toEqual({
      success: true,
      data: expect.objectContaining({
        accountId: 'responses-1',
        accountName: 'Responses account',
        model: 'gpt-image-2',
        upstreamModel: 'provider-image-model',
        responseText: 'A revised blue circle',
        image: {
          b64Json: 'generated-image-base64',
          url: '',
          mediaType: 'image/png'
        }
      })
    })
    expect(JSON.stringify(response.body)).not.toContain('provider-secret')
  })

  it('requires a non-empty prompt for image tests', async () => {
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'responses-1',
      name: 'Responses account',
      apiKey: 'provider-secret',
      supportsImagesGenerations: true
    })

    const response = await request(buildApp())
      .post('/admin/openai-responses-accounts/responses-1/test')
      .send({
        testType: 'image',
        model: 'gpt-image-2',
        prompt: '   '
      })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      success: false,
      error: 'prompt is required for image generation'
    })
    expect(axios.post).not.toHaveBeenCalled()
  })

  it('tests Responses accounts with streaming enabled and parses SSE output', async () => {
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'responses-1',
      name: 'Responses account',
      apiKey: 'provider-secret',
      baseApi: 'https://api.example.com/v1',
      providerEndpoint: 'responses'
    })
    axios.post.mockResolvedValue({
      data: [
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"Hello "}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"from SSE"}',
        ''
      ].join('\n')
    })

    const response = await request(buildApp())
      .post('/admin/openai-responses-accounts/responses-1/test')
      .send({
        testType: 'text',
        model: 'gpt-5.6-sol',
        prompt: 'hi'
      })

    expect(response.status).toBe(200)
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.example.com/v1/responses',
      expect.objectContaining({
        model: 'gpt-5.6-sol',
        stream: true,
        input: [{ role: 'user', content: 'hi' }]
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer provider-secret'
        })
      })
    )
    expect(response.body).toEqual({
      success: true,
      data: expect.objectContaining({
        accountId: 'responses-1',
        accountName: 'Responses account',
        model: 'gpt-5.6-sol',
        responseText: 'Hello from SSE'
      })
    })
  })
})
