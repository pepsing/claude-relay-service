const express = require('express')
const stickySessionGroupService = require('../../services/stickySessionGroupService')
const claudeConsoleAccountService = require('../../services/account/claudeConsoleAccountService')
const openaiResponsesAccountService = require('../../services/account/openaiResponsesAccountService')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')

const router = express.Router()
const SUPPORTED_PLATFORMS = ['claude-console', 'openai-responses']

async function getPlatformAccounts(platform) {
  if (platform === 'claude-console') {
    return claudeConsoleAccountService.getAllAccounts()
  }
  if (platform === 'openai-responses') {
    return openaiResponsesAccountService.getAllAccounts(true)
  }
  throw new Error('Unsupported sticky session group platform')
}

function toSafeAccount(account, platform) {
  return {
    id: account.id,
    name: account.name || account.id,
    platform,
    accountType: account.accountType || 'shared',
    isActive: account.isActive === true || account.isActive === 'true',
    status: account.status || 'unknown',
    stickySessionMode: account.stickySessionMode || 'inherit'
  }
}

async function validateMembers(platform, memberIds) {
  const accounts = await getPlatformAccounts(platform)
  const accountMap = new Map(accounts.map((account) => [account.id, account]))
  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(memberIds) ? memberIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    )
  )

  for (const accountId of normalizedIds) {
    const account = accountMap.get(accountId)
    if (!account) {
      throw new Error(`账户不存在或平台不匹配: ${accountId}`)
    }
    if (account.accountType && account.accountType !== 'shared') {
      throw new Error(`只有共享池账户可以加入粘滞分组: ${account.name || accountId}`)
    }
  }
  return normalizedIds
}

router.get('/accounts', authenticateAdmin, async (req, res) => {
  try {
    const platform = String(req.query.platform || '')
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: 'Invalid sticky session group platform' })
    }
    const accounts = await getPlatformAccounts(platform)
    return res.json({
      success: true,
      data: accounts
        .filter((account) => !account.accountType || account.accountType === 'shared')
        .map((account) => toSafeAccount(account, platform))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    })
  } catch (error) {
    logger.error('Failed to get sticky session group accounts:', error)
    return res.status(500).json({ error: error.message })
  }
})

router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const groups = await stickySessionGroupService.getAllGroups(req.query.platform || null)
    return res.json({ success: true, data: groups })
  } catch (error) {
    logger.error('Failed to get sticky session groups:', error)
    return res.status(400).json({ error: error.message })
  }
})

router.post('/', authenticateAdmin, async (req, res) => {
  let group = null
  try {
    const { name, platform, description, memberIds = [] } = req.body || {}
    const validatedMemberIds = await validateMembers(platform, memberIds)
    group = await stickySessionGroupService.createGroup({ name, platform, description })
    if (validatedMemberIds.length > 0) {
      group = await stickySessionGroupService.setGroupMembers(group.id, validatedMemberIds)
    }
    return res.json({ success: true, data: group })
  } catch (error) {
    if (group?.id) {
      await stickySessionGroupService.deleteGroup(group.id).catch(() => {})
    }
    logger.error('Failed to create sticky session group:', error)
    return res.status(400).json({ error: error.message })
  }
})

router.get('/:groupId', authenticateAdmin, async (req, res) => {
  try {
    const group = await stickySessionGroupService.getGroup(req.params.groupId)
    if (!group) {
      return res.status(404).json({ error: '粘滞分组不存在' })
    }
    return res.json({ success: true, data: group })
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
})

router.put('/:groupId', authenticateAdmin, async (req, res) => {
  try {
    const existing = await stickySessionGroupService.getGroup(req.params.groupId)
    if (!existing) {
      return res.status(404).json({ error: '粘滞分组不存在' })
    }

    let memberIds = null
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'memberIds')) {
      memberIds = await validateMembers(existing.platform, req.body.memberIds)
    }

    let group = await stickySessionGroupService.updateGroup(req.params.groupId, req.body || {})
    if (memberIds) {
      group = await stickySessionGroupService.setGroupMembers(req.params.groupId, memberIds)
    }
    return res.json({ success: true, data: group })
  } catch (error) {
    logger.error('Failed to update sticky session group:', error)
    return res.status(400).json({ error: error.message })
  }
})

router.put('/:groupId/members', authenticateAdmin, async (req, res) => {
  try {
    const group = await stickySessionGroupService.getGroup(req.params.groupId)
    if (!group) {
      return res.status(404).json({ error: '粘滞分组不存在' })
    }
    const memberIds = await validateMembers(group.platform, req.body?.memberIds)
    const updated = await stickySessionGroupService.setGroupMembers(group.id, memberIds)
    return res.json({ success: true, data: updated })
  } catch (error) {
    logger.error('Failed to update sticky session group members:', error)
    return res.status(400).json({ error: error.message })
  }
})

router.delete('/:groupId', authenticateAdmin, async (req, res) => {
  try {
    await stickySessionGroupService.deleteGroup(req.params.groupId)
    return res.json({ success: true, message: '粘滞分组删除成功' })
  } catch (error) {
    logger.error('Failed to delete sticky session group:', error)
    return res.status(400).json({ error: error.message })
  }
})

module.exports = router
