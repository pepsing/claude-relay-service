jest.mock('../src/services/claudeRelayConfigService', () => ({
  getConfig: jest.fn(async () => ({ concurrentRequestQueueTimeoutMs: 5000 }))
}))
jest.mock('../src/utils/logger', () => ({ info: jest.fn() }))

const service = require('../src/services/accountConcurrencyQueueService')

describe('accountConcurrencyQueueService', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('waits on the same account until a concurrency slot becomes available', async () => {
    const tryAcquire = jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1)
    const release = jest.fn().mockResolvedValue(undefined)

    const queued = service.waitForSlot({
      accountId: 'responses-1',
      accountName: 'Krill 1',
      maxConcurrentTasks: 1,
      tryAcquire,
      release
    })

    await jest.advanceTimersByTimeAsync(60)

    await expect(queued).resolves.toMatchObject({ currentConcurrency: 1 })
    expect(tryAcquire).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
