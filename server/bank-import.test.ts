import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createGoCardlessHandler } from './gocardless.ts'
import { bankReference } from './bank-authorization.ts'
import { bankClient, acquireSyncLease } from './bank-sync.ts'

const workspace = '10000000-0000-0000-0000-000000000001'
const account = '10000000-0000-0000-0000-000000000002'
const provider = '10000000-0000-0000-0000-000000000003'
const requisition = '10000000-0000-0000-0000-000000000004'
const config = { dataApiUrl: 'https://data.example/rest/v1', appUrl: 'https://expense.example' }
type Row = Record<string, unknown>
const transaction = (id: string, amount = '-12.34') => ({ internalTransactionId: id, bookingDate: '2026-09-13', transactionAmount: { amount, currency: 'SEK' }, creditorName: 'Market', remittanceInformationUnstructured: 'Card purchase' })

function fixture(t: TestContext) {
  const db: Record<string, Row[]> = {
    workspace_members: [{ workspace_id: workspace }],
    accounts: [{ id: account, workspace_id: workspace, provider_account_id: provider, currency: 'SEK', bank_import_mode: 'review', closed: false }],
    bank_connections: [{ id: requisition, workspace_id: workspace, account_id: account, provider: 'gocardless_bank_account_data', provider_connection_id: requisition, status: 'active', metadata: {}, updated_at: 'version-0' }],
    bank_import_candidates: [], bank_transaction_refs: [], transactions: [], bank_account_aliases: [], payees: [], payee_mappings: [], categories: [], periods: [],
  }
  const state = { booked: [transaction('new')], transactionsFail: false, writesFail: false, candidateInsertRace: false, providerCalls: 0, queries: [] as URL[] }
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.host === 'data.example') {
      state.queries.push(url)
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-jwt')
      assert.equal(new Headers(init?.headers).get('Cookie'), null)
      const table = url.pathname.split('/').pop()!
      assert.ok(table in db, table)
      if (init?.method !== 'POST') assert.equal(url.searchParams.get('workspace_id'), `eq.${workspace}`)
      const matches = db[table].filter(row => [...url.searchParams].every(([column, expression]) => {
        if (expression.startsWith('eq.')) return (typeof row[column] === 'object' ? JSON.stringify(row[column]) : String(row[column])) === expression.slice(3)
        if (expression === 'is.null') return row[column] == null
        return true
      }))
      const method = init?.method ?? 'GET'
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body))
        matches.forEach(row => Object.assign(row, body, { updated_at: `${row.updated_at ?? ""}-next` }))
        return Response.json(matches)
      }
      if (method === 'POST') {
        if (state.writesFail && table === 'bank_import_candidates') return Response.json({ message: 'Fixture write failure' }, { status: 500 })
        const body = JSON.parse(String(init?.body)); const rows = Array.isArray(body) ? body : [body]
        for (const row of rows) assert.equal(row.workspace_id, workspace)
        if (table === 'bank_import_candidates') {
          if (state.candidateInsertRace) {
            state.candidateInsertRace = false
            db[table].push({ ...rows[0], id: 'concurrent-candidate' })
            return Response.json({ code: '23505', message: 'duplicate key value violates unique constraint "bank_import_candidates_provider_id_idx"' }, { status: 409 })
          }
          const duplicate = rows.some(row => db[table].some(existing => existing.workspace_id === row.workspace_id
            && existing.account_id === row.account_id && existing.provider === row.provider
            && ((row.provider_transaction_id && existing.provider_transaction_id === row.provider_transaction_id)
              || (row.bank_transaction_id && existing.bank_transaction_id === row.bank_transaction_id))))
          if (duplicate) return Response.json({ code: '23505', message: 'duplicate key value violates unique constraint "bank_import_candidates_provider_id_idx"' }, { status: 409 })
        }
        db[table].push(...rows)
        return Response.json(null)
      }
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 1000)
      return Response.json(matches.slice(offset, offset + limit))
    }
    if (url.pathname.endsWith('/token/new/')) return Response.json({ access: 'provider-token', access_expires: 3600 })
    if (url.pathname.includes('/requisitions/')) return Response.json({ reference: bankReference(workspace, account, 'test-key'), accounts: [provider] })
    if (url.pathname.endsWith('/transactions/')) {
      state.providerCalls++
      assert.equal(url.pathname, `/api/v2/accounts/${provider}/transactions/`)
      assert.equal(url.searchParams.get('date_from') === '1900-01-01', false, 'client cannot select the import window')
      if (state.transactionsFail) return Response.json({ detail: 'Bank quota reached' }, { status: 429 })
      return Response.json({ transactions: { booked: state.booked, pending: [] } })
    }
    if (url.pathname.endsWith('/balances/')) return Response.json({ balances: [{ balanceType: 'interimAvailable', balanceAmount: { amount: '100.00', currency: 'SEK' } }] })
    throw new Error(`Unexpected request ${url}`)
  }
  t.after(() => { globalThis.fetch = original })
  async function sync() {
    const request = Readable.from([JSON.stringify({ workspaceId: workspace, accountId: account, providerAccountId: requisition, dateFrom: '1900-01-01', bankImportMode: 'automatic' })]) as IncomingMessage
    request.method = 'POST'; request.url = '/api/gocardless/sync-import'; request.headers = { authorization: 'Bearer test-jwt' }
    let status = 0; let body: Row = {}
    const response = { set statusCode(value: number) { status = value }, setHeader() {}, end(value: string) { body = JSON.parse(value) } } as unknown as ServerResponse
    await createGoCardlessHandler('test-id', 'test-key', config)(request, response)
    return { status, body }
  }
  return { db, state, sync }
}

test('native endpoint persists review imports and balances, and repeat syncs do not duplicate them', async t => {
  const { db, state, sync } = fixture(t)
  const first = await sync()
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal((first.body.diagnostic as Row).staged, 1)
  assert.equal(db.bank_import_candidates.length, 1)
  assert.equal(db.bank_import_candidates[0].bank_memo, 'Card purchase')
  assert.equal(db.bank_import_candidates[0].memo, null)
  assert.equal(db.transactions.length, 0, 'server-read review mode overrides client')
  assert.equal((db.bank_connections[0].metadata as Row).sync_lease, undefined)
  assert.equal(((db.bank_connections[0].metadata as Row).bank_balance as Row).amount_minor, 10000)
  assert.equal((await sync()).status, 200)
  assert.equal(db.bank_import_candidates.length, 1)
  assert.equal(state.providerCalls, 2)
})

test('daily sync rematches an existing pending candidate when its bank description changes', async t => {
  const { db, state, sync } = fixture(t)
  assert.equal((await sync()).status, 200)
  assert.equal(db.bank_import_candidates[0].payee_id, null)

  db.payees.push({ id: 'glovo', workspace_id: workspace, name: 'Glovo', default_category_id: 'food' })
  db.payee_mappings.push({ id: 'glovo-prefix', workspace_id: workspace, normalized_name: 'glovo', payee_id: 'glovo', match_type: 'starts_with' })
  state.booked = [{ ...transaction('new'), creditorName: 'Glovo 24sep B4g1rliq' }]

  assert.equal((await sync()).status, 200)
  assert.equal(db.bank_import_candidates.length, 1)
  assert.equal(db.bank_import_candidates[0].payee_name, 'Glovo 24sep B4g1rliq')
  assert.equal(db.bank_import_candidates[0].payee_id, 'glovo')
  assert.equal(db.bank_import_candidates[0].category_id, 'food')
})

test('a fresh review import finds a starts-with mapping after hundreds of earlier rows', async t => {
  const { db, state, sync } = fixture(t)
  for (let index = 0; index < 820; index++) {
    db.payees.push({ id: `payee-${index}`, workspace_id: workspace, name: `Other ${index}` })
    db.payee_mappings.push({ id: `mapping-${index}`, workspace_id: workspace, normalized_name: `other ${index}`, payee_id: `payee-${index}`, match_type: 'exact' })
  }
  db.payees.push({ id: 'glovo', workspace_id: workspace, name: 'Glovo' })
  db.payee_mappings.push({ id: 'glovo-prefix', workspace_id: workspace, normalized_name: 'glovo', payee_id: 'glovo', match_type: 'starts_with' })
  state.booked = [{ ...transaction('glovo-new'), creditorName: 'Glovo 24sep B4q1rljq' }]

  assert.equal((await sync()).status, 200)
  assert.equal(db.bank_import_candidates[0].payee_id, 'glovo')
})

test('a candidate inserted by an overlapping sync is treated as a duplicate', async t => {
  const { db, state, sync } = fixture(t)
  state.candidateInsertRace = true
  const result = await sync()
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal((result.body.diagnostic as Row).staged, 0)
  assert.equal((result.body.diagnostic as Row).duplicates, 1)
  assert.equal(db.bank_import_candidates.length, 1)
  assert.equal(db.bank_import_candidates[0].provider_transaction_id, 'new')
})

test('past matches, manual rejections and zero decisions survive a server sync', async t => {
  const { db, state, sync } = fixture(t)
  db.bank_transaction_refs.push({ id: 'ref', workspace_id: workspace, account_id: account, provider: 'gocardless_bank_account_data', provider_transaction_id: 'matched', transaction_id: 'ledger' })
  db.bank_import_candidates.push({ id: 'rejected', workspace_id: workspace, account_id: account, provider: 'gocardless_bank_account_data', provider_transaction_id: 'rejected', status: 'rejected' })
  state.booked = [transaction('matched'), transaction('rejected'), transaction('zero', '0')]
  assert.equal((await sync()).status, 200)
  assert.equal(db.bank_import_candidates.length, 2)
  const zero = db.bank_import_candidates.find(row => row.provider_transaction_id === 'zero')!
  assert.equal(zero.status, 'rejected'); assert.equal(zero.decision_reason, 'zero_amount')
  state.booked = [transaction('zero', '-1')]
  assert.equal((await sync()).status, 200)
  assert.equal(zero.status, 'pending'); assert.equal(zero.decision_reason, null)
  assert.equal(db.bank_import_candidates.length, 2)
})

test('history is paginated beyond the Data API limit', async t => {
  const { db, state, sync } = fixture(t)
  db.bank_transaction_refs = Array.from({ length: 1101 }, (_, id) => ({ id: String(id), workspace_id: workspace, account_id: account, provider: 'gocardless_bank_account_data', provider_transaction_id: `old-${id}` }))
  state.booked = [transaction('old-1100')]
  assert.equal((await sync()).status, 200)
  assert.equal(db.bank_import_candidates.length, 0)
})

test('automatic accounts import with a known category on the server', async t => {
  const { db, sync } = fixture(t)
  db.accounts[0].bank_import_mode = 'automatic'
  db.payees.push({ id: 'payee', workspace_id: workspace, name: 'Market', default_category_id: 'food' })
  db.categories.push({ id: 'food', workspace_id: workspace, hidden: false })
  assert.equal((await sync()).status, 200)
  assert.equal(db.transactions.length, 1)
  assert.equal(db.transactions[0].category_id, 'food')
  assert.equal(db.transactions[0].bank_memo, 'Card purchase')
  assert.equal(db.transactions[0].memo, null)
  assert.equal(db.periods.length, 1)
  assert.equal(db.bank_import_candidates.length, 0)
})

test('partial bank failure still saves the balance and reports a warning', async t => {
  const { db, state, sync } = fixture(t); state.transactionsFail = true
  const result = await sync()
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.warnings, ['Bank quota reached'])
  assert.ok((db.bank_connections[0].metadata as Row).bank_balance)
})

test('import failure releases the lease and does not claim success', async t => {
  const { db, state, sync } = fixture(t); state.writesFail = true
  assert.equal((await sync()).status, 500)
  assert.equal((db.bank_connections[0].metadata as Row).sync_lease, undefined)
  assert.equal(db.bank_connections[0].last_synced_at, undefined)
})

test('database compare-and-swap permits only one concurrent sync lease', async t => {
  const { state, sync } = fixture(t)
  const db = bankClient(config.dataApiUrl, 'Bearer test-jwt')
  const leases = await Promise.allSettled([acquireSyncLease(db, workspace, account), acquireSyncLease(db, workspace, account)])
  assert.equal(leases.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal((await sync()).status, 409)
  assert.equal(state.providerCalls, 0)
  for (const lease of leases) if (lease.status === 'fulfilled') await lease.value()
  assert.equal((await sync()).status, 200)
})
