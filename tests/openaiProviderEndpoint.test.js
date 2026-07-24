const {
  PROVIDER_ENDPOINT_CHAT_COMPLETIONS,
  buildChatCompletionsPayloadFromResponsesPayload,
  normalizeOpenAIProviderEndpoint,
  resolveOpenAIProviderTargetPath
} = require('../src/utils/openaiProviderEndpoint')

describe('openaiProviderEndpoint', () => {
  test('normalizes chat completions aliases', () => {
    expect(normalizeOpenAIProviderEndpoint('chat-completions')).toBe(
      PROVIDER_ENDPOINT_CHAT_COMPLETIONS
    )
    expect(normalizeOpenAIProviderEndpoint('completions')).toBe(PROVIDER_ENDPOINT_CHAT_COMPLETIONS)
    expect(normalizeOpenAIProviderEndpoint('chat/completions')).toBe(
      PROVIDER_ENDPOINT_CHAT_COMPLETIONS
    )
    expect(normalizeOpenAIProviderEndpoint('responses')).toBe('responses')
    expect(normalizeOpenAIProviderEndpoint('unknown')).toBeNull()
  })

  test('resolves responses target without duplicating v1 in baseApi', () => {
    expect(
      resolveOpenAIProviderTargetPath({
        providerEndpoint: 'responses',
        requestPath: '/v1/responses',
        baseApi: 'https://api.example.com/v1'
      })
    ).toEqual({
      providerEndpoint: 'responses',
      targetPath: '/responses'
    })
  })

  test('preserves images generations paths for regular Responses providers', () => {
    expect(
      resolveOpenAIProviderTargetPath({
        providerEndpoint: 'responses',
        requestPath: '/v1/images/generations',
        baseApi: 'https://api.example.com/v1'
      })
    ).toEqual({
      providerEndpoint: 'responses',
      targetPath: '/images/generations'
    })

    expect(
      resolveOpenAIProviderTargetPath({
        providerEndpoint: 'chat-completions',
        requestPath: '/v1/images/generations',
        baseApi: 'https://api.example.com'
      })
    ).toEqual({
      providerEndpoint: 'chat-completions',
      targetPath: '/v1/images/generations'
    })
  })

  test('resolves chat completions target without duplicating versioned baseApi', () => {
    expect(
      resolveOpenAIProviderTargetPath({
        providerEndpoint: 'chat-completions',
        requestPath: '/v1/chat/completions',
        baseApi: 'https://open.bigmodel.cn/api/coding/paas/v4'
      })
    ).toEqual({
      providerEndpoint: 'chat-completions',
      targetPath: '/chat/completions'
    })

    expect(
      resolveOpenAIProviderTargetPath({
        providerEndpoint: 'chat-completions',
        requestPath: '/v1/chat/completions',
        baseApi: 'https://ark.cn-beijing.volces.com/api/coding/v3'
      })
    ).toEqual({
      providerEndpoint: 'chat-completions',
      targetPath: '/chat/completions'
    })
  })

  test('resolves chat completions target from unified original path', () => {
    expect(
      resolveOpenAIProviderTargetPath({
        providerEndpoint: 'chat-completions',
        requestPath: '/v1/responses',
        originalPath: '/v1/chat/completions',
        baseApi: 'https://api.example.com'
      })
    ).toEqual({
      providerEndpoint: 'chat-completions',
      targetPath: '/v1/chat/completions'
    })
  })

  test('auto endpoint keeps unified original chat completions path', () => {
    expect(
      resolveOpenAIProviderTargetPath({
        providerEndpoint: 'auto',
        requestPath: '/v1/responses',
        originalPath: '/v1/chat/completions',
        baseApi: 'https://api.example.com/v1'
      })
    ).toEqual({
      providerEndpoint: 'auto',
      targetPath: '/chat/completions'
    })
  })

  test('keeps original chat completions payload when provided', () => {
    const original = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true
    }

    expect(
      buildChatCompletionsPayloadFromResponsesPayload(
        {
          model: 'gpt-4o-mini',
          input: [{ role: 'user', content: 'converted' }],
          stream: true
        },
        original
      )
    ).toEqual(original)
  })

  test('converts responses payload to chat completions payload as a fallback', () => {
    expect(
      buildChatCompletionsPayloadFromResponsesPayload({
        model: 'gpt-4o-mini',
        instructions: 'be terse',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        max_output_tokens: 128,
        stream: false,
        store: false
      })
    ).toEqual({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hello' }
      ],
      max_tokens: 128,
      stream: false
    })
  })
})
