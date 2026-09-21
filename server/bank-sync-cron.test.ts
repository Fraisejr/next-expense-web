import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { bankClient } from './bank-sync.ts'
import { runAutomaticBankSync } from './bank-sync-cron.ts'

const workspaceId = '10000000-0000-0000-0000-000000000001'
const accountId = '10000000-0000-0000-0000-000000000002'
type Row = Record<string, unknown>

function fixture(t: TestContext) {
  const accounts: Row[] = [{ id: accountId, workspace_id: workspaceId, name: 'Checking', provider_account_id: 'provider', auto_sync: true, closed: false, sort_order: 0 }]
  const connections: Row[] = [{ id: 'connection', workspace_id: workspaceId, account_id: accountId, provider: 'gocardless_bank_account_data', status: 'active', metadata: {}, updated_at: 'version-0' }]
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const table = url.pathname.split('/').pop()
    const rows = table === 'accounts' ? accounts : table === 'bank_connections' ? connections : []
    const matches = rows.filter((row) => [...url.searchParams].every(([column, expression]) => {
      if (['select', 'order', 'limit', 'offset'].includes(column)) return true
      if (!expression.startsWith('eq.')) return true
      return String(row[column]) === expression.slice(3)
    }))
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      matches.forEach((row) => Object.assign(row, body, { updated_at: `${row.updated_at}-next` }))
      return Response.json(matches)
    }
    return Response.json(matches)
  }
  t.after(() => { globalThis.fetch = original })
  return { connections, db: bankClient('https://data.example/rest/v1', 'Bearer cron-test') }
}

const summary = {
  imported: 2,
  duplicates: 0,
  balanceUpdated: true,
  rateLimits: {},
  syncedAt: '2026-09-20T05:00:00.000Z',
  syncRunsLast24Hours: 1,
  diagnostic: { fetchedAt: '2026-09-20T05:00:00.000Z', bookedReturned: 2, pendingReturned: 0, malformedIgnored: 0, imported: 2, staged: 0, bookedImported: 2, pendingImported: 0, duplicates: 0, transfersMatched: 0, pendingPromoted: 0, cutoffIgnored: 0, zeroIgnored: 0, futureIgnored: 0 },
  warnings: [],
}

test('automatic bank sync claims each account only once per CET date', async t => {
  const { connections, db } = fixture(t)
  let calls = 0
  const sync = async () => { calls += 1; return summary }
  const now = new Date('2026-09-20T05:00:00.000Z')
  const first = await runAutomaticBankSync(db, sync, now)
  const second = await runAutomaticBankSync(db, sync, now)
  assert.equal(first.results[0].status, 'completed')
  assert.equal(second.results[0].status, 'skipped')
  assert.equal(calls, 1)
  assert.equal(((connections[0].metadata as Row).last_automatic_sync as Row).status, 'completed')
})

test('automatic bank sync records a failure and continues without retrying the same day', async t => {
  const { connections, db } = fixture(t)
  let calls = 0
  const sync = async () => { calls += 1; throw new Error('Bank quota reached') }
  const now = new Date('2026-09-20T05:00:00.000Z')
  const first = await runAutomaticBankSync(db, sync, now)
  const second = await runAutomaticBankSync(db, sync, now)
  assert.equal(first.results[0].status, 'failed')
  assert.equal(first.results[0].error, 'Bank quota reached')
  assert.equal(second.results[0].status, 'skipped')
  assert.equal(calls, 1)
  assert.equal(((connections[0].metadata as Row).last_automatic_sync as Row).status, 'failed')
})

test('automatic bank sync skips disabled, closed, and unconnected accounts', async t => {
  const { db } = fixture(t)
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/accounts')) {
      return Response.json([
        { id: 'disabled', workspace_id: workspaceId, name: 'Disabled', provider_account_id: 'provider', auto_sync: false, closed: false },
        { id: 'closed', workspace_id: workspaceId, name: 'Closed', provider_account_id: 'provider', auto_sync: true, closed: true },
        { id: 'unconnected', workspace_id: workspaceId, name: 'Unconnected', provider_account_id: null, auto_sync: true, closed: false },
      ])
    }
    return original(input, init)
  }
  const result = await runAutomaticBankSync(db, async () => summary, new Date('2026-09-20T05:00:00.000Z'))
  assert.equal(result.eligible, 0)
  assert.deepEqual(result.results, [])
})
