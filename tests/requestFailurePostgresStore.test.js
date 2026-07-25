jest.mock('../src/models/postgres', () => ({
  query: jest.fn(),
  transaction: jest.fn()
}))

const postgres = require('../src/models/postgres')
const store = require('../src/services/requestFailureStores/postgresRequestFailureStore')

describe('postgresRequestFailureStore', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    postgres.query.mockResolvedValue({ rows: [], rowCount: 0 })
    postgres.transaction.mockImplementation(async (callback) =>
      callback({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }) })
    )
  })

  test('writes only the dedicated failure tables', async () => {
    const queries = []
    postgres.transaction.mockImplementation(async (callback) =>
      callback({
        query: jest.fn(async (sql, values) => {
          queries.push([String(sql), values])
          return { rows: [], rowCount: 1 }
        })
      })
    )

    await store.upsertRequestFailures([
      {
        requestId: 'req_failure_1',
        timestamp: '2026-07-25T08:00:00.000Z',
        apiKeyId: 'key_1',
        httpStatus: 503,
        failureType: 'upstream_unavailable',
        clientErrorBody: { error: 'unavailable' }
      }
    ])

    expect(queries.some(([sql]) => sql.includes('INSERT INTO request_failure_details'))).toBe(true)
    expect(queries.some(([sql]) => sql.includes('INSERT INTO request_failure_payloads'))).toBe(true)
    expect(queries.every(([sql]) => !sql.includes('usage_events'))).toBe(true)
    expect(queries.every(([sql]) => !sql.includes('request_details'))).toBe(true)
  })

  test('scopes detail queries by API key in SQL', async () => {
    postgres.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    await store.getRequestFailure('req_failure_1', { apiKeyId: 'key_current' })

    const [sql, values] = postgres.query.mock.calls.at(-1)
    expect(sql).toContain('d.request_id = $1')
    expect(sql).toContain('d.api_key_id = $2')
    expect(values).toEqual(['req_failure_1', 'key_current'])
  })

  test('returns API key options for the admin failure filter', async () => {
    postgres.query.mockImplementation(async (sql) => {
      if (String(sql).includes('GROUP BY d.api_key_id')) {
        return {
          rows: [{ api_key_id: 'key_1', api_key_name: 'Primary key' }]
        }
      }
      if (String(sql).includes('ARRAY_REMOVE')) {
        return {
          rows: [
            {
              models: ['gpt-5.4'],
              endpoints: ['/openai/v1/responses'],
              failure_types: ['upstream_error'],
              status_codes: [500],
              earliest: null,
              latest: null
            }
          ]
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const filters = await store.getAvailableFilters({
      startDate: '2026-07-24T00:00:00.000Z',
      endDate: '2026-07-25T00:00:00.000Z'
    })

    expect(filters.apiKeys).toEqual([{ id: 'key_1', name: 'Primary key' }])
    expect(postgres.query.mock.calls.at(-1)[0]).toContain('GROUP BY d.api_key_id')
  })

  test('cleanup never touches success detail or usage tables', async () => {
    postgres.query.mockResolvedValueOnce({ rows: [], rowCount: 4 })

    const result = await store.cleanupExpiredRequestFailures({
      retentionHours: 48,
      batchSize: 100
    })

    const [sql] = postgres.query.mock.calls.at(-1)
    expect(result.deletedRecords).toBe(4)
    expect(sql).toContain('DELETE FROM request_failure_details')
    expect(sql).not.toContain('DELETE FROM request_details')
    expect(sql).not.toContain('usage_events')
  })
})
