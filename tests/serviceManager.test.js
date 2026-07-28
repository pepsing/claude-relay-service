const ServiceManager = require('../scripts/manage')
const webhookConfigService = require('../src/services/webhookConfigService')
const webhookService = require('../src/services/webhookService')

describe('service lifecycle notification registration', () => {
  test('is enabled by default and has a dedicated notification title', () => {
    expect(webhookConfigService.getDefaultConfig().notificationTypes.serviceLifecycle).toBe(true)
    expect(webhookService.getNotificationTitle('serviceLifecycle')).toBe('🔄 服务重启通知')
  })
})

describe('ServiceManager restart lifecycle notifications', () => {
  let manager
  let consoleSpies

  beforeEach(() => {
    manager = new ServiceManager()
    consoleSpies = [
      jest.spyOn(console, 'log').mockImplementation(() => {}),
      jest.spyOn(console, 'error').mockImplementation(() => {}),
      jest.spyOn(console, 'warn').mockImplementation(() => {})
    ]
  })

  afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore())
    jest.clearAllMocks()
  })

  test('sends notifications before restart and after the new service is healthy', async () => {
    manager.getStatus = jest
      .fn()
      .mockReturnValueOnce({ running: true, pid: 100 })
      .mockReturnValueOnce({ running: true, pid: 200 })
    manager.sendServiceLifecycleNotification = jest.fn().mockResolvedValue({})
    manager.stop = jest.fn().mockResolvedValue(true)
    manager.start = jest.fn().mockResolvedValue(true)
    manager.waitForHealth = jest.fn().mockResolvedValue(true)
    manager.getHealthUrl = jest.fn().mockReturnValue('http://127.0.0.1:3011/health')

    await expect(manager.restart(true)).resolves.toBe(true)

    expect(manager.sendServiceLifecycleNotification).toHaveBeenNthCalledWith(
      1,
      '准备重启',
      expect.stringContaining('PID: 100')
    )
    expect(manager.sendServiceLifecycleNotification).toHaveBeenNthCalledWith(
      2,
      '启动成功',
      expect.stringContaining('PID: 200')
    )
    expect(manager.sendServiceLifecycleNotification.mock.invocationCallOrder[0]).toBeLessThan(
      manager.stop.mock.invocationCallOrder[0]
    )
    expect(manager.waitForHealth).toHaveBeenCalledTimes(1)
  })

  test('sends a failure notification when the new service does not become healthy', async () => {
    manager.getStatus = jest
      .fn()
      .mockReturnValueOnce({ running: true, pid: 100 })
      .mockReturnValueOnce({ running: true, pid: 200 })
    manager.sendServiceLifecycleNotification = jest.fn().mockResolvedValue({})
    manager.stop = jest.fn().mockResolvedValue(true)
    manager.start = jest.fn().mockResolvedValue(true)
    manager.waitForHealth = jest.fn().mockResolvedValue(false)
    manager.getHealthUrl = jest.fn().mockReturnValue('http://127.0.0.1:3011/health')

    await expect(manager.restart(true)).resolves.toBe(false)

    expect(manager.sendServiceLifecycleNotification).toHaveBeenLastCalledWith(
      '启动失败',
      expect.stringContaining('PID: 200')
    )
  })

  test('does not report success when an unmanaged process answers the health check', async () => {
    manager.getStatus = jest
      .fn()
      .mockReturnValueOnce({ running: false, pid: null })
      .mockReturnValueOnce({ running: false, pid: null })
    manager.sendServiceLifecycleNotification = jest.fn().mockResolvedValue({})
    manager.stop = jest.fn().mockResolvedValue(false)
    manager.start = jest.fn().mockResolvedValue(true)
    manager.waitForHealth = jest.fn().mockResolvedValue(true)
    manager.getHealthUrl = jest.fn().mockReturnValue('http://127.0.0.1:3011/health')

    await expect(manager.restart(true)).resolves.toBe(false)

    expect(manager.sendServiceLifecycleNotification).toHaveBeenLastCalledWith(
      '启动失败',
      expect.stringContaining('未确认新进程健康运行')
    )
  })

  test('waits until the health endpoint reports healthy', async () => {
    manager.checkHealth = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    manager.wait = jest.fn().mockResolvedValue()

    await expect(manager.waitForHealth(1000, 1)).resolves.toBe(true)
    expect(manager.checkHealth).toHaveBeenCalledTimes(2)
  })
})
