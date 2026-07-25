jest.mock('../config/config', () => ({
  adminAudit: {
    enabled: true,
    retentionDays: 180
  }
}))

jest.mock('../src/models/postgres', () => ({
  query: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn()
}))

const postgres = require('../src/models/postgres')
const { AdminAuditService, sanitizeMetadata } = require('../src/services/adminAuditService')

describe('AdminAuditService', () => {
  let service

  beforeEach(() => {
    jest.clearAllMocks()
    service = new AdminAuditService({ postgres })
    service.schemaReady = true
    service.lastCleanupAt = Date.now()
  })

  test('stores bounded operation metadata without secrets', async () => {
    postgres.query.mockResolvedValue({
      rows: [
        {
          id: 12,
          occurred_at: new Date('2026-07-25T00:00:00.000Z'),
          actor_type: 'management-key',
          action: 'account.update',
          resource_type: 'account',
          result: 'success',
          changed_fields: ['name', 'refreshToken'],
          metadata: { accountType: 'claude', token: '[REDACTED]' }
        }
      ]
    })

    const result = await service.record({
      requestId: 'request-1',
      actorType: 'management-key',
      actorId: 'management-key-1',
      deviceId: 'device-1',
      deviceName: 'Office Mac',
      action: 'account.update',
      resourceType: 'account',
      resourceId: 'account-1',
      result: 'success',
      statusCode: 200,
      changedFields: ['name', 'refreshToken', 'name'],
      metadata: {
        accountType: 'claude',
        token: 'secret-token',
        note: `contains crsm_${'a'.repeat(64)}`
      }
    })

    expect(result.id).toBe('12')
    const values = postgres.query.mock.calls[0][1]
    expect(JSON.parse(values[19])).toEqual(['name', 'refreshToken'])
    expect(JSON.parse(values[20])).toEqual({
      accountType: 'claude',
      token: '[REDACTED]',
      note: 'contains crsm_[REDACTED]'
    })
    expect(JSON.stringify(values)).not.toContain(`crsm_${'a'.repeat(64)}`)
  })

  test('lists audit records with filters and server pagination', async () => {
    postgres.query.mockResolvedValueOnce({ rows: [{ total: 21 }] }).mockResolvedValueOnce({
      rows: [
        {
          id: 21,
          occurred_at: new Date('2026-07-25T00:00:00.000Z'),
          actor_type: 'admin-session',
          action: 'api_key.delete',
          resource_type: 'api_key',
          result: 'success',
          changed_fields: [],
          metadata: {}
        }
      ]
    })

    const result = await service.list({
      page: 2,
      pageSize: 10,
      action: 'api_key.delete',
      deviceName: 'Office Mac'
    })

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        id: '21',
        action: 'api_key.delete'
      })
    )
    expect(result.pagination).toEqual({
      page: 2,
      pageSize: 10,
      total: 21,
      totalPages: 3,
      hasNext: true,
      hasPrevious: true
    })
    expect(postgres.query.mock.calls[0][0]).toContain('action = $1')
    expect(postgres.query.mock.calls[0][0]).toContain('device_name = $2')
  })

  test('rejects invalid date filters', async () => {
    await expect(service.list({ from: 'not-a-date' })).rejects.toMatchObject({
      code: 'INVALID_QUERY_PARAMETER',
      status: 400
    })
    expect(postgres.query).not.toHaveBeenCalled()
  })

  test('rejects invalid result filters', async () => {
    await expect(service.list({ result: 'maybe' })).rejects.toMatchObject({
      code: 'INVALID_QUERY_PARAMETER',
      status: 400
    })
    expect(postgres.query).not.toHaveBeenCalled()
  })

  test('sanitizes nested sensitive metadata', () => {
    expect(
      sanitizeMetadata({
        safe: 'visible',
        credentials: { username: 'hidden' },
        nested: { apiKey: 'hidden' }
      })
    ).toEqual({
      safe: 'visible',
      credentials: '[REDACTED]',
      nested: { apiKey: '[REDACTED]' }
    })
  })
})
