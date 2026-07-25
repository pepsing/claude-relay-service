const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const config = require('../../config/config')
const redis = require('../models/redis')
const logger = require('../utils/logger')

const MANAGEMENT_KEY_PREFIX = 'crsm_'
const MANAGEMENT_SCOPES = [
  'api-keys:read',
  'api-keys:write',
  'api-keys:reveal',
  'accounts:read',
  'accounts:write',
  'accounts:test',
  'accounts:refresh',
  'stats:read'
]

const ACCOUNT_ROUTE_PREFIXES = [
  '/admin/claude-accounts',
  '/admin/claude-console-accounts',
  '/admin/gemini-accounts',
  '/admin/gemini-api-accounts',
  '/admin/openai-accounts',
  '/admin/azure-openai-accounts',
  '/admin/openai-responses-accounts',
  '/admin/droid-accounts',
  '/admin/bedrock-accounts',
  '/admin/ccr-accounts'
]

const STATS_PATH_PATTERNS = [
  /^\/admin\/dashboard$/,
  /^\/admin\/usage-stats$/,
  /^\/admin\/usage-costs$/,
  /^\/admin\/usage-trend$/,
  /^\/admin\/account-usage-trend$/,
  /^\/admin\/model-usage-trend$/,
  /^\/admin\/api-keys-usage-trend$/,
  /^\/admin\/accounts\/[^/]+\/usage-(stats|history|records)$/,
  /^\/admin\/api-keys\/[^/]+\/(stats|model-stats|usage-records)$/,
  /^\/admin\/request-details(?:\/.*)?$/,
  /^\/admin\/request-failures(?:\/.*)?$/
]

function parseBoolean(value) {
  return value === true || value === 'true'
}

function parseScopes(value) {
  if (Array.isArray(value)) {
    return value
  }
  if (!value) {
    return []
  }
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch (_error) {
    return []
  }
}

function normalizePath(value) {
  const rawPath = String(value || '/').split('?')[0]
  return rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
}

class ManagementApiKeyService {
  getSupportedScopes() {
    return [...MANAGEMENT_SCOPES]
  }

  normalizeScopes(scopes) {
    const requestedScopes = Array.isArray(scopes) ? scopes : MANAGEMENT_SCOPES
    const uniqueScopes = [...new Set(requestedScopes.map((scope) => String(scope).trim()))]
    const invalidScopes = uniqueScopes.filter((scope) => !MANAGEMENT_SCOPES.includes(scope))

    if (invalidScopes.length > 0) {
      throw new Error(`Unsupported management scopes: ${invalidScopes.join(', ')}`)
    }

    return uniqueScopes
  }

  resolveRequiredScope(method, originalUrl) {
    const path = normalizePath(originalUrl)
    const normalizedMethod = String(method || 'GET').toUpperCase()

    if (path.startsWith('/admin/management-api-keys')) {
      return null
    }

    if (STATS_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
      return normalizedMethod === 'GET' ? 'stats:read' : null
    }

    if (path === '/admin/api-keys' || path.startsWith('/admin/api-keys/')) {
      if (path.endsWith('/reveal-secret')) {
        return normalizedMethod === 'POST' ? 'api-keys:reveal' : null
      }
      return normalizedMethod === 'GET' ? 'api-keys:read' : 'api-keys:write'
    }

    if (ACCOUNT_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      if (normalizedMethod === 'GET') {
        return 'accounts:read'
      }
      if (/\/(test|health-check|health-check-all|test-sync)$/.test(path)) {
        return 'accounts:test'
      }
      if (/\/(refresh|refresh-token|reset-status|update-profile|update-all-profiles)$/.test(path)) {
        return 'accounts:refresh'
      }
      return 'accounts:write'
    }

    return null
  }

  async createKey(options = {}) {
    const {
      name,
      description = '',
      scopes = MANAGEMENT_SCOPES,
      expiresAt = '',
      createdBy = 'admin'
    } = options

    if (!name || !String(name).trim()) {
      throw new Error('Management API key name is required')
    }

    const normalizedScopes = this.normalizeScopes(scopes)
    const managementKey = `${MANAGEMENT_KEY_PREFIX}${crypto.randomBytes(32).toString('hex')}`
    const keyId = uuidv4()
    const keyHash = this.hashKey(managementKey)
    const now = new Date().toISOString()
    const keyData = {
      id: keyId,
      name: String(name).trim(),
      description: String(description || '').trim(),
      keyHash,
      keyPreview: this.buildPreview(managementKey),
      scopes: JSON.stringify(normalizedScopes),
      isActive: 'true',
      expiresAt: expiresAt || '',
      createdAt: now,
      createdBy,
      updatedAt: now,
      lastUsedAt: '',
      lastUsedIp: ''
    }

    await redis.setManagementApiKey(keyId, keyData, keyHash)
    logger.security(`Created management API key ${keyId} (${keyData.name}) by ${createdBy}`)

    return {
      ...this.sanitizeKeyData(keyData),
      managementKey
    }
  }

  async listKeys() {
    const keys = await redis.getAllManagementApiKeys()
    return keys
      .map((keyData) => this.sanitizeKeyData(keyData))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  async getKeyById(keyId) {
    const keyData = await redis.getManagementApiKey(keyId)
    if (!keyData || Object.keys(keyData).length === 0) {
      return null
    }
    return this.sanitizeKeyData({ id: keyId, ...keyData })
  }

  async updateKey(keyId, updates = {}, updatedBy = 'admin') {
    const keyData = await redis.getManagementApiKey(keyId)
    if (!keyData || Object.keys(keyData).length === 0) {
      throw new Error('Management API key not found')
    }

    const nextData = { ...keyData, id: keyId }
    if (updates.name !== undefined) {
      if (!String(updates.name).trim()) {
        throw new Error('Management API key name cannot be empty')
      }
      nextData.name = String(updates.name).trim()
    }
    if (updates.description !== undefined) {
      nextData.description = String(updates.description || '').trim()
    }
    if (updates.scopes !== undefined) {
      nextData.scopes = JSON.stringify(this.normalizeScopes(updates.scopes))
    }
    if (updates.isActive !== undefined) {
      nextData.isActive = String(Boolean(updates.isActive))
    }
    if (updates.expiresAt !== undefined) {
      nextData.expiresAt = updates.expiresAt || ''
    }

    nextData.updatedAt = new Date().toISOString()
    nextData.updatedBy = updatedBy
    await redis.setManagementApiKey(keyId, nextData, keyData.keyHash)
    logger.security(`Updated management API key ${keyId} (${nextData.name}) by ${updatedBy}`)
    return this.sanitizeKeyData(nextData)
  }

  async rotateKey(keyId, rotatedBy = 'admin') {
    const keyData = await redis.getManagementApiKey(keyId)
    if (!keyData || Object.keys(keyData).length === 0) {
      throw new Error('Management API key not found')
    }

    const managementKey = `${MANAGEMENT_KEY_PREFIX}${crypto.randomBytes(32).toString('hex')}`
    const keyHash = this.hashKey(managementKey)
    const nextData = {
      ...keyData,
      id: keyId,
      keyHash,
      keyPreview: this.buildPreview(managementKey),
      updatedAt: new Date().toISOString(),
      updatedBy: rotatedBy,
      lastUsedAt: '',
      lastUsedIp: ''
    }

    await redis.setManagementApiKey(keyId, nextData, keyHash, keyData.keyHash)
    logger.security(`Rotated management API key ${keyId} (${nextData.name}) by ${rotatedBy}`)

    return {
      ...this.sanitizeKeyData(nextData),
      managementKey
    }
  }

  async deleteKey(keyId, deletedBy = 'admin') {
    const keyData = await redis.getManagementApiKey(keyId)
    if (!keyData || Object.keys(keyData).length === 0) {
      throw new Error('Management API key not found')
    }

    await redis.deleteManagementApiKey(keyId)
    logger.security(`Deleted management API key ${keyId} (${keyData.name}) by ${deletedBy}`)
  }

  async validateKey(managementKey, requiredScope, context = {}) {
    if (
      typeof managementKey !== 'string' ||
      !new RegExp(`^${MANAGEMENT_KEY_PREFIX}[a-f0-9]{64}$`).test(managementKey)
    ) {
      return { valid: false, status: 401, error: 'Invalid management API key format' }
    }

    const keyHash = this.hashKey(managementKey)
    const keyData = await redis.findManagementApiKeyByHash(keyHash)
    if (!keyData || keyData.keyHash !== keyHash) {
      return { valid: false, status: 401, error: 'Invalid management API key' }
    }
    if (!parseBoolean(keyData.isActive)) {
      return { valid: false, status: 401, error: 'Management API key is disabled' }
    }
    if (keyData.expiresAt && new Date(keyData.expiresAt).getTime() <= Date.now()) {
      return { valid: false, status: 401, error: 'Management API key has expired' }
    }

    const scopes = parseScopes(keyData.scopes)
    if (!requiredScope || !scopes.includes(requiredScope)) {
      return {
        valid: false,
        status: 403,
        error: requiredScope
          ? `Management API key lacks required scope: ${requiredScope}`
          : 'Management API key is not permitted for this endpoint'
      }
    }

    const lastUsedAt = new Date().toISOString()
    await redis.touchManagementApiKey(keyData.id, lastUsedAt, context.ip || '')

    return {
      valid: true,
      keyData: {
        ...this.sanitizeKeyData(keyData),
        lastUsedAt,
        lastUsedIp: context.ip || '',
        scopes
      }
    }
  }

  hashKey(managementKey) {
    return crypto
      .createHmac('sha256', config.security.encryptionKey)
      .update(managementKey)
      .digest('hex')
  }

  buildPreview(managementKey) {
    return `${managementKey.slice(0, 10)}...${managementKey.slice(-6)}`
  }

  sanitizeKeyData(keyData) {
    return {
      id: keyData.id,
      name: keyData.name || '',
      description: keyData.description || '',
      keyPreview: keyData.keyPreview || '',
      scopes: parseScopes(keyData.scopes),
      isActive: parseBoolean(keyData.isActive),
      expiresAt: keyData.expiresAt || '',
      createdAt: keyData.createdAt || '',
      createdBy: keyData.createdBy || '',
      updatedAt: keyData.updatedAt || '',
      updatedBy: keyData.updatedBy || '',
      lastUsedAt: keyData.lastUsedAt || '',
      lastUsedIp: keyData.lastUsedIp || ''
    }
  }
}

const managementApiKeyService = new ManagementApiKeyService()

module.exports = managementApiKeyService
module.exports.ManagementApiKeyService = ManagementApiKeyService
module.exports.MANAGEMENT_KEY_PREFIX = MANAGEMENT_KEY_PREFIX
module.exports.MANAGEMENT_SCOPES = MANAGEMENT_SCOPES
