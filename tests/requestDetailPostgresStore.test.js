jest.mock('../src/models/postgres', () => ({
  query: jest.fn()
}))

const postgres = require('../src/models/postgres')
const requestDetailPostgresStore = require('../src/services/requestDetailStores/postgresRequestDetailStore')

describe('requestDetailPostgresStore', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    postgres.query.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  test('ensureSchema retries after failure and deduplicates concurrent attempts', async () => {
    postgres.query
      .mockRejectedValueOnce(new Error('schema unavailable'))
      .mockResolvedValue({ rows: [], rowCount: 0 })

    await expect(requestDetailPostgresStore.ensureSchema()).rejects.toThrow('schema unavailable')
    await Promise.all([
      requestDetailPostgresStore.ensureSchema(),
      requestDetailPostgresStore.ensureSchema()
    ])

    const schemaCalls = postgres.query.mock.calls.filter(([sql]) =>
      String(sql).includes('CREATE TABLE IF NOT EXISTS request_details')
    )
    expect(schemaCalls).toHaveLength(2)
  })

  test('upsertRequestDetail writes payload booleans when only request body is present', async () => {
    await requestDetailPostgresStore.upsertRequestDetail({
      requestId: 'req_payload_only',
      timestamp: '2026-05-27T08:00:00.000Z',
      model: 'glm-5.1',
      requestBodySnapshot: { model: 'glm-5.1' }
    })

    const payloadCall = postgres.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO request_detail_payloads')
    )

    expect(payloadCall).toBeTruthy()
    expect(payloadCall[1][5]).toBe(false)
    expect(payloadCall[1][10]).toBe(false)
  })

  test('upsertRequestDetail writes response payload fields', async () => {
    await requestDetailPostgresStore.upsertRequestDetail({
      requestId: 'req_response_payload',
      timestamp: '2026-05-27T08:00:00.000Z',
      model: 'glm-5.1',
      responseBodySnapshot: {
        id: 'resp_123',
        output: [{ content: 'hello' }]
      },
      responseTextPreview: '{"id":"resp_123"',
      responseBodySizeBytes: 128,
      responseBodyTruncated: false,
      upstreamResponseId: 'resp_123',
      finishReason: 'stop',
      responseMetadata: {
        captureMode: 'full'
      }
    })

    const payloadCall = postgres.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO request_detail_payloads')
    )

    expect(payloadCall).toBeTruthy()
    expect(JSON.parse(payloadCall[1][7])).toEqual({
      id: 'resp_123',
      output: [{ content: 'hello' }]
    })
    expect(payloadCall[1][8]).toBe('{"id":"resp_123"')
    expect(payloadCall[1][9]).toBe(128)
    expect(payloadCall[1][10]).toBe(false)
    expect(payloadCall[1][11]).toBe('resp_123')
    expect(payloadCall[1][12]).toBe('stop')
    expect(JSON.parse(payloadCall[1][14])).toEqual({ captureMode: 'full' })
  })

  test('upsertRequestDetail stores user input without a request body snapshot', async () => {
    await requestDetailPostgresStore.upsertRequestDetail({
      requestId: 'req_user_input',
      timestamp: '2026-05-27T08:00:00.000Z',
      model: 'gpt-5.1',
      userInput: '  explain this code  '
    })

    const payloadCall = postgres.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO request_detail_payloads')
    )

    expect(payloadCall).toBeTruthy()
    expect(payloadCall[0]).toContain('user_input')
    expect(payloadCall[1][3]).toBeNull()
    expect(payloadCall[1][15]).toBe('  explain this code  ')
  })

  test('listRecordsPage orders by whitelisted request metric columns', async () => {
    postgres.query.mockResolvedValueOnce({
      rows: [
        {
          request_id: 'req_list_user_input',
          timestamp: '2026-05-27T08:00:00.000Z',
          payload_user_input: 'list this input'
        }
      ],
      rowCount: 1
    })

    const records = await requestDetailPostgresStore.listRecordsPage({
      startDate: '2026-05-27T00:00:00.000Z',
      endDate: '2026-05-28T00:00:00.000Z',
      sortBy: 'cost',
      sortOrder: 'asc',
      page: 1,
      pageSize: 20
    })

    const [sql, values] = postgres.query.mock.calls[0]
    expect(sql).toContain('p.user_input AS payload_user_input')
    expect(sql).toContain('LEFT JOIN request_detail_payloads p')
    expect(sql).toContain('ORDER BY d.cost ASC, d.timestamp ASC, d.request_id ASC')
    expect(sql).not.toContain('sortBy')
    expect(values).toHaveLength(4)
    expect(records[0].userInput).toBe('list this input')
  })

  test('listRecordsPage filters for non-empty stored user input', async () => {
    await requestDetailPostgresStore.listRecordsPage({
      startDate: '2026-05-27T00:00:00.000Z',
      endDate: '2026-05-28T00:00:00.000Z',
      filters: { hasUserInput: true },
      page: 1,
      pageSize: 20
    })

    const [sql, values] = postgres.query.mock.calls[0]
    expect(sql).toContain('FROM request_detail_payloads p_user_input')
    expect(sql).toContain('p_user_input.request_id = d.request_id')
    expect(sql).toContain("p_user_input.user_input ~ '[^[:space:]]'")
    expect(values).toHaveLength(4)
  })

  test('cleanupExpiredRequestDetails deletes only expired request detail rows', async () => {
    postgres.query.mockResolvedValueOnce({ rows: [], rowCount: 3 })

    const result = await requestDetailPostgresStore.cleanupExpiredRequestDetails({
      retentionHours: 48,
      batchSize: 100
    })

    const [sql, values] = postgres.query.mock.calls[0]
    expect(result).toEqual({
      deletedRecords: 3,
      retentionHours: 48,
      batchSize: 100,
      batches: 1,
      skipped: false
    })
    expect(sql).toContain('DELETE FROM request_details')
    expect(sql).toContain('USING expired')
    expect(sql).not.toContain('usage_events')
    expect(sql).not.toContain('usage_rollups')
    expect(values).toEqual([48, 100])
  })

  test('cleanupExpiredRequestDetails skips invalid retention values', async () => {
    const result = await requestDetailPostgresStore.cleanupExpiredRequestDetails({
      retentionHours: 0
    })

    expect(result).toEqual({
      deletedRecords: 0,
      retentionHours: 0,
      batchSize: 0,
      batches: 0,
      skipped: true,
      reason: 'invalid_retention'
    })
    expect(postgres.query).not.toHaveBeenCalled()
  })
})
