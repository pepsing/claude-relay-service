const {
  OPENAI_CODEX_TEST_INSTRUCTIONS,
  createClaudeTestPayload,
  createOpenAITestPayload,
  extractOpenAIResponsesText,
  extractErrorMessage,
  getClaudeCodeTestHeaders,
  sanitizeErrorMsg
} = require('../src/utils/testPayloadHelper')
const ClaudeCodeValidator = require('../src/validators/clients/claudeCodeValidator')

function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  )
}

describe('testPayloadHelper', () => {
  test('creates Claude Code-compatible Anthropic test requests', () => {
    const payload = createClaudeTestPayload('claude-sonnet-4-5-20250929', {
      stream: true,
      prompt: 'custom test prompt'
    })

    expect(payload).toEqual(
      expect.objectContaining({
        model: 'claude-sonnet-4-5-20250929',
        stream: true,
        max_tokens: 1000,
        metadata: expect.objectContaining({
          user_id: expect.stringMatching(/^user_[0-9a-f]{64}_account__session_/)
        })
      })
    )
    expect(
      ClaudeCodeValidator.validate({
        headers: normalizeHeaders(getClaudeCodeTestHeaders()),
        path: '/v1/messages',
        body: payload
      })
    ).toBe(true)
  })

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
