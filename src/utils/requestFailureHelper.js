const { createRequestDetailMeta, sanitizeRequestBodySnapshot } = require('./requestDetailHelper')
const { sanitizeErrorForClient } = require('./upstreamErrorHelper')

const MAX_ERROR_SUMMARY_CHARS = 1000
const SENSITIVE_KEY_PATTERN =
  /^(authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|x[-_]?api[-_]?key|api[-_]?key|x[-_]?goog[-_]?api[-_]?key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret)$/i
const SECRET_TEXT_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(cr(?:sm)?_[A-Za-z0-9_-]{8,})\b/g,
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(AIza[A-Za-z0-9_-]{20,})\b/g
]
const REQUEST_HEADER_ALLOWLIST = new Set([
  'content-type',
  'content-length',
  'user-agent',
  'anthropic-version',
  'anthropic-beta',
  'x-request-id',
  'request-id',
  'x-session-id',
  'session-id',
  'x-conversation-id',
  'x-thread-id'
])

function isRelayApiRoute(req) {
  const url = String(req?.originalUrl || req?.url || '').split('?')[0]
  return [
    '/api',
    '/claude',
    '/openai',
    '/azure',
    '/droid',
    '/gemini',
    '/antigravity',
    '/gemini-cli'
  ].some((prefix) => url === prefix || url.startsWith(`${prefix}/`))
}

function redactText(value) {
  let redacted = String(value)
  for (const pattern of SECRET_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]')
  }
  return redacted
}

function sanitizeFailureValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return redactText(value)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return '[Circular]'
  }

  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeFailureValue(item, seen))
  }

  const sanitized = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : sanitizeFailureValue(nestedValue, seen)
  }
  return sanitized
}

function filterRequestHeaders(headers = {}) {
  const filtered = {}
  for (const [key, value] of Object.entries(headers || {})) {
    const normalizedKey = String(key).trim().toLowerCase()
    if (REQUEST_HEADER_ALLOWLIST.has(normalizedKey)) {
      filtered[normalizedKey] = sanitizeFailureValue(value)
    }
  }
  return filtered
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function parseErrorPayload(payload) {
  if (!payload) {
    return {}
  }

  let parsed = payload
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload)
    } catch {
      return {
        message: payload
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      message: String(parsed)
    }
  }

  const nestedError = parsed.error && typeof parsed.error === 'object' ? parsed.error : {}
  return {
    type: firstNonEmptyString(
      nestedError.type,
      parsed.type === 'error' ? parsed.code : null,
      parsed.errorType
    ),
    code: firstNonEmptyString(nestedError.code, parsed.code, parsed.error_code),
    message: firstNonEmptyString(
      nestedError.message,
      typeof parsed.error === 'string' ? parsed.error : null,
      parsed.message,
      parsed.detail
    )
  }
}

function extractSseFailure(capturedText) {
  if (typeof capturedText !== 'string' || !capturedText.trim()) {
    return null
  }

  const events = capturedText.split(/\r?\n\r?\n/)
  for (const rawEvent of events) {
    const lines = rawEvent.split(/\r?\n/)
    const eventName = lines
      .find((line) => line.trim().startsWith('event:'))
      ?.replace(/^\s*event:\s*/i, '')
      .trim()
      .toLowerCase()
    const dataLines = lines
      .filter((line) => line.trim().startsWith('data:'))
      .map((line) => line.replace(/^\s*data:\s*/i, ''))
    const dataText = dataLines.join('\n').trim()

    let data = null
    if (dataText && dataText !== '[DONE]') {
      try {
        data = JSON.parse(dataText)
      } catch {
        data = null
      }
    }

    const type = String(data?.type || '').toLowerCase()
    const status = String(data?.response?.status || data?.status || '').toLowerCase()
    const failed =
      eventName === 'error' || type === 'error' || type === 'response.failed' || status === 'failed'

    if (failed) {
      return {
        eventName: eventName || null,
        payload: data || dataText || rawEvent
      }
    }
  }

  return null
}

function markRequestFailure(req, details = {}) {
  if (!req || !details || typeof details !== 'object') {
    return
  }

  req.requestFailureContext = {
    ...(req.requestFailureContext || {}),
    ...sanitizeFailureValue(details),
    failed: true
  }
}

function classifyFailure(statusCode, context = {}, parsedError = {}) {
  if (context.type) {
    return context.type
  }

  const code = String(context.code || parsedError.code || '').toLowerCase()
  const message = String(context.message || parsedError.message || '').toLowerCase()
  if (statusCode === 499 || context.clientAborted === true) {
    return 'client_aborted'
  }
  if (statusCode === 402 || code.includes('quota') || message.includes('quota')) {
    return 'quota_exceeded'
  }
  if (statusCode === 429 || code.includes('rate_limit') || message.includes('rate limit')) {
    return 'rate_limit'
  }
  if ([408, 504].includes(statusCode) || code.includes('timeout') || message.includes('timeout')) {
    return 'timeout'
  }
  if (
    statusCode === 503 &&
    (code.includes('no_account') ||
      message.includes('no available') ||
      message.includes('account not found'))
  ) {
    return 'no_available_account'
  }
  if (statusCode === 401) {
    return context.origin === 'upstream' ? 'upstream_auth_error' : 'authentication_error'
  }
  if (statusCode === 403) {
    return 'permission_denied'
  }
  if (statusCode === 400 || statusCode === 404 || statusCode === 413) {
    return 'request_validation_error'
  }
  if (statusCode === 502 || statusCode === 503) {
    return 'upstream_unavailable'
  }
  if (statusCode >= 500) {
    return context.origin === 'upstream' ? 'upstream_error' : 'internal_error'
  }
  if (context.phase === 'stream') {
    return 'upstream_stream_error'
  }
  return 'request_failed'
}

function inferFailurePhase(statusCode, context = {}) {
  if (context.phase) {
    return context.phase
  }
  if (statusCode === 402) {
    return 'quota'
  }
  if (statusCode === 429) {
    return 'rate_limit'
  }
  if ([502, 503, 504].includes(statusCode)) {
    return 'upstream'
  }
  if (statusCode === 499) {
    return 'transport'
  }
  if (statusCode >= 500) {
    return 'internal'
  }
  if (statusCode >= 400) {
    return 'validation'
  }
  return 'stream'
}

function inferFailureOrigin(statusCode, context = {}) {
  if (context.origin) {
    return context.origin
  }
  if ([502, 503, 504].includes(statusCode)) {
    return 'upstream'
  }
  if (statusCode === 499) {
    return 'client'
  }
  if (statusCode >= 500) {
    return 'relay'
  }
  return 'client'
}

function getRetryAfterSeconds(res) {
  const value = res?.getHeader?.('Retry-After')
  if (value === null || value === undefined || value === '') {
    return null
  }

  const seconds = Number.parseInt(value, 10)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds
  }

  const retryDate = new Date(String(value))
  if (Number.isNaN(retryDate.getTime())) {
    return null
  }
  return Math.max(0, Math.ceil((retryDate.getTime() - Date.now()) / 1000))
}

function shouldCaptureFinalFailure(req, res, options = {}) {
  if (!isRelayApiRoute(req) || !req?.requestFailureIdentity?.apiKeyId) {
    return { failed: false }
  }

  const statusCode = options.clientAborted === true ? 499 : Number(res?.statusCode || 0)
  if (statusCode >= 400) {
    return { failed: true, statusCode, streamFailure: null }
  }

  if (req.requestFailureContext?.failed === true) {
    return { failed: true, statusCode: statusCode || 200, streamFailure: null }
  }

  const captureMeta = req.responsePayloadCapture?.toRequestDetailMeta?.() || {}
  const streamFailure = extractSseFailure(captureMeta.responseTextPreview)
  return {
    failed: Boolean(streamFailure),
    statusCode: statusCode || 200,
    streamFailure
  }
}

function buildRequestFailureRecord(req, res, options = {}) {
  const decision = shouldCaptureFinalFailure(req, res, options)
  if (!decision.failed) {
    return null
  }

  const context = {
    ...(req.requestFailureContext || {}),
    ...(options.context || {})
  }
  if (options.clientAborted === true) {
    context.clientAborted = true
    context.origin = context.origin || 'client'
    context.phase = context.phase || 'transport'
  }

  const requestMeta = createRequestDetailMeta(req, {
    statusCode: decision.statusCode,
    responseCompletedAt: Date.now()
  })
  const clientBody =
    res?._responseBody ??
    requestMeta.responseBodySnapshot ??
    requestMeta.responseTextPreview ??
    decision.streamFailure?.payload ??
    null
  const sanitizedClientBody = sanitizeFailureValue(sanitizeErrorForClient(clientBody))
  const parsedError = parseErrorPayload(
    context.clientErrorBody || decision.streamFailure?.payload || sanitizedClientBody
  )
  const errorSummary = firstNonEmptyString(
    context.message,
    parsedError.message,
    typeof sanitizedClientBody === 'string' ? sanitizedClientBody : null,
    `HTTP ${decision.statusCode}`
  )

  return {
    requestId: requestMeta.requestId,
    timestamp: requestMeta.responseCompletedAt || new Date().toISOString(),
    requestStartedAt: requestMeta.requestStartedAt,
    responseCompletedAt: requestMeta.responseCompletedAt,
    apiKeyId: req.requestFailureIdentity.apiKeyId,
    apiKeyName: req.requestFailureIdentity.apiKeyName || null,
    userIdAtRequest: req.requestFailureIdentity.userId || null,
    accountId: context.accountId || null,
    accountType: context.accountType || null,
    endpoint: requestMeta.endpoint,
    method: requestMeta.method,
    model: context.model || req.body?.model || 'unknown',
    stream: requestMeta.stream === true,
    httpStatus: decision.statusCode,
    failureOrigin: inferFailureOrigin(decision.statusCode, context),
    failurePhase: inferFailurePhase(decision.statusCode, context),
    failureType: classifyFailure(decision.statusCode, context, parsedError),
    errorCode: context.code || parsedError.code || null,
    errorSummary: redactText(errorSummary).slice(0, MAX_ERROR_SUMMARY_CHARS),
    retryable:
      typeof context.retryable === 'boolean'
        ? context.retryable
        : [429, 502, 503, 504].includes(decision.statusCode),
    retryAfterSeconds: context.retryAfterSeconds ?? getRetryAfterSeconds(res),
    durationMs: requestMeta.durationMs,
    timeToFirstByteMs: requestMeta.timeToFirstByteMs,
    clientAborted: options.clientAborted === true,
    sessionId: requestMeta.sessionId || null,
    sessionHash: requestMeta.sessionHash || null,
    userAgent: req.headers?.['user-agent']
      ? redactText(req.headers['user-agent']).slice(0, 500)
      : null,
    requestHeaders: filterRequestHeaders(req.headers || {}),
    requestBodySnapshot: sanitizeRequestBodySnapshot(req.body),
    clientResponseHeaders: sanitizeFailureValue(requestMeta.responseHeaders || {}),
    clientErrorBody: sanitizedClientBody,
    upstreamErrorBody: sanitizeFailureValue(context.upstreamErrorBody || null),
    adminDiagnostics: sanitizeFailureValue(context.adminDiagnostics || null),
    requestBodyTruncated: requestMeta.requestBodyTruncated === true,
    responseBodyTruncated: requestMeta.responseBodyTruncated === true
  }
}

module.exports = {
  isRelayApiRoute,
  sanitizeFailureValue,
  extractSseFailure,
  markRequestFailure,
  shouldCaptureFinalFailure,
  buildRequestFailureRecord
}
