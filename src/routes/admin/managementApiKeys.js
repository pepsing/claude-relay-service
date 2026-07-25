const express = require('express')
const { authenticateAdminSession } = require('../../middleware/auth')
const managementApiKeyService = require('../../services/managementApiKeyService')
const logger = require('../../utils/logger')

const router = express.Router()

function validateExpiresAt(expiresAt) {
  if (!expiresAt) {
    return null
  }
  const timestamp = new Date(expiresAt).getTime()
  if (!Number.isFinite(timestamp)) {
    return 'expiresAt must be a valid ISO 8601 date'
  }
  if (timestamp <= Date.now()) {
    return 'expiresAt must be in the future'
  }
  return null
}

router.get('/management-api-keys/scopes', authenticateAdminSession, (_req, res) =>
  res.json({
    success: true,
    data: managementApiKeyService.getSupportedScopes()
  })
)

router.get('/management-api-keys', authenticateAdminSession, async (_req, res) => {
  try {
    const keys = await managementApiKeyService.listKeys()
    return res.json({ success: true, data: keys })
  } catch (error) {
    logger.error('Failed to list management API keys:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to list management API keys',
      message: error.message
    })
  }
})

router.post('/management-api-keys', authenticateAdminSession, async (req, res) => {
  try {
    const { name, description, scopes, expiresAt } = req.body
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' })
    }
    if (name.trim().length > 100) {
      return res
        .status(400)
        .json({ success: false, message: 'Name must be 100 characters or less' })
    }
    if (description && (typeof description !== 'string' || description.length > 500)) {
      return res.status(400).json({
        success: false,
        message: 'Description must be 500 characters or less'
      })
    }
    if (scopes !== undefined && !Array.isArray(scopes)) {
      return res.status(400).json({ success: false, message: 'Scopes must be an array' })
    }
    const expiresAtError = validateExpiresAt(expiresAt)
    if (expiresAtError) {
      return res.status(400).json({ success: false, message: expiresAtError })
    }

    const key = await managementApiKeyService.createKey({
      name,
      description,
      scopes,
      expiresAt,
      createdBy: req.admin.username
    })
    res.set('Cache-Control', 'no-store')
    return res.status(201).json({ success: true, data: key })
  } catch (error) {
    logger.error('Failed to create management API key:', error)
    return res.status(400).json({
      success: false,
      error: 'Failed to create management API key',
      message: error.message
    })
  }
})

router.put('/management-api-keys/:keyId', authenticateAdminSession, async (req, res) => {
  try {
    const { name, description, scopes, isActive, expiresAt } = req.body
    if (name !== undefined && (!String(name).trim() || String(name).trim().length > 100)) {
      return res.status(400).json({
        success: false,
        message: 'Name must be between 1 and 100 characters'
      })
    }
    if (description !== undefined && String(description).length > 500) {
      return res.status(400).json({
        success: false,
        message: 'Description must be 500 characters or less'
      })
    }
    if (scopes !== undefined && !Array.isArray(scopes)) {
      return res.status(400).json({ success: false, message: 'Scopes must be an array' })
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isActive must be a boolean' })
    }
    const expiresAtError = validateExpiresAt(expiresAt)
    if (expiresAt !== undefined && expiresAt && expiresAtError) {
      return res.status(400).json({ success: false, message: expiresAtError })
    }

    const key = await managementApiKeyService.updateKey(
      req.params.keyId,
      { name, description, scopes, isActive, expiresAt },
      req.admin.username
    )
    return res.json({ success: true, data: key })
  } catch (error) {
    const status = error.message === 'Management API key not found' ? 404 : 400
    return res.status(status).json({ success: false, message: error.message })
  }
})

router.post('/management-api-keys/:keyId/rotate', authenticateAdminSession, async (req, res) => {
  try {
    const key = await managementApiKeyService.rotateKey(req.params.keyId, req.admin.username)
    res.set('Cache-Control', 'no-store')
    return res.json({ success: true, data: key })
  } catch (error) {
    const status = error.message === 'Management API key not found' ? 404 : 400
    return res.status(status).json({ success: false, message: error.message })
  }
})

router.delete('/management-api-keys/:keyId', authenticateAdminSession, async (req, res) => {
  try {
    await managementApiKeyService.deleteKey(req.params.keyId, req.admin.username)
    return res.json({ success: true, message: 'Management API key deleted' })
  } catch (error) {
    const status = error.message === 'Management API key not found' ? 404 : 400
    return res.status(status).json({ success: false, message: error.message })
  }
})

module.exports = router
