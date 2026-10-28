const { AsyncLocalStorage } = require('async_hooks')
const { randomUUID } = require('crypto')
const redis = require('../models/redis')
const logger = require('../utils/logger')

// One versioned document makes membership, group deletion and account policies atomic.
// Never cache authorization across requests or upstream attempts.
const CONFIG_KEY = 'account_access:configuration'
const AUDIT_KEY = 'account_access:audit'
const requestIdentity = new AsyncLocalStorage()
const TYPES = [
  'claude',
  'claude-console',
  'ccr',
  'bedrock',
  'gemini',
  'gemini-api',
  'openai',
  'openai-responses',
  'azure-openai',
  'droid'
]
const emptyState = () => ({ version: 1, revision: 0, groups: [], memberships: {}, policies: {} })

function accessError(message, statusCode = 403, code = 'ACCOUNT_ACCESS_DENIED') {
  return Object.assign(new Error(message), { statusCode, status: statusCode, code })
}

function accountRef(type, id) {
  const normalized = type === 'claude-official' ? 'claude' : type
  if (!TYPES.includes(normalized) || typeof id !== 'string' || !id || id.includes(':')) {
    throw accessError('Invalid account identity', 400, 'INVALID_ACCOUNT_IDENTITY')
  }
  return `${normalized}:${id}`
}

function validateState(state) {
  const invalid = () => {
    throw accessError('Invalid account access configuration', 400, 'INVALID_ACCESS_POLICY')
  }
  if (
    !state ||
    state.version !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Array.isArray(state.groups) ||
    !state.memberships ||
    !state.policies ||
    typeof state.memberships !== 'object' ||
    typeof state.policies !== 'object' ||
    Array.isArray(state.memberships) ||
    Array.isArray(state.policies)
  ) {
    invalid()
  }
  const ids = new Set()
  for (const group of state.groups) {
    if (
      !group ||
      typeof group.id !== 'string' ||
      !/^[\w-]{1,100}$/.test(group.id) ||
      ids.has(group.id) ||
      typeof group.name !== 'string' ||
      !group.name.trim() ||
      group.name.length > 100
    ) {
      invalid()
    }
    ids.add(group.id)
  }
  const validList = (list) =>
    Array.isArray(list) &&
    list.every((id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id)) &&
    new Set(list).size === list.length
  for (const [keyId, groups] of Object.entries(state.memberships)) {
    if (!/^[\w-]{1,100}$/.test(keyId) || !validList(groups) || groups.some((id) => !ids.has(id))) {
      invalid()
    }
  }
  for (const [ref, policy] of Object.entries(state.policies)) {
    const [type, id, extra] = ref.split(':')
    if (
      extra ||
      accountRef(type, id) !== ref ||
      !policy ||
      !['open', 'restricted'].includes(policy.mode) ||
      !validList(policy.keyIds) ||
      !validList(policy.groupIds) ||
      policy.groupIds.some((groupId) => !ids.has(groupId))
    ) {
      invalid()
    }
  }
  return state
}

async function readState() {
  try {
    const raw = await redis.getClientSafe().get(CONFIG_KEY)
    // Only an absent Redis key is a legacy/open configuration. Malformed data fails closed.
    return raw === null ? emptyState() : validateState(JSON.parse(raw))
  } catch (error) {
    logger.error('Account authorization configuration unavailable', { message: error.message })
    throw accessError(
      'Account authorization temporarily unavailable',
      503,
      'ACCOUNT_ACCESS_UNAVAILABLE'
    )
  }
}

function evaluator(state, keyId) {
  const memberships = new Set(state.memberships[keyId] || [])
  function explain(type, id) {
    const policy = state.policies[accountRef(type, id)]
    if (!policy || policy.mode === 'open') {
      return { allowed: true, reason: 'open', groupIds: [] }
    }
    const groupIds = policy.groupIds.filter((groupId) => memberships.has(groupId))
    const direct = !!keyId && policy.keyIds.includes(keyId)
    return {
      allowed: direct || groupIds.length > 0,
      reason: direct ? 'key' : groupIds.length ? 'group' : 'denied',
      groupIds,
      direct
    }
  }
  function canAccess(type, id) {
    return explain(type, id).allowed
  }
  function assert(type, id) {
    if (!canAccess(type, id)) {
      throw accessError('This API key is not authorized to access the account')
    }
  }
  function filter(accounts, type = null) {
    const allowed = accounts.filter((account) =>
      canAccess(type || account.accountType, account.accountId || account.id)
    )
    if (accounts.length && !allowed.length) {
      throw accessError('No authorized accounts for this request')
    }
    return allowed
  }
  return { explain, canAccess, assert, filter }
}

async function getEvaluator(keyId = requestIdentity.getStore()?.apiKeyId) {
  return evaluator(await readState(), keyId)
}

async function assertAllowed(type, id, keyId = requestIdentity.getStore()?.apiKeyId) {
  if (!keyId && requestIdentity.getStore()?.administrator) {
    return
  }
  const access = await getEvaluator(keyId)
  access.assert(type, id)
}

// Identity only, never permissions: async retries and queued work inherit the identity,
// while every dispatch re-reads the latest policy. Missing identity cannot use restricted accounts.
function runWithApiKey(apiKeyId, callback) {
  return requestIdentity.run({ apiKeyId }, callback)
}

function runAsAdministrator(callback) {
  return requestIdentity.run({ administrator: true }, callback)
}

function isAccessError(error) {
  return ['ACCOUNT_ACCESS_DENIED', 'ACCOUNT_ACCESS_UNAVAILABLE'].includes(error?.code)
}

function respondIfDenied(res, error) {
  if (!isAccessError(error)) {
    return false
  }
  if (!res.headersSent) {
    res
      .status(error.statusCode)
      .json({ error: { type: 'permission_error', code: error.code, message: error.message } })
  } else if (!res.writableEnded) {
    res.end()
  }
  return true
}

async function assertClientAccess(client) {
  if (requestIdentity.getStore()?.apiKeyId || client.relayAccountId) {
    await assertAllowed('gemini', client.relayAccountId)
  }
}

async function saveState(input, actor = 'admin') {
  const state = validateState(JSON.parse(JSON.stringify(input)))
  const current = await readState()
  if (state.revision !== current.revision) {
    throw accessError('Permissions changed; reload before saving', 409, 'ACCESS_POLICY_CONFLICT')
  }
  state.revision += 1
  const audit = JSON.stringify({
    id: randomUUID(),
    at: new Date().toISOString(),
    actor,
    revision: state.revision,
    before: current,
    after: state
  })
  const result = await redis.getClientSafe().eval(
    `
    local raw = redis.call('GET', KEYS[1])
    local revision = 0
    if raw then revision = cjson.decode(raw).revision end
    if revision ~= tonumber(ARGV[1]) then return 0 end
    redis.call('SET', KEYS[1], ARGV[2])
    redis.call('LPUSH', KEYS[2], ARGV[3])
    redis.call('LTRIM', KEYS[2], 0, 199)
    return 1
  `,
    2,
    CONFIG_KEY,
    AUDIT_KEY,
    current.revision,
    JSON.stringify(state),
    audit
  )
  if (result !== 1) {
    throw accessError('Permissions changed; reload before saving', 409, 'ACCESS_POLICY_CONFLICT')
  }
  logger.info('Account access permissions updated', { actor, revision: state.revision })
  return state
}

async function getCatalog() {
  const services = {
    claude: 'claudeAccountService',
    'claude-console': 'claudeConsoleAccountService',
    ccr: 'ccrAccountService',
    bedrock: 'bedrockAccountService',
    gemini: 'geminiAccountService',
    'gemini-api': 'geminiApiAccountService',
    openai: 'openaiAccountService',
    'openai-responses': 'openaiResponsesAccountService',
    'azure-openai': 'azureOpenaiAccountService',
    droid: 'droidAccountService'
  }
  const accounts = (
    await Promise.all(
      Object.entries(services).map(async ([type, module]) => {
        const result = await require(`./account/${module}`).getAllAccounts()
        const values = Array.isArray(result) ? result : result.data || []
        return values.map((account) => ({
          ref: accountRef(type, account.id),
          id: account.id,
          type,
          name: account.name || account.id,
          accountType: account.accountType || 'shared'
        }))
      })
    )
  ).flat()
  const keys = (await redis.getAllApiKeys())
    .filter((key) => key.id && key.name && key.isDeleted !== 'true')
    .map((key) => {
      let tags = []
      try {
        tags = Array.isArray(key.tags) ? key.tags : JSON.parse(key.tags || '[]')
      } catch {
        /* Classification is optional. */
      }
      return {
        id: key.id,
        name: key.name,
        tags: Array.isArray(tags) ? tags : [],
        isActive: key.isActive === true || key.isActive === 'true'
      }
    })
  return { accounts, keys }
}

async function getAudit() {
  return (await redis.getClientSafe().lrange(AUDIT_KEY, 0, 49)).map((raw) => JSON.parse(raw))
}

module.exports = {
  isAccessError,
  respondIfDenied,
  runAsAdministrator,
  assertClientAccess,
  getCatalog,
  getAudit,
  CONFIG_KEY,
  AUDIT_KEY,
  TYPES,
  accountRef,
  validateState,
  readState,
  evaluator,
  getEvaluator,
  assertAllowed,
  runWithApiKey,
  saveState
}
