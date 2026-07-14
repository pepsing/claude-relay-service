const { v4: uuidv4 } = require('uuid')
const redis = require('../models/redis')
const logger = require('../utils/logger')

const SUPPORTED_PLATFORMS = ['claude-console', 'openai-responses']

class StickySessionGroupService {
  constructor() {
    this.GROUPS_KEY = 'sticky_session_groups'
    this.GROUP_PREFIX = 'sticky_session_group:'
    this.GROUP_MEMBERS_PREFIX = 'sticky_session_group_members:'
    this.ACCOUNT_GROUP_PREFIX = 'sticky_session_account_group:'
  }

  _normalizePlatform(platform) {
    return String(platform || '')
      .trim()
      .toLowerCase()
  }

  _accountGroupKey(platform, accountId) {
    return `${this.ACCOUNT_GROUP_PREFIX}${this._normalizePlatform(platform)}:${accountId}`
  }

  _validatePlatform(platform) {
    const normalized = this._normalizePlatform(platform)
    if (!SUPPORTED_PLATFORMS.includes(normalized)) {
      throw new Error('粘滞分组平台必须是 claude-console 或 openai-responses')
    }
    return normalized
  }

  async _assertUniqueName(name, platform, excludeId = null) {
    const normalizedName = String(name || '')
      .trim()
      .toLowerCase()
    const groups = await this.getAllGroups(platform)
    if (
      groups.some(
        (group) =>
          group.id !== excludeId &&
          String(group.name || '')
            .trim()
            .toLowerCase() === normalizedName
      )
    ) {
      throw new Error('同一平台下粘滞分组名称不能重复')
    }
  }

  async createGroup({ name, platform, description = '' }) {
    const normalizedName = String(name || '').trim()
    const normalizedPlatform = this._validatePlatform(platform)
    if (!normalizedName) {
      throw new Error('粘滞分组名称不能为空')
    }

    await this._assertUniqueName(normalizedName, normalizedPlatform)

    const client = redis.getClientSafe()
    const id = uuidv4()
    const now = new Date().toISOString()
    const group = {
      id,
      name: normalizedName,
      platform: normalizedPlatform,
      description: String(description || '').trim(),
      createdAt: now,
      updatedAt: now
    }

    await client.hmset(`${this.GROUP_PREFIX}${id}`, group)
    await client.sadd(this.GROUPS_KEY, id)
    logger.success(`创建粘滞分组成功: ${group.name} (${group.platform})`)
    return { ...group, memberIds: [], memberCount: 0 }
  }

  async getGroup(groupId) {
    if (!groupId) {
      return null
    }

    const client = redis.getClientSafe()
    const data = await client.hgetall(`${this.GROUP_PREFIX}${groupId}`)
    if (!data || Object.keys(data).length === 0) {
      return null
    }

    const memberIds = await client.smembers(`${this.GROUP_MEMBERS_PREFIX}${groupId}`)
    return {
      ...data,
      memberIds,
      memberCount: memberIds.length
    }
  }

  async getAllGroups(platform = null) {
    const normalizedPlatform = platform ? this._validatePlatform(platform) : null
    const client = redis.getClientSafe()
    const ids = await client.smembers(this.GROUPS_KEY)
    const groups = (await Promise.all(ids.map((id) => this.getGroup(id)))).filter(Boolean)

    return groups
      .filter((group) => !normalizedPlatform || group.platform === normalizedPlatform)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'))
  }

  async updateGroup(groupId, updates = {}) {
    const existing = await this.getGroup(groupId)
    if (!existing) {
      throw new Error('粘滞分组不存在')
    }
    if (updates.platform && this._normalizePlatform(updates.platform) !== existing.platform) {
      throw new Error('不能修改粘滞分组的平台')
    }

    const name = updates.name === undefined ? existing.name : String(updates.name || '').trim()
    if (!name) {
      throw new Error('粘滞分组名称不能为空')
    }
    await this._assertUniqueName(name, existing.platform, groupId)

    const updateData = {
      name,
      description:
        updates.description === undefined
          ? existing.description || ''
          : String(updates.description || '').trim(),
      updatedAt: new Date().toISOString()
    }

    const client = redis.getClientSafe()
    await client.hmset(`${this.GROUP_PREFIX}${groupId}`, updateData)
    logger.success(`更新粘滞分组成功: ${name}`)
    return this.getGroup(groupId)
  }

  async getGroupMembers(groupId) {
    const client = redis.getClientSafe()
    return client.smembers(`${this.GROUP_MEMBERS_PREFIX}${groupId}`)
  }

  async setGroupMembers(groupId, accountIds = []) {
    const group = await this.getGroup(groupId)
    if (!group) {
      throw new Error('粘滞分组不存在')
    }

    const normalizedIds = Array.from(
      new Set(
        (Array.isArray(accountIds) ? accountIds : [])
          .map((id) => String(id || '').trim())
          .filter(Boolean)
      )
    )
    const previousIds = group.memberIds || []
    const nextSet = new Set(normalizedIds)
    const client = redis.getClientSafe()

    for (const accountId of previousIds) {
      if (nextSet.has(accountId)) {
        continue
      }
      await client.srem(`${this.GROUP_MEMBERS_PREFIX}${groupId}`, accountId)
      const reverseKey = this._accountGroupKey(group.platform, accountId)
      if ((await client.get(reverseKey)) === groupId) {
        await client.del(reverseKey)
      }
    }

    for (const accountId of normalizedIds) {
      const reverseKey = this._accountGroupKey(group.platform, accountId)
      const previousGroupId = await client.get(reverseKey)
      if (previousGroupId && previousGroupId !== groupId) {
        await client.srem(`${this.GROUP_MEMBERS_PREFIX}${previousGroupId}`, accountId)
      }
      await client.sadd(`${this.GROUP_MEMBERS_PREFIX}${groupId}`, accountId)
      await client.set(reverseKey, groupId)
    }

    logger.success(`更新粘滞分组成员成功: ${group.name} (${normalizedIds.length})`)
    return this.getGroup(groupId)
  }

  async setAccountGroup(accountId, platform, groupId = null) {
    const normalizedPlatform = this._validatePlatform(platform)
    const reverseKey = this._accountGroupKey(normalizedPlatform, accountId)
    const client = redis.getClientSafe()
    const previousGroupId = await client.get(reverseKey)

    if (!groupId) {
      if (previousGroupId) {
        await client.srem(`${this.GROUP_MEMBERS_PREFIX}${previousGroupId}`, accountId)
      }
      await client.del(reverseKey)
      return null
    }

    const group = await this.getGroup(groupId)
    if (!group) {
      throw new Error('粘滞分组不存在')
    }
    if (group.platform !== normalizedPlatform) {
      throw new Error('账户平台与粘滞分组平台不匹配')
    }

    if (previousGroupId && previousGroupId !== groupId) {
      await client.srem(`${this.GROUP_MEMBERS_PREFIX}${previousGroupId}`, accountId)
    }
    await client.sadd(`${this.GROUP_MEMBERS_PREFIX}${groupId}`, accountId)
    await client.set(reverseKey, groupId)
    return group
  }

  async getGroupForAccount(accountId, platform) {
    if (!accountId || !SUPPORTED_PLATFORMS.includes(this._normalizePlatform(platform))) {
      return null
    }

    const normalizedPlatform = this._normalizePlatform(platform)
    const client = redis.getClientSafe()
    const reverseKey = this._accountGroupKey(normalizedPlatform, accountId)
    const groupId = await client.get(reverseKey)
    if (!groupId) {
      return null
    }

    const group = await this.getGroup(groupId)
    if (!group || group.platform !== normalizedPlatform) {
      await client.del(reverseKey)
      return null
    }
    return group
  }

  async batchGetGroupsForAccounts(accountIds = [], platform) {
    const normalizedPlatform = this._normalizePlatform(platform)
    if (!SUPPORTED_PLATFORMS.includes(normalizedPlatform)) {
      return new Map()
    }

    const entries = await Promise.all(
      accountIds.map(async (accountId) => [
        accountId,
        await this.getGroupForAccount(accountId, normalizedPlatform)
      ])
    )
    return new Map(entries)
  }

  async isAccountInGroup(accountId, groupId) {
    if (!accountId || !groupId) {
      return false
    }
    const client = redis.getClientSafe()
    return (await client.sismember(`${this.GROUP_MEMBERS_PREFIX}${groupId}`, accountId)) === 1
  }

  async filterAccountsByGroup(accounts = [], groupId) {
    if (!groupId) {
      return accounts
    }
    const memberIds = new Set(await this.getGroupMembers(groupId))
    return accounts.filter((account) => memberIds.has(account.accountId || account.id))
  }

  async removeAccount(accountId, platform) {
    return this.setAccountGroup(accountId, platform, null)
  }

  async deleteGroup(groupId) {
    const group = await this.getGroup(groupId)
    if (!group) {
      throw new Error('粘滞分组不存在')
    }

    const client = redis.getClientSafe()
    for (const accountId of group.memberIds || []) {
      const reverseKey = this._accountGroupKey(group.platform, accountId)
      if ((await client.get(reverseKey)) === groupId) {
        await client.del(reverseKey)
      }
    }

    await client.del(`${this.GROUP_PREFIX}${groupId}`)
    await client.del(`${this.GROUP_MEMBERS_PREFIX}${groupId}`)
    await client.srem(this.GROUPS_KEY, groupId)
    logger.success(`删除粘滞分组成功: ${group.name}`)
  }
}

module.exports = new StickySessionGroupService()
module.exports.SUPPORTED_PLATFORMS = SUPPORTED_PLATFORMS
