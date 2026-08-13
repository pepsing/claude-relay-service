const axios = require('axios')
const crypto = require('crypto')
const config = require('../../config/config')
const logger = require('../utils/logger')
const metadataUserIdHelper = require('../utils/metadataUserIdHelper')

const DEFAULT_TIMEOUT_MS = 5000

function parseBoolean(value) {
  return value === true || value === 'true' || value === '1'
}

function parseTimeout(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

function parseSampleRate(value, fallback = 0.01) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback
}

function trimTrailingSlash(value) {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : ''
}

function getRuntimeConfig() {
  const langfuseConfig = config.langfuse || {}
  return {
    enabled: parseBoolean(langfuseConfig.enabled ?? process.env.LANGFUSE_ENABLED),
    requestTracesEnabled: parseBoolean(
      langfuseConfig.requestTracesEnabled ?? process.env.LANGFUSE_REQUEST_TRACES_ENABLED ?? true
    ),
    quotaCyclesEnabled: parseBoolean(
      langfuseConfig.quotaCyclesEnabled ?? process.env.LANGFUSE_QUOTA_CYCLES_ENABLED ?? true
    ),
    requestPayloadsEnabled: parseBoolean(
      langfuseConfig.requestPayloadsEnabled ??
        process.env.LANGFUSE_REQUEST_PAYLOADS_ENABLED ??
        false
    ),
    successSampleRate: parseSampleRate(
      langfuseConfig.successSampleRate ?? process.env.LANGFUSE_SUCCESS_SAMPLE_RATE
    ),
    captureSlowRequests: parseBoolean(
      langfuseConfig.captureSlowRequests ?? process.env.LANGFUSE_CAPTURE_SLOW_REQUESTS ?? true
    ),
    slowRequestThresholdMs: parseTimeout(
      langfuseConfig.slowRequestThresholdMs ||
        process.env.LANGFUSE_SLOW_REQUEST_THRESHOLD_MS ||
        30000
    ),
    baseUrl: trimTrailingSlash(langfuseConfig.baseUrl || process.env.LANGFUSE_BASE_URL),
    publicKey: langfuseConfig.publicKey || process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: langfuseConfig.secretKey || process.env.LANGFUSE_SECRET_KEY,
    timeoutMs: parseTimeout(langfuseConfig.timeoutMs || process.env.LANGFUSE_TIMEOUT_MS),
    environment: langfuseConfig.environment || process.env.LANGFUSE_ENVIRONMENT || 'default'
  }
}

function isConfigured(runtimeConfig = {}) {
  return Boolean(
    runtimeConfig.enabled &&
      runtimeConfig.baseUrl &&
      runtimeConfig.publicKey &&
      runtimeConfig.secretKey
  )
}

function toIsoString(value, fallback = null) {
  if (!value) {
    return fallback
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

function cleanObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }

  const result = {}
  for (const [key, childValue] of Object.entries(value)) {
    if (childValue !== undefined) {
      result[key] = childValue
    }
  }
  return result
}

function safeJsonValue(value) {
  if (value === undefined) {
    return undefined
  }

  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    return {
      serializationError: error.message,
      value: String(value)
    }
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function buildUserId(detail = {}) {
  const parsedMetadataUser = metadataUserIdHelper.parse(detail.metadataUserId)
  const apiKeyName = firstNonEmpty(detail.apiKeyName, detail.apiKeyId)

  return firstNonEmpty(apiKeyName, parsedMetadataUser?.deviceId, detail.metadataUserId)
}

function buildUsage(detail = {}) {
  const input = Number(detail.inputTokens) || 0
  const output = Number(detail.outputTokens) || 0
  const cacheRead = Number(detail.cacheReadTokens) || 0
  const cacheCreate = Number(detail.cacheCreateTokens) || 0
  const total = Number(detail.totalTokens) || input + output + cacheRead + cacheCreate

  return cleanObject({
    input,
    output,
    total,
    unit: 'TOKENS',
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreateTokens: cacheCreate
  })
}

function toFiniteNumber(value) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : 0
}

function buildUsageDetails(detail = {}) {
  const input = toFiniteNumber(detail.inputTokens)
  const output = toFiniteNumber(detail.outputTokens)
  const cacheRead = toFiniteNumber(detail.cacheReadTokens)
  const cacheCreate = toFiniteNumber(detail.cacheCreateTokens)
  const total = toFiniteNumber(detail.totalTokens) || input + output + cacheRead + cacheCreate

  return cleanObject({
    input,
    output,
    cache_read_input: cacheRead,
    cache_creation_input: cacheCreate,
    total
  })
}

function addPositiveNumber(target, key, value) {
  const numberValue = toFiniteNumber(value)
  if (numberValue > 0) {
    target[key] = numberValue
  }
}

function buildCostDetails(detail = {}) {
  const source = detail.realCostBreakdown || detail.costBreakdown || {}
  const costDetails = {}

  addPositiveNumber(costDetails, 'input', source.input)
  addPositiveNumber(costDetails, 'output', source.output)
  addPositiveNumber(costDetails, 'cache_read_input', source.cacheRead)
  addPositiveNumber(costDetails, 'cache_creation_input', source.cacheCreate ?? source.cacheWrite)
  addPositiveNumber(costDetails, 'ephemeral_5m_input', source.ephemeral5m)
  addPositiveNumber(costDetails, 'ephemeral_1h_input', source.ephemeral1h)
  addPositiveNumber(costDetails, 'total', source.total ?? detail.realCost ?? detail.cost)

  return Object.keys(costDetails).length > 0 ? costDetails : undefined
}

function buildMetadata(detail = {}, runtimeConfig = {}) {
  const parsedMetadataUser = metadataUserIdHelper.parse(detail.metadataUserId)
  const payloadMetadata = runtimeConfig.requestPayloadsEnabled
    ? {
        responseHeaders: safeJsonValue(detail.responseHeaders),
        responseTextPreview: detail.responseTextPreview,
        responseBodySizeBytes: detail.responseBodySizeBytes,
        responseBodyTruncated: detail.responseBodyTruncated,
        errorBody: safeJsonValue(detail.errorBody),
        responseMetadata: safeJsonValue(detail.responseMetadata),
        metadata: safeJsonValue(detail.metadata)
      }
    : {}

  return cleanObject({
    source: 'claude-relay-service',
    environment: runtimeConfig.environment,
    requestId: detail.requestId,
    endpoint: detail.endpoint,
    method: detail.method,
    statusCode: detail.statusCode,
    stream: detail.stream,
    apiKeyId: detail.apiKeyId,
    apiKeyName: detail.apiKeyName,
    accountId: detail.accountId,
    accountName: detail.accountName,
    accountType: detail.accountType,
    accountTypeName: detail.accountTypeName,
    model: detail.model,
    sessionId: detail.sessionId,
    sessionHash: detail.sessionHash,
    conversationId: detail.conversationId,
    promptCacheKey: detail.promptCacheKey,
    metadataUserId: detail.metadataUserId,
    metadataDeviceId: parsedMetadataUser?.deviceId,
    metadataAccountUuid: parsedMetadataUser?.accountUuid,
    metadataSessionId: parsedMetadataUser?.sessionId,
    serviceTier: detail.serviceTier,
    clientIp: detail.clientIp,
    userAgent: detail.userAgent,
    requestSource: detail.requestSource,
    requestStartedAt: detail.requestStartedAt,
    firstByteAt: detail.firstByteAt,
    firstTokenAt: detail.firstTokenAt,
    responseCompletedAt: detail.responseCompletedAt,
    durationMs: detail.durationMs,
    timeToFirstByteMs: detail.timeToFirstByteMs,
    timeToFirstTokenMs: detail.timeToFirstTokenMs,
    contentGenerationMs: detail.contentGenerationMs,
    upstreamAttemptStartedAt: detail.upstreamAttemptStartedAt,
    upstreamFirstByteAt: detail.upstreamFirstByteAt,
    upstreamFirstTokenAt: detail.upstreamFirstTokenAt,
    upstreamResponseCompletedAt: detail.upstreamResponseCompletedAt,
    upstreamDurationMs: detail.upstreamDurationMs,
    upstreamTimeToFirstByteMs: detail.upstreamTimeToFirstByteMs,
    upstreamTimeToFirstTokenMs: detail.upstreamTimeToFirstTokenMs,
    upstreamAttemptCount: detail.upstreamAttemptCount,
    inputTokens: detail.inputTokens,
    outputTokens: detail.outputTokens,
    cacheReadTokens: detail.cacheReadTokens,
    cacheCreateTokens: detail.cacheCreateTokens,
    totalTokens: detail.totalTokens,
    cost: detail.cost,
    realCost: detail.realCost,
    costBreakdown: safeJsonValue(detail.costBreakdown),
    realCostBreakdown: safeJsonValue(detail.realCostBreakdown),
    pricingSource: detail.pricingSource,
    usedFallbackPricing: detail.usedFallbackPricing,
    costRecomputed: detail.costRecomputed,
    upstreamResponseId: detail.upstreamResponseId,
    finishReason: detail.finishReason,
    ...payloadMetadata
  })
}

function buildScopedTag(scope, value) {
  const text = firstNonEmpty(value)
  return text ? `${scope}:${text}` : null
}

function buildTags(detail = {}, runtimeConfig = {}) {
  return [
    'crs',
    runtimeConfig.environment,
    detail.accountType,
    buildScopedTag('account', detail.accountName || detail.accountId),
    buildScopedTag('account_id', detail.accountId),
    detail.model,
    detail.endpoint,
    detail.stream === true ? 'stream' : 'non-stream',
    Number(detail.statusCode) >= 400 ? 'error' : 'success'
  ].filter(Boolean)
}

function buildTracePayload(detail = {}, runtimeConfig = {}) {
  const traceId = detail.requestId
  const timestamp = toIsoString(detail.timestamp, new Date().toISOString())
  const includePayloads = runtimeConfig.requestPayloadsEnabled === true
  const requestBody = includePayloads
    ? safeJsonValue(detail.requestBody ?? detail.requestBodySnapshot)
    : undefined
  const responseBody = includePayloads
    ? safeJsonValue(detail.responseBody ?? detail.responseBodySnapshot)
    : undefined
  const metadata = buildMetadata(detail, runtimeConfig)
  const sessionId = firstNonEmpty(detail.sessionId, detail.conversationId, detail.sessionHash)
  const userId = buildUserId(detail)
  const name = firstNonEmpty(detail.endpoint, detail.model, 'crs-request')
  const generationId = `${traceId}-generation`

  return {
    batch: [
      {
        id: `${traceId}-trace-create`,
        timestamp,
        type: 'trace-create',
        body: cleanObject({
          id: traceId,
          name,
          userId,
          sessionId,
          metadata,
          tags: buildTags(detail, runtimeConfig)
        })
      },
      {
        id: `${traceId}-generation-create`,
        timestamp,
        type: 'generation-create',
        body: cleanObject({
          id: generationId,
          traceId,
          name,
          startTime: toIsoString(detail.requestStartedAt, timestamp),
          endTime: toIsoString(detail.responseCompletedAt),
          model: detail.model,
          input: includePayloads ? requestBody : undefined,
          output: includePayloads ? responseBody : undefined,
          usage: buildUsage(detail),
          usageDetails: buildUsageDetails(detail),
          costDetails: buildCostDetails(detail)
        })
      }
    ]
  }
}

function deterministicSample(requestId, sampleRate) {
  if (sampleRate <= 0) {
    return false
  }
  if (sampleRate >= 1) {
    return true
  }
  const sample = crypto
    .createHash('sha256')
    .update(String(requestId || ''))
    .digest()
    .readUInt32BE(0)
  return sample / 0x100000000 < sampleRate
}

function getRequestCaptureDecision(detail = {}, runtimeConfig = getRuntimeConfig()) {
  if (!isConfigured(runtimeConfig) || !runtimeConfig.requestTracesEnabled || !detail.requestId) {
    return { capture: false, reason: 'disabled' }
  }
  if (Number(detail.statusCode) >= 400 || detail.error || detail.errorBody) {
    return { capture: true, reason: 'error' }
  }
  if (
    runtimeConfig.captureSlowRequests &&
    toFiniteNumber(detail.durationMs) >= runtimeConfig.slowRequestThresholdMs
  ) {
    return { capture: true, reason: 'slow' }
  }
  if (deterministicSample(detail.requestId, runtimeConfig.successSampleRate)) {
    return { capture: true, reason: 'sampled' }
  }
  return { capture: false, reason: 'sampled_out' }
}

function buildDeterministicId(prefix, ...parts) {
  const digest = crypto
    .createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u0000'))
    .digest('hex')
    .slice(0, 32)

  return `${prefix}-${digest}`
}

function buildQuotaCycleTraceId(cycleId) {
  return buildDeterministicId('quota-cycle', cycleId)
}

function buildQuotaCycleGenerationId(cycleId, model) {
  return buildDeterministicId('quota-model', cycleId, model)
}

function firstDefinedNumber(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return toFiniteNumber(value)
    }
  }
  return 0
}

function normalizeQuotaCycleModelEntry(entry = {}, fallbackModel = null) {
  const source = entry && typeof entry === 'object' ? entry : {}
  const model = firstNonEmpty(source.model, source.modelName, source.name, fallbackModel, 'unknown')
  const inputTokens = firstDefinedNumber(source.inputTokens, source.input, source.input_tokens)
  const outputTokens = firstDefinedNumber(source.outputTokens, source.output, source.output_tokens)
  const cacheReadTokens = firstDefinedNumber(
    source.cacheReadTokens,
    source.cacheRead,
    source.cache_read_input,
    source.cache_read_tokens
  )
  const cacheCreateTokens = firstDefinedNumber(
    source.cacheCreateTokens,
    source.cacheCreate,
    source.cacheWriteTokens,
    source.cacheWrite,
    source.cache_creation_input,
    source.cache_create_tokens
  )
  const totalTokens =
    firstDefinedNumber(source.totalTokens, source.total, source.total_tokens) ||
    inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens
  const costSource = source.realCostBreakdown || source.costBreakdown || {}
  const cost = firstDefinedNumber(source.realCost, source.cost, source.totalCost, costSource.total)

  return {
    model,
    requests: firstDefinedNumber(
      source.requests,
      source.requestCount,
      source.callCount,
      source.calls
    ),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    totalTokens,
    cost,
    costBreakdown: {
      input: firstDefinedNumber(costSource.input),
      output: firstDefinedNumber(costSource.output),
      cacheRead: firstDefinedNumber(costSource.cacheRead, costSource.cache_read_input),
      cacheCreate: firstDefinedNumber(
        costSource.cacheCreate,
        costSource.cacheWrite,
        costSource.cache_creation_input
      ),
      total: cost
    }
  }
}

function toQuotaCycleModelEntries(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeQuotaCycleModelEntry(entry))
  }

  if (value instanceof Map) {
    return Array.from(value.entries()).map(([model, entry]) =>
      normalizeQuotaCycleModelEntry(entry, model)
    )
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).map(([model, entry]) =>
      normalizeQuotaCycleModelEntry(entry, model)
    )
  }

  return []
}

function addQuotaCycleModelTotals(target, source) {
  target.requests += source.requests
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheCreateTokens += source.cacheCreateTokens
  target.totalTokens += source.totalTokens
  target.cost += source.cost
  target.costBreakdown.input += source.costBreakdown.input
  target.costBreakdown.output += source.costBreakdown.output
  target.costBreakdown.cacheRead += source.costBreakdown.cacheRead
  target.costBreakdown.cacheCreate += source.costBreakdown.cacheCreate
  target.costBreakdown.total += source.costBreakdown.total
}

function normalizeQuotaCycleModels(summary = {}) {
  const candidates = [summary.models, summary.usageSummary?.models, summary.usageSummary?.byModel]
  let entries = []

  for (const candidate of candidates) {
    entries = toQuotaCycleModelEntries(candidate)
    if (entries.length > 0) {
      break
    }
  }

  const models = new Map()
  for (const entry of entries) {
    if (!models.has(entry.model)) {
      models.set(
        entry.model,
        normalizeQuotaCycleModelEntry({
          model: entry.model
        })
      )
    }
    addQuotaCycleModelTotals(models.get(entry.model), entry)
  }

  return Array.from(models.values()).sort((left, right) => left.model.localeCompare(right.model))
}

function buildQuotaCycleUsageDetails(modelUsage = {}) {
  const input = toFiniteNumber(modelUsage.inputTokens)
  const output = toFiniteNumber(modelUsage.outputTokens)
  const cacheRead = toFiniteNumber(modelUsage.cacheReadTokens)
  const cacheCreate = toFiniteNumber(modelUsage.cacheCreateTokens)
  const cache = cacheRead + cacheCreate
  const total = toFiniteNumber(modelUsage.totalTokens) || input + output + cache

  return {
    input,
    output,
    cache,
    cache_read_input: cacheRead,
    cache_creation_input: cacheCreate,
    total,
    requests: toFiniteNumber(modelUsage.requests)
  }
}

function buildQuotaCycleTotals(summary = {}, models = []) {
  const calculated = normalizeQuotaCycleModelEntry({
    model: 'all'
  })
  for (const model of models) {
    addQuotaCycleModelTotals(calculated, model)
  }

  const provided = summary.usageSummary?.totals || summary.usageSummary || summary.totals
  if (!provided || typeof provided !== 'object') {
    return calculated
  }

  const normalizedProvided = normalizeQuotaCycleModelEntry(provided, 'all')
  return {
    ...calculated,
    requests: normalizedProvided.requests || calculated.requests,
    inputTokens: normalizedProvided.inputTokens || calculated.inputTokens,
    outputTokens: normalizedProvided.outputTokens || calculated.outputTokens,
    cacheReadTokens: normalizedProvided.cacheReadTokens || calculated.cacheReadTokens,
    cacheCreateTokens: normalizedProvided.cacheCreateTokens || calculated.cacheCreateTokens,
    totalTokens: normalizedProvided.totalTokens || calculated.totalTokens,
    cost: normalizedProvided.cost || calculated.cost
  }
}

function buildQuotaCycleProviderSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return undefined
  }

  const normalized = cleanObject({
    windowType: snapshot.windowType,
    label: snapshot.label,
    percentage: snapshot.percentage,
    total: snapshot.total,
    used: snapshot.used,
    remaining: snapshot.remaining,
    resetAt: toIsoString(snapshot.resetAt),
    unit: snapshot.unit,
    number: snapshot.number,
    exhausted: snapshot.exhausted,
    accountDiscoveryIncomplete: snapshot.accountDiscoveryIncomplete
  })

  if (Array.isArray(snapshot.buckets)) {
    normalized.buckets = snapshot.buckets
      .map((bucket) => buildQuotaCycleProviderSnapshot(bucket))
      .filter(Boolean)
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function buildQuotaCycleAccountRefs(accountRefs) {
  if (!Array.isArray(accountRefs)) {
    return undefined
  }

  return accountRefs.map((account) =>
    cleanObject({
      accountId: account?.accountId || account?.id,
      accountName: account?.accountName || account?.name,
      accountType: account?.accountType || account?.type
    })
  )
}

function buildQuotaCycleMetadata(summary = {}, runtimeConfig = {}, models = []) {
  const cycleId = firstNonEmpty(summary.cycleId, summary.id)
  const provider = firstNonEmpty(summary.provider, 'unknown')
  const windowType = firstNonEmpty(summary.windowType, summary.window_type, 'unknown')
  const completeness = firstNonEmpty(
    summary.completeness,
    summary.isPartial === true ? 'partial' : 'complete'
  )
  const totals = buildQuotaCycleTotals(summary, models)

  return cleanObject({
    source: 'claude-relay-service',
    eventType: 'quota-cycle-summary',
    environment: runtimeConfig.environment,
    cycleId,
    quotaGroupId: summary.quotaGroupId,
    provider,
    windowType,
    completeness,
    status: summary.status,
    boundarySource: summary.boundarySource,
    windowStartAt: toIsoString(summary.windowStartAt),
    firstExceededAt: toIsoString(summary.firstExceededAt),
    lastExceededAt: toIsoString(summary.lastExceededAt),
    resetAt: toIsoString(summary.resetAt),
    recoveredAt: toIsoString(summary.recoveredAt),
    requests: totals.requests,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheCreateTokens: totals.cacheCreateTokens,
    totalTokens: totals.totalTokens,
    cost: totals.cost,
    usageSource: summary.usageSummary?.source,
    usageSemantics: summary.usageSummary?.semantics,
    observedFromAt: toIsoString(summary.usageSummary?.observedFromAt),
    observedThroughAt: toIsoString(summary.usageSummary?.observedThroughAt),
    accountRefs: buildQuotaCycleAccountRefs(summary.accountRefs || summary.accounts),
    providerSnapshot: buildQuotaCycleProviderSnapshot(
      summary.providerSnapshot || summary.quotaSnapshot
    )
  })
}

function buildQuotaCycleTags(summary = {}, runtimeConfig = {}) {
  const cycleId = firstNonEmpty(summary.cycleId, summary.id)
  const provider = firstNonEmpty(summary.provider, 'unknown')
  const windowType = firstNonEmpty(summary.windowType, summary.window_type, 'unknown')
  const completeness = firstNonEmpty(
    summary.completeness,
    summary.isPartial === true ? 'partial' : 'complete'
  )

  return [
    'crs',
    'quota-cycle',
    'quota-cycle-summary',
    runtimeConfig.environment,
    buildScopedTag('cycle', cycleId),
    buildScopedTag('provider', provider),
    buildScopedTag('quota-window', windowType),
    buildScopedTag('quota-completeness', completeness)
  ].filter(Boolean)
}

function buildQuotaCycleSummaryPayload(summary = {}, runtimeConfig = {}) {
  const cycleId = firstNonEmpty(summary.cycleId, summary.id)
  if (!cycleId) {
    throw new Error('cycleId is required for Langfuse quota cycle summaries')
  }

  const traceId = buildQuotaCycleTraceId(cycleId)
  const models = normalizeQuotaCycleModels(summary)
  const timestamp = toIsoString(
    summary.firstExceededAt || summary.timestamp,
    new Date().toISOString()
  )
  const startTime = toIsoString(summary.windowStartAt, timestamp)
  const endTime = toIsoString(summary.firstExceededAt, timestamp)
  const metadata = buildQuotaCycleMetadata(summary, runtimeConfig, models)
  const tags = buildQuotaCycleTags(summary, runtimeConfig)
  const traceEvent = {
    id: `${traceId}-trace-create`,
    timestamp,
    type: 'trace-create',
    body: cleanObject({
      id: traceId,
      name: 'quota-cycle-summary',
      sessionId: summary.quotaGroupId,
      metadata,
      tags
    })
  }
  const generationEvents = models.map((modelUsage) => {
    const generationId = buildQuotaCycleGenerationId(cycleId, modelUsage.model)

    return {
      id: `${generationId}-generation-create`,
      timestamp,
      type: 'generation-create',
      body: cleanObject({
        id: generationId,
        traceId,
        name: 'quota-cycle-model-usage',
        startTime,
        endTime,
        model: modelUsage.model,
        usage: buildUsage(modelUsage),
        usageDetails: buildQuotaCycleUsageDetails(modelUsage),
        costDetails: buildCostDetails(modelUsage),
        metadata: {
          ...metadata,
          model: modelUsage.model,
          requests: modelUsage.requests,
          inputTokens: modelUsage.inputTokens,
          outputTokens: modelUsage.outputTokens,
          cacheReadTokens: modelUsage.cacheReadTokens,
          cacheCreateTokens: modelUsage.cacheCreateTokens,
          totalTokens: modelUsage.totalTokens,
          cost: modelUsage.cost
        }
      })
    }
  })

  return {
    traceId,
    payload: {
      batch: [traceEvent, ...generationEvents]
    }
  }
}

class LangfuseTraceService {
  isEnabled() {
    return isConfigured(getRuntimeConfig())
  }

  isRequestTraceEnabled() {
    const runtimeConfig = getRuntimeConfig()
    return isConfigured(runtimeConfig) && runtimeConfig.requestTracesEnabled
  }

  isQuotaCycleEnabled() {
    const runtimeConfig = getRuntimeConfig()
    return isConfigured(runtimeConfig) && runtimeConfig.quotaCyclesEnabled
  }

  shouldCaptureRequest(detail = {}) {
    return getRequestCaptureDecision(detail).capture
  }

  async captureRequestDetail(detail = {}) {
    const runtimeConfig = getRuntimeConfig()
    const decision = getRequestCaptureDecision(detail, runtimeConfig)
    if (!decision.capture) {
      return { captured: false, reason: decision.reason }
    }

    const payload = buildTracePayload(detail, runtimeConfig)
    const response = await axios.post(`${runtimeConfig.baseUrl}/api/public/ingestion`, payload, {
      auth: {
        username: runtimeConfig.publicKey,
        password: runtimeConfig.secretKey
      },
      timeout: runtimeConfig.timeoutMs,
      headers: {
        'Content-Type': 'application/json'
      }
    })

    const errors = Array.isArray(response.data?.errors) ? response.data.errors : []
    if (errors.length > 0) {
      logger.warn(
        `⚠️ Langfuse ingestion returned ${errors.length} error(s) for request ${detail.requestId}`
      )
      return { captured: false, reason: 'langfuse_errors', requestId: detail.requestId }
    }

    return { captured: true, requestId: detail.requestId }
  }

  async captureQuotaCycleSummary(summary = {}) {
    const runtimeConfig = getRuntimeConfig()
    const cycleId = firstNonEmpty(summary.cycleId, summary.id)
    const traceId = cycleId ? buildQuotaCycleTraceId(cycleId) : undefined

    if (!isConfigured(runtimeConfig) || !runtimeConfig.quotaCyclesEnabled) {
      return { captured: false, reason: 'disabled', cycleId, traceId }
    }

    if (!cycleId) {
      return { captured: false, reason: 'missing_cycle_id' }
    }

    const built = buildQuotaCycleSummaryPayload(summary, runtimeConfig)
    const response = await axios.post(
      `${runtimeConfig.baseUrl}/api/public/ingestion`,
      built.payload,
      {
        auth: {
          username: runtimeConfig.publicKey,
          password: runtimeConfig.secretKey
        },
        timeout: runtimeConfig.timeoutMs,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    )

    const errors = Array.isArray(response.data?.errors) ? response.data.errors : []
    if (errors.length > 0) {
      logger.warn(
        `⚠️ Langfuse ingestion returned ${errors.length} error(s) for quota cycle ${cycleId}`
      )
      return {
        captured: false,
        reason: 'langfuse_errors',
        cycleId,
        traceId: built.traceId
      }
    }

    return { captured: true, cycleId, traceId: built.traceId }
  }
}

module.exports = new LangfuseTraceService()
module.exports._private = {
  buildTracePayload,
  buildUsageDetails,
  buildCostDetails,
  buildQuotaCycleSummaryPayload,
  buildQuotaCycleTraceId,
  buildQuotaCycleGenerationId,
  normalizeQuotaCycleModels,
  getRuntimeConfig,
  deterministicSample,
  getRequestCaptureDecision
}
