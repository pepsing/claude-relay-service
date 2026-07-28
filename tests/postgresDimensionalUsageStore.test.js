const mockPostgres = {
  query: jest.fn(),
  transaction: jest.fn()
}

jest.mock('../src/models/postgres', () => mockPostgres)

function loadStore() {
  jest.resetModules()
  return require('../src/services/usageStores/postgresDimensionalUsageStore')
}

describe('postgresDimensionalUsageStore', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPostgres.query.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  test('rebuilds an account/model/API-key window atomically', async () => {
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rowCount: 3 })
        .mockResolvedValueOnce({ rowCount: 2 })
    }
    mockPostgres.transaction.mockImplementation((callback) => callback(client))
    const store = loadStore()

    const result = await store.materializeRange({
      granularity: 'day',
      startDate: '2026-07-01T16:00:00.000Z',
      endDate: '2026-07-02T16:00:00.000Z',
      businessTimezone: 'Asia/Shanghai'
    })

    expect(result).toEqual(
      expect.objectContaining({
        materialized: true,
        rows: 2,
        replacedRows: 3
      })
    )
    expect(client.query.mock.calls[1][0]).toContain('DELETE FROM usage_dimensional_rollups')
    const materializeSql = client.query.mock.calls[2][0]
    expect(materializeSql).toContain("date_trunc(\n    'day'")
    expect(materializeSql).toContain("COALESCE(NULLIF(account_id, ''), '')")
    expect(materializeSql).toContain('api_key_id')
    expect(materializeSql).toContain('normalized_model')
    expect(materializeSql).toContain("'usage_events'")
  })

  test('builds bounded minute periods with reader-facing labels', async () => {
    const store = loadStore()
    const trend = await store.buildTrendPeriods({
      granularity: 'minute',
      startDate: '2026-07-28T10:00:20.000Z',
      endDate: '2026-07-28T10:02:40.000Z',
      businessTimezone: 'Asia/Shanghai'
    })

    expect(trend.start.toISOString()).toBe('2026-07-28T10:00:00.000Z')
    expect(trend.endExclusive.toISOString()).toBe('2026-07-28T10:03:00.000Z')
    expect(trend.periods).toHaveLength(3)
    expect(trend.periods[0]).toEqual(
      expect.objectContaining({
        minute: '2026-07-28T10:00:00.000Z',
        label: '07/28 18:00'
      })
    )
  })

  test('queries the full dimensional grain and normalizes numeric values', async () => {
    const store = loadStore()
    mockPostgres.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
      rows: [
        {
          bucket_start: '2026-07-01T16:00:00.000Z',
          account_type: 'openai',
          account_id: 'acct-1',
          api_key_id: 'key-1',
          normalized_model: 'gpt-5',
          usage_request_count: '2',
          input_tokens: '10',
          output_tokens: '5',
          total_tokens: '15',
          cost: '0.12',
          real_cost: '0.10'
        }
      ],
      rowCount: 1
    })

    const rows = await store.queryDimensionalUsage({
      granularity: 'day',
      startDate: '2026-07-01T16:00:00.000Z',
      endDate: '2026-07-02T16:00:00.000Z'
    })

    expect(rows).toEqual([
      expect.objectContaining({
        accountType: 'openai',
        accountId: 'acct-1',
        apiKeyId: 'key-1',
        model: 'gpt-5',
        requests: 2,
        totalTokens: 15,
        cost: 0.12,
        realCost: 0.1
      })
    ])
    const querySql = mockPostgres.query.mock.calls[1][0]
    expect(querySql).toContain('GROUP BY bucket_start, account_type, account_id, api_key_id')
  })

  test('imports pre-aggregated Langfuse rows without request payloads', async () => {
    const store = loadStore()
    mockPostgres.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    const result = await store.upsertAggregatedRows([
      {
        granularity: 'day',
        bucketStart: '2026-06-01T16:00:00.000Z',
        accountType: 'claude-console',
        accountId: 'acct-1',
        apiKeyId: 'key-1',
        model: 'glm-5',
        requests: 4,
        totalTokens: 100,
        cost: 0.5
      }
    ])

    expect(result).toEqual({ upserted: 1 })
    const payload = JSON.parse(mockPostgres.query.mock.calls[1][1][0])
    expect(payload[0]).toEqual(
      expect.objectContaining({
        source_type: 'langfuse',
        account_id: 'acct-1',
        api_key_id: 'key-1',
        normalized_model: 'glm-5',
        usage_request_count: 4,
        total_tokens: 100
      })
    )
    expect(JSON.stringify(payload[0])).not.toContain('requestBody')
  })

  test('serves all-time, monthly, and daily account summaries from daily rollups', async () => {
    const store = loadStore()
    mockPostgres.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            usage_date: '2026-07-28',
            start_at: '2026-07-27T16:00:00.000Z',
            end_at: '2026-07-28T16:00:00.000Z'
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            usage_date: '2026-07-01',
            start_at: '2026-06-30T16:00:00.000Z',
            end_at: '2026-07-01T16:00:00.000Z'
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            total_request_count: '20',
            total_cost: '4.5',
            daily_request_count: '2',
            daily_cost: '0.5',
            monthly_request_count: '10',
            monthly_cost: '2.5'
          }
        ]
      })

    const summary = await store.getAccountUsageSummary('acct-1', 'Asia/Shanghai')

    expect(summary).toEqual({
      totalCost: 4.5,
      dailyCost: 0.5,
      monthlyCost: 2.5,
      totalRequests: 20,
      dailyRequests: 2,
      monthlyRequests: 10
    })
    expect(mockPostgres.query.mock.calls[3][0]).toContain(
      "FROM usage_dimensional_rollups\n      WHERE granularity = 'day'"
    )
  })
})
