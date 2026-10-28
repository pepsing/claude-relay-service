jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

describe('pricing startup network deadline', () => {
  beforeEach(() => jest.resetModules())
  afterEach(() => jest.restoreAllMocks())

  test.each(['fetchRemoteHash', '_downloadFromRemote'])(
    '%s aborts even when DNS never finishes',
    async (method) => {
      const https = require('https')
      const originalGet = https.get
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
      const deadline = jest
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation(() => originalTimeout(20))
      jest
        .spyOn(https, 'get')
        .mockImplementation((url, options, callback) =>
          originalGet(url, { ...options, lookup: () => {} }, callback)
        )
      const pricing = require('../src/services/pricingService')
      await expect(pricing[method]()).rejects.toThrow(/abort/i)
      expect(deadline).toHaveBeenCalledWith(30000)
    }
  )
})
