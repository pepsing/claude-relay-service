const mockClient = { get: jest.fn(), eval: jest.fn(), lrange: jest.fn() }
jest.mock('../src/models/redis', () => ({ getClientSafe: () => mockClient }))
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn() }))

const state = () => ({
  version: 1,
  revision: 0,
  groups: [{ id: 'team', name: 'tokensaver 使用者' }],
  memberships: { privileged: ['team'] },
  policies: Object.fromEntries(
    [1, 2, 3].map((n) => [
      `claude-console:tokensaver-${n}`,
      { mode: 'restricted', keyIds: ['individual'], groupIds: ['team'] }
    ])
  )
})

describe('account access policies', () => {
  let service
  beforeEach(() => {
    jest.resetModules()
    service = require('../src/services/accountAccessService')
    mockClient.get.mockResolvedValue(null)
    mockClient.eval.mockResolvedValue(1)
  })
  afterEach(() => jest.clearAllMocks())

  test('nine-account scenario preserves shared GLM and Kimi access', () => {
    const accounts = ['tokensaver', 'glm', 'kimi'].flatMap((provider) =>
      [1, 2, 3].map((n) => ({ accountType: 'claude-console', accountId: `${provider}-${n}` }))
    )
    expect(service.evaluator(state(), 'ordinary').filter(accounts)).toHaveLength(6)
    expect(service.evaluator(state(), 'privileged').filter(accounts)).toHaveLength(9)
    expect(service.evaluator(state(), 'individual').filter(accounts)).toHaveLength(9)
  })

  test('only absent storage means legacy unrestricted access', async () => {
    const access = await service.getEvaluator('ordinary')
    expect(access.canAccess('claude-console', 'tokensaver-1')).toBe(true)
    for (const raw of ['', '{}', 'null', '{broken', undefined]) {
      mockClient.get.mockResolvedValue(raw)
      await expect(service.getEvaluator('ordinary')).rejects.toMatchObject({
        code: 'ACCOUNT_ACCESS_UNAVAILABLE',
        statusCode: 503
      })
    }
  })

  test('read failures fail closed', async () => {
    mockClient.get.mockRejectedValueOnce(new Error('offline'))
    await expect(
      service.assertAllowed('claude-console', 'tokensaver-1', 'privileged')
    ).rejects.toMatchObject({ statusCode: 503 })
  })

  test('missing identity cannot use a restricted account', async () => {
    mockClient.get.mockResolvedValue(JSON.stringify(state()))
    await expect(service.assertAllowed('claude-console', 'tokensaver-1')).rejects.toMatchObject({
      statusCode: 403
    })
  })

  test('empty restricted policy denies everyone and survives group deletion', () => {
    const config = state()
    config.groups = []
    config.memberships = {}
    for (const policy of Object.values(config.policies)) {
      policy.groupIds = []
      policy.keyIds = []
    }
    service.validateState(config)
    expect(
      service.evaluator(config, 'privileged').canAccess('claude-console', 'tokensaver-1')
    ).toBe(false)
  })

  test('individual grant survives removing membership and explanation reveals both sources', () => {
    const config = state()
    config.memberships.individual = ['team']
    expect(
      service.evaluator(config, 'individual').explain('claude-console', 'tokensaver-1')
    ).toMatchObject({ allowed: true, direct: true, groupIds: ['team'] })
    config.memberships.individual = []
    expect(
      service.evaluator(config, 'individual').explain('claude-console', 'tokensaver-1')
    ).toMatchObject({ allowed: true, reason: 'key' })
  })

  test('account types are isolated, with official Claude alias normalized', () => {
    const config = state()
    config.policies['claude:same-id'] = { mode: 'restricted', keyIds: [], groupIds: [] }
    const access = service.evaluator(config, 'ordinary')
    expect(access.canAccess('claude-official', 'same-id')).toBe(false)
    expect(access.canAccess('openai', 'same-id')).toBe(true)
    expect(() => access.canAccess(undefined, 'same-id')).toThrow('Invalid account identity')
  })

  test('all denied candidates produce a distinct authorization error', () => {
    expect(() =>
      service.evaluator(state(), 'ordinary').filter([{ id: 'tokensaver-1' }], 'claude-console')
    ).toThrow('No authorized accounts')
  })

  test('same async request rechecks membership on each attempt', async () => {
    const config = state()
    mockClient.get.mockImplementation(async () => JSON.stringify(config))
    await service.runWithApiKey('privileged', async () => {
      await service.assertAllowed('claude-console', 'tokensaver-1')
      config.memberships.privileged = []
      await new Promise((resolve) => setImmediate(resolve))
      await expect(service.assertAllowed('claude-console', 'tokensaver-1')).rejects.toMatchObject({
        code: 'ACCOUNT_ACCESS_DENIED'
      })
    })
  })

  test('concurrent identities do not leak grants or administrator privilege', async () => {
    mockClient.get.mockResolvedValue(JSON.stringify(state()))
    const result = await Promise.allSettled([
      service.runWithApiKey('privileged', async () => {
        await new Promise((resolve) => setImmediate(resolve))
        return service.assertAllowed('claude-console', 'tokensaver-1')
      }),
      service.runWithApiKey('ordinary', () =>
        service.assertAllowed('claude-console', 'tokensaver-1')
      ),
      service.runAsAdministrator(() => service.assertAllowed('claude-console', 'tokensaver-1'))
    ])
    expect(result.map((item) => item.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    await expect(service.assertAllowed('claude-console', 'tokensaver-1')).rejects.toMatchObject({
      statusCode: 403
    })
  })

  test('stale editors and concurrent writers cannot overwrite a newer revision', async () => {
    mockClient.get.mockResolvedValue(JSON.stringify({ ...state(), revision: 2 }))
    await expect(service.saveState(state(), 'admin')).rejects.toMatchObject({ statusCode: 409 })
    expect(mockClient.eval).not.toHaveBeenCalled()
    mockClient.get.mockResolvedValue(null)
    mockClient.eval.mockResolvedValue(0)
    await expect(service.saveState(state(), 'admin')).rejects.toMatchObject({ statusCode: 409 })
  })

  test('saving policy and audit uses a single atomic operation', async () => {
    const saved = await service.saveState(state(), 'operator')
    expect(saved.revision).toBe(1)
    expect(mockClient.eval).toHaveBeenCalledTimes(1)
    const args = mockClient.eval.mock.calls[0]
    expect(args[1]).toBe(2)
    expect(JSON.parse(args[6])).toMatchObject({ actor: 'operator', revision: 1, after: saved })
  })

  test.each([
    (config) => {
      config.policies = 1
    },
    (config) => {
      config.memberships = true
    },
    (config) => {
      config.groups.push({ id: 'team', name: 'duplicate' })
    },
    (config) => {
      config.memberships.privileged = ['deleted-group']
    },
    (config) => {
      config.policies['claude-console:tokensaver-1'].mode = 'unknown'
    },
    (config) => {
      config.policies['claude-console:tokensaver-1'].keyIds = 'individual'
    }
  ])('rejects invalid configurations before any write', async (mutate) => {
    const config = state()
    mutate(config)
    await expect(service.saveState(config)).rejects.toMatchObject({ statusCode: 400 })
    expect(mockClient.eval).not.toHaveBeenCalled()
  })
})
