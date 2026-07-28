jest.mock('../src/models/postgres', () => ({
  query: jest.fn(),
  transaction: jest.fn()
}))

const postgres = require('../src/models/postgres')
const store = require('../src/services/quotaCycleStores/postgresQuotaCycleStore')

function cycleRow(overrides = {}) {
  return {
    cycle_id: 'quota_cycle_1',
    cycle_key: 'weekly:reset:2026-07-30T02:00:00.000Z',
    quota_group_id: 'qg_1',
    provider: 'glm',
    window_type: 'weekly',
    window_start_at: new Date('2026-07-23T02:00:00.000Z'),
    first_exceeded_at: new Date('2026-07-25T07:32:00.000Z'),
    last_exceeded_at: new Date('2026-07-25T07:32:00.000Z'),
    reset_at: new Date('2026-07-30T02:00:00.000Z'),
    recovered_at: null,
    status: 'exceeded',
    boundary_source: 'provider_reset',
    is_partial: false,
    provider_snapshot: { percentage: 100 },
    account_refs: [{ accountId: 'account_1' }],
    usage_summary: null,
    usage_finalized_at: null,
    export_status: 'waiting_usage',
    export_attempts: 0,
    export_claim_token: null,
    export_claimed_at: null,
    export_next_attempt_at: null,
    exported_at: null,
    export_trace_id: null,
    export_error: null,
    created_at: new Date('2026-07-25T07:32:00.000Z'),
    updated_at: new Date('2026-07-25T07:32:00.000Z'),
    ...overrides
  }
}

describe('postgresQuotaCycleStore', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    postgres.query.mockResolvedValue({ rows: [], rowCount: 0 })
    postgres.transaction.mockImplementation(async (callback) => callback({ query: postgres.query }))
  })

  test('marks an exceeded cycle idempotently without overwriting the first exceeded time', async () => {
    postgres.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [cycleRow()], rowCount: 1 })

    const result = await store.markExceeded({
      cycleId: 'quota_cycle_1',
      cycleKey: 'weekly:reset:2026-07-30T02:00:00.000Z',
      quotaGroupId: 'qg_1',
      provider: 'glm',
      windowType: 'weekly',
      windowStartAt: '2026-07-23T02:00:00.000Z',
      firstExceededAt: '2026-07-25T07:32:00.000Z',
      resetAt: '2026-07-30T02:00:00.000Z',
      boundarySource: 'provider_reset',
      accountRefs: [{ accountId: 'account_1' }]
    })

    const [sql, values] = postgres.query.mock.calls[1]
    expect(sql).toContain('ON CONFLICT (quota_group_id, provider, window_type, cycle_key)')
    expect(sql).toContain('first_exceeded_at = LEAST')
    expect(sql).toContain('last_exceeded_at = GREATEST')
    expect(sql).toContain('jsonb_array_elements')
    expect(sql).toContain('DISTINCT ON (candidate.account_key)')
    expect(sql).toContain("EXCLUDED.provider = 'zhipu'")
    expect(sql).toContain('quota_limit_cycles.account_refs @> EXCLUDED.account_refs')
    expect(sql).toContain("export_status IN ('waiting_usage', 'pending', 'failed')")
    expect(values[2]).toBe('qg_1')
    expect(result.cycleId).toBe('quota_cycle_1')
    expect(result.providerSnapshot).toEqual({ percentage: 100 })
  })

  test('aggregates usage events by account set, time window and normalized model', async () => {
    postgres.query.mockImplementation(async (sql) => {
      if (String(sql).includes('FROM usage_events')) {
        return {
          rows: [
            {
              model: 'glm-5.2',
              request_count: '2',
              input_tokens: '10',
              output_tokens: '4',
              cache_create_tokens: '3',
              cache_read_tokens: '20',
              ephemeral_5m_tokens: '1',
              ephemeral_1h_tokens: '2',
              total_tokens: '37',
              cost: '0.12345678',
              real_cost: '0.10000000',
              first_observed_at: new Date('2026-07-23T03:00:00.000Z'),
              last_observed_at: new Date('2026-07-25T07:30:00.000Z')
            }
          ]
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const summary = await store.aggregateUsage({
      quotaGroupId: 'qg_1',
      accountRefs: [
        { accountId: 'account_1', accountType: 'claude-console' },
        { accountId: 'account_2', accountType: 'openai-responses' },
        { accountId: 'account_1', accountType: 'claude-console' }
      ],
      startAt: '2026-07-23T02:00:00.000Z',
      endAt: '2026-07-25T07:32:00.000Z'
    })

    const [sql, values] = postgres.query.mock.calls.find(([query]) =>
      String(query).includes('FROM usage_events')
    )
    expect(sql).toContain('FROM usage_events')
    expect(sql).toContain('jsonb_to_recordset($1::jsonb)')
    expect(sql).toContain('requested_account."accountType" = event.account_type')
    expect(sql).toContain('GROUP BY COALESCE')
    expect(JSON.parse(values[0])).toEqual([
      { accountId: 'account_1', accountType: 'claude-console' },
      { accountId: 'account_2', accountType: 'openai-responses' }
    ])
    expect(summary.semantics).toBe('crs_observed_usage')
    expect(summary.scope.accountRefs).toEqual([
      { accountId: 'account_1', accountType: 'claude-console' },
      { accountId: 'account_2', accountType: 'openai-responses' }
    ])
    expect(summary.totals).toEqual(
      expect.objectContaining({
        requests: 2,
        totalTokens: 37,
        cost: 0.12345678
      })
    )
    expect(summary.models[0].model).toBe('glm-5.2')
  })

  test('reads the stable quota tracking activation boundary', async () => {
    postgres.query.mockImplementation(async (sql) => {
      if (String(sql).includes("metadata_key = 'tracking_started_at'")) {
        return { rows: [{ started_at: '2026-07-28T00:00:00.000Z' }] }
      }
      return { rows: [], rowCount: 0 }
    })

    await expect(store.getTrackingStartedAt()).resolves.toBe('2026-07-28T00:00:00.000Z')
  })

  test('serializes open cycles without provider reset boundaries', async () => {
    const transactionQuery = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            cycle_id: 'existing-kimi-cycle',
            cycle_key: 'billing_cycle:observed:2026-07-28T01:00:00.000Z'
          }
        ]
      })
      .mockResolvedValueOnce({
        rows: [
          cycleRow({
            cycle_id: 'existing-kimi-cycle',
            cycle_key: 'billing_cycle:observed:2026-07-28T01:00:00.000Z',
            provider: 'kimi',
            window_type: 'billing_cycle'
          })
        ]
      })
    postgres.transaction.mockImplementation(async (callback) =>
      callback({ query: transactionQuery })
    )

    const cycle = await store.markExceeded({
      cycleId: 'new-racing-cycle',
      cycleKey: 'billing_cycle:observed:2026-07-28T01:00:01.000Z',
      quotaGroupId: 'qg-kimi',
      provider: 'kimi',
      windowType: 'billing_cycle',
      firstExceededAt: '2026-07-28T01:00:01.000Z',
      boundarySource: 'first_observed_exceeded',
      accountRefs: [{ accountId: 'kimi-1', accountType: 'claude-console' }],
      reuseOpenCycle: true
    })

    expect(transactionQuery.mock.calls[0][0]).toContain('pg_advisory_xact_lock')
    expect(transactionQuery.mock.calls[1][0]).toContain("status = 'exceeded'")
    expect(transactionQuery.mock.calls[2][1][0]).toBe('existing-kimi-cycle')
    expect(cycle.cycleId).toBe('existing-kimi-cycle')
  })

  test('ignores recovery observations older than the latest exceeded event', async () => {
    postgres.query.mockResolvedValue({
      rows: [
        cycleRow({
          status: 'recovered',
          recovered_at: new Date('2026-07-25T07:35:00.000Z')
        })
      ],
      rowCount: 1
    })

    await store.markRecovered({
      cycleId: 'quota_cycle_1',
      recoveredAt: '2026-07-25T07:35:00.000Z'
    })

    const [sql] = postgres.query.mock.calls.find(([query]) =>
      String(query).includes("SET status = 'recovered'")
    )
    expect(sql).toContain('AND $2 >= last_exceeded_at')
    expect(sql).toContain('LEAST(recovered_at, $2)')
  })

  test('claims finalized cycles with a lease and SKIP LOCKED', async () => {
    postgres.query.mockImplementation(async (sql) => {
      if (String(sql).includes('FOR UPDATE SKIP LOCKED')) {
        return {
          rows: [
            cycleRow({
              usage_summary: { totals: { totalTokens: 37 } },
              usage_finalized_at: new Date('2026-07-25T07:34:00.000Z'),
              export_status: 'processing',
              export_attempts: 1,
              export_claim_token: 'claim-token'
            })
          ]
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const result = await store.claimPendingExports({
      limit: 10,
      now: '2026-07-25T07:35:00.000Z'
    })

    const [sql, values] = postgres.query.mock.calls.find(([query]) =>
      String(query).includes('FOR UPDATE SKIP LOCKED')
    )
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain("export_status IN ('pending', 'failed')")
    expect(values[2]).toBe(10)
    expect(typeof result.claimToken).toBe('string')
    expect(result.cycles).toHaveLength(1)
  })
})
