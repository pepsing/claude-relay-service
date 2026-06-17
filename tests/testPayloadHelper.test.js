const {
  OPENAI_CODEX_TEST_INSTRUCTIONS,
  createOpenAITestPayload,
  extractOpenAIResponsesText,
  extractErrorMessage,
  sanitizeErrorMsg
} = require('../src/utils/testPayloadHelper')

describe('testPayloadHelper', () => {
  test('creates the default OpenAI Responses test payload with max_output_tokens', () => {
    expect(createOpenAITestPayload('gpt-5', { prompt: 'hi', maxTokens: 12 })).toEqual({
      model: 'gpt-5',
      input: [{ role: 'user', content: 'hi' }],
      stream: true,
      max_output_tokens: 12
    })
  })

  test('creates a Codex-like OpenAI Responses test payload without max_output_tokens', () => {
    expect(
      createOpenAITestPayload('gpt-5.5', {
        prompt: 'hi,hello,haha',
        instructions: OPENAI_CODEX_TEST_INSTRUCTIONS,
        includeMaxOutputTokens: false
      })
    ).toEqual({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hi,hello,haha' }],
      stream: true,
      instructions: OPENAI_CODEX_TEST_INSTRUCTIONS
    })
  })

  test('extracts OpenAI Responses nested errors and detail errors', () => {
    expect(
      extractErrorMessage(
        {
          response: {
            error: {
              code: 'upstream_error',
              message: 'Upstream request failed'
            }
          }
        },
        'fallback'
      )
    ).toBe('Upstream request failed')

    expect(extractErrorMessage({ detail: 'Instructions are required' }, 'fallback')).toBe(
      'Instructions are required'
    )
  })

  test('uses HTTP status when sanitizing test errors', () => {
    expect(sanitizeErrorMsg('API Error: 403', 403)).toBe('[E009] Permission denied')
  })

  test('extracts text from OpenAI Responses JSON and SSE bodies', () => {
    expect(
      extractOpenAIResponsesText({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Hello from JSON' }]
          }
        ]
      })
    ).toBe('Hello from JSON')

    expect(
      extractOpenAIResponsesText(
        [
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"Hello "}',
          '',
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"from SSE"}',
          ''
        ].join('\n')
      )
    ).toBe('Hello from SSE')
  })
})
