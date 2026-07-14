const hashes = new Map()
const sets = new Map()
const values = new Map()

const mockRedisClient = {
  hmset: jest.fn(async (key, data) => {
    hashes.set(key, { ...(hashes.get(key) || {}), ...data })
  }),
  hgetall: jest.fn(async (key) => hashes.get(key) || null),
  sadd: jest.fn(async (key, ...members) => {
    const set = sets.get(key) || new Set()
    members.forEach((member) => set.add(member))
    sets.set(key, set)
  }),
  smembers: jest.fn(async (key) => [...(sets.get(key) || new Set())]),
  srem: jest.fn(async (key, ...members) => {
    const set = sets.get(key) || new Set()
    members.forEach((member) => set.delete(member))
    sets.set(key, set)
  }),
  sismember: jest.fn(async (key, member) => (sets.get(key)?.has(member) ? 1 : 0)),
  get: jest.fn(async (key) => values.get(key) || null),
  set: jest.fn(async (key, value) => values.set(key, value)),
  del: jest.fn(async (...keys) => {
    keys.forEach((key) => {
      hashes.delete(key)
      sets.delete(key)
      values.delete(key)
    })
  })
}

jest.mock('../src/models/redis', () => ({ getClientSafe: jest.fn(() => mockRedisClient) }))
jest.mock('../src/utils/logger', () => ({ success: jest.fn() }))

const service = require('../src/services/stickySessionGroupService')

describe('stickySessionGroupService', () => {
  beforeEach(() => {
    hashes.clear()
    sets.clear()
    values.clear()
    jest.clearAllMocks()
  })

  it('moves an account between groups and clears reverse membership on delete', async () => {
    const kimi = await service.createGroup({ name: 'Kimi', platform: 'claude-console' })
    const glm = await service.createGroup({ name: 'GLM', platform: 'claude-console' })

    await service.setGroupMembers(kimi.id, ['account-a', 'account-b'])
    await service.setGroupMembers(glm.id, ['account-a'])

    await expect(service.getGroupForAccount('account-a', 'claude-console')).resolves.toMatchObject({
      id: glm.id,
      name: 'GLM'
    })
    await expect(service.getGroup(kimi.id)).resolves.toMatchObject({
      memberIds: ['account-b'],
      memberCount: 1
    })

    await service.deleteGroup(glm.id)
    await expect(service.getGroupForAccount('account-a', 'claude-console')).resolves.toBeNull()
  })

  it('rejects duplicate names within the same platform', async () => {
    await service.createGroup({ name: 'Krill', platform: 'openai-responses' })

    await expect(
      service.createGroup({ name: ' krill ', platform: 'openai-responses' })
    ).rejects.toThrow('同一平台下粘滞分组名称不能重复')
  })
})
