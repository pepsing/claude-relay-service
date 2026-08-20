jest.mock('../src/services/claudeRelayConfigService', () => ({
  getConfig: jest.fn()
}))

jest.mock('../src/services/requestFailureStores/postgresRequestFailureStore', () => ({
  upsertRequestFailures: jest.fn(),
  listRequestFailures: jest.fn(),
  getRequestFailureSummary: jest.fn(),
  getAvailableFilters: jest.fn(),
  getRequestFailure: jest.fn(),
  cleanupExpiredRequestFailures: jest.fn()
}))

jest.mock('../src/services/account/accountBalanceService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}))

const claudeRelayConfigService = require('../src/services/claudeRelayConfigService')
const store = require('../src/services/requestFailureStores/postgresRequestFailureStore')
const accountBalanceService = require('../src/services/account/accountBalanceService')
const service = require('../src/services/requestFailureDetailService')

describe('requestFailureDetailService', () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    service.writeQueue.length = 0
    service.metrics = {
      queued: 0,
      written: 0,
      dropped: 0,
      writeErrors: 0
    }
    claudeRelayConfigService.getConfig.mockResolvedValue({
      requestFailureCaptureEnabled: true,
      requestFailureRetentionHours: 48,
      requestFailureBodyPreviewEnabled: false,
      requestFailureIncludeClientAbort: true
    })
    store.upsertRequestFailures.mockResolvedValue({ upserted: 1 })
    accountBalanceService.getAccount.mockResolvedValue(null)
  })

  test('does not write anything when independent failure capture is disabled', async () => {
    claudeRelayConfigService.getConfig.mockResolvedValue({
      requestFailureCaptureEnabled: false
    })

    const result = await service.captureRequestFailure({
      requestId: 'req_disabled',
      apiKeyId: 'key_1',
      httpStatus: 500
    })
    await service.flush()

    expect(result).toEqual({ captured: false, reason: 'disabled' })
    expect(store.upsertRequestFailures).not.toHaveBeenCalled()
  })

  test('writes failures only to the dedicated failure store', async () => {
    const result = await service.captureRequestFailure({
      requestId: 'req_failure',
      apiKeyId: 'key_1',
      httpStatus: 503,
      failureType: 'upstream_unavailable',
      requestBodySnapshot: { model: 'gpt-5.4' }
    })
    await service.flush()

    expect(result).toEqual({
      captured: true,
      queued: true,
      requestId: 'req_failure'
    })
    expect(store.upsertRequestFailures).toHaveBeenCalledWith([
      expect.objectContaining({
        requestId: 'req_failure',
        apiKeyId: 'key_1',
        httpStatus: 503
      })
    ])
    expect(store.upsertRequestFailures.mock.calls[0][0][0]).not.toHaveProperty(
      'requestBodySnapshot'
    )
  })

  test('lists failures with an independent summary and retention window', async () => {
    store.listRequestFailures.mockResolvedValue({
      records: [
        {
          requestId: 'req_1',
          accountId: 'responses-account-1',
          accountType: 'openai-responses'
        }
      ],
      pagination: { currentPage: 1, pageSize: 50, totalRecords: 1, totalPages: 1 }
    })
    store.getRequestFailureSummary.mockResolvedValue({ totalFailures: 1 })
    store.getAvailableFilters.mockResolvedValue({ models: ['gpt-5.4'] })
    accountBalanceService.getAccount.mockResolvedValue({ name: 'Rocky Responses 01' })

    const result = await service.listRequestFailures({
      apiKeyId: 'key_1',
      startDate: '2026-07-24T00:00:00.000Z',
      endDate: '2026-07-25T00:00:00.000Z'
    })

    expect(result.summary.totalFailures).toBe(1)
    expect(result.records[0].accountName).toBe('Rocky Responses 01')
    expect(accountBalanceService.getAccount).toHaveBeenCalledWith(
      'responses-account-1',
      'openai-responses'
    )
    expect(store.listRequestFailures).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: 'key_1',
        startDate: '2026-07-24T00:00:00.000Z',
        endDate: '2026-07-25T00:00:00.000Z'
      })
    )
  })

  test('enriches an individual failure record with the current account name', async () => {
    store.getRequestFailure.mockResolvedValue({
      requestId: 'req_detail_1',
      accountId: 'responses-account-2',
      accountType: 'openai-responses'
    })
    accountBalanceService.getAccount.mockResolvedValue({ name: 'Rocky Responses 02' })

    const result = await service.getRequestFailure('req_detail_1')

    expect(result.record).toEqual(
      expect.objectContaining({
        requestId: 'req_detail_1',
        accountName: 'Rocky Responses 02'
      })
    )
  })
})
