const PROVIDER_ENDPOINT_RESPONSES = 'responses'
const PROVIDER_ENDPOINT_AUTO = 'auto'
const PROVIDER_ENDPOINT_CHAT_COMPLETIONS = 'chat-completions'

const PROVIDER_ENDPOINT_VALUES = [
  PROVIDER_ENDPOINT_RESPONSES,
  PROVIDER_ENDPOINT_CHAT_COMPLETIONS,
  PROVIDER_ENDPOINT_AUTO
]

const CHAT_COMPLETIONS_ALIASES = new Set([
  PROVIDER_ENDPOINT_CHAT_COMPLETIONS,
  'chat/completions',
  'chat_completions',
  'completions'
])

function normalizeOpenAIProviderEndpoint(value, fallback = PROVIDER_ENDPOINT_RESPONSES) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  const normalized = String(value).trim().toLowerCase()
  if (CHAT_COMPLETIONS_ALIASES.has(normalized)) {
    return PROVIDER_ENDPOINT_CHAT_COMPLETIONS
  }

  if (normalized === PROVIDER_ENDPOINT_RESPONSES || normalized === PROVIDER_ENDPOINT_AUTO) {
    return normalized
  }

  return null
}

function getOpenAIProviderEndpointValues() {
  return [...PROVIDER_ENDPOINT_VALUES]
}

function stripQuery(path = '') {
  return String(path || '').split('?')[0]
}

function pathUsesV1(path = '') {
  const normalized = stripQuery(path)
  return /(^|\/)v1\/(chat\/completions|responses)(\/compact)?$/.test(normalized)
}

function isChatCompletionsPath(path = '') {
  return stripQuery(path).endsWith('/chat/completions')
}

function isImagesGenerationsPath(path = '') {
  return /(^|\/)(v1\/)?images\/generations$/.test(stripQuery(path))
}

function chatCompletionsTargetPath(sourcePath = '') {
  return pathUsesV1(sourcePath) ? '/v1/chat/completions' : '/chat/completions'
}

function responsesTargetPath(sourcePath = '') {
  return pathUsesV1(sourcePath) ? '/v1/responses' : '/responses'
}

function baseApiEndsWithVersion(baseApi = '') {
  const text = String(baseApi || '').trim()
  if (!text) {
    return false
  }

  try {
    const { pathname } = new URL(text)
    return /(^|\/)v\d+$/i.test(pathname.replace(/\/+$/, ''))
  } catch {
    return /(^|\/)v\d+$/i.test(text.replace(/[?#].*$/, '').replace(/\/+$/, ''))
  }
}

function removeDuplicatedVersionPath(baseApi = '', targetPath = '') {
  const normalizedTargetPath = String(targetPath || '')
  if (baseApiEndsWithVersion(baseApi) && /^\/v\d+\//i.test(normalizedTargetPath)) {
    return normalizedTargetPath.replace(/^\/v\d+/i, '')
  }
  return normalizedTargetPath
}

function resolveOpenAIProviderTargetPath({ providerEndpoint, requestPath, originalPath, baseApi }) {
  const normalizedProviderEndpoint =
    normalizeOpenAIProviderEndpoint(providerEndpoint) || PROVIDER_ENDPOINT_RESPONSES
  const sourcePath = stripQuery(originalPath || requestPath || '/v1/responses')
  let targetPath = stripQuery(requestPath || sourcePath)

  if (isImagesGenerationsPath(sourcePath) || isImagesGenerationsPath(targetPath)) {
    targetPath = sourcePath
  } else if (normalizedProviderEndpoint === PROVIDER_ENDPOINT_RESPONSES) {
    if (isChatCompletionsPath(sourcePath) || isChatCompletionsPath(targetPath)) {
      targetPath = responsesTargetPath(sourcePath)
    }
  } else if (normalizedProviderEndpoint === PROVIDER_ENDPOINT_CHAT_COMPLETIONS) {
    targetPath = chatCompletionsTargetPath(sourcePath)
  } else if (normalizedProviderEndpoint === PROVIDER_ENDPOINT_AUTO && originalPath) {
    targetPath = sourcePath
  }

  return {
    providerEndpoint: normalizedProviderEndpoint,
    targetPath: removeDuplicatedVersionPath(baseApi, targetPath)
  }
}

function cloneJson(value) {
  if (!value || typeof value !== 'object') {
    return value
  }
  return JSON.parse(JSON.stringify(value))
}

function normalizeTextContent(content) {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  const textParts = []
  const richParts = []

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue
    }

    if (typeof part.text === 'string') {
      textParts.push(part.text)
      continue
    }

    if (typeof part.output_text === 'string') {
      textParts.push(part.output_text)
      continue
    }

    if (part.type === 'input_image' && part.image_url) {
      richParts.push({ type: 'image_url', image_url: { url: part.image_url } })
    } else if (part.type === 'image_url' && part.image_url) {
      richParts.push(cloneJson(part))
    }
  }

  if (richParts.length === 0) {
    return textParts.join('')
  }

  return [...textParts.filter(Boolean).map((text) => ({ type: 'text', text })), ...richParts]
}

function inputItemToMessage(item) {
  if (typeof item === 'string') {
    return { role: 'user', content: item }
  }

  if (!item || typeof item !== 'object') {
    return null
  }

  const role = item.role || (item.type === 'message' ? 'user' : null)
  const content = normalizeTextContent(item.content ?? item.text ?? item.output_text)

  if (!role || content === '') {
    return null
  }

  return { role, content }
}

function responsesInputToMessages(input) {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }

  if (!Array.isArray(input)) {
    return []
  }

  return input.map(inputItemToMessage).filter(Boolean)
}

function buildChatCompletionsPayloadFromResponsesPayload(payload = {}, originalChatPayload = null) {
  if (originalChatPayload?.messages && Array.isArray(originalChatPayload.messages)) {
    return cloneJson(originalChatPayload)
  }

  const source = payload && typeof payload === 'object' ? payload : {}
  const chatPayload = cloneJson(source) || {}
  const messages = Array.isArray(source.messages)
    ? cloneJson(source.messages)
    : responsesInputToMessages(source.input)

  if (source.instructions && !messages.some((message) => message.role === 'system')) {
    messages.unshift({ role: 'system', content: source.instructions })
  }

  chatPayload.messages = messages.length > 0 ? messages : [{ role: 'user', content: 'hi' }]

  if (source.max_output_tokens !== undefined && chatPayload.max_tokens === undefined) {
    chatPayload.max_tokens = source.max_output_tokens
  }

  delete chatPayload.input
  delete chatPayload.instructions
  delete chatPayload.max_output_tokens
  delete chatPayload.text
  delete chatPayload.reasoning
  delete chatPayload.truncation
  delete chatPayload.parallel_tool_calls
  delete chatPayload.prompt_cache_key
  delete chatPayload.store
  delete chatPayload.include

  return chatPayload
}

module.exports = {
  PROVIDER_ENDPOINT_RESPONSES,
  PROVIDER_ENDPOINT_CHAT_COMPLETIONS,
  PROVIDER_ENDPOINT_AUTO,
  getOpenAIProviderEndpointValues,
  normalizeOpenAIProviderEndpoint,
  resolveOpenAIProviderTargetPath,
  isChatCompletionsPath,
  isImagesGenerationsPath,
  buildChatCompletionsPayloadFromResponsesPayload
}
