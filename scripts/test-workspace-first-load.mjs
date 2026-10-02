import assert from 'node:assert/strict'
import { createServer } from 'vite'

let scenario
const candidate = (id) => ({ id, account_id: 'account', transaction_date: '2026-10-01', amount_minor: 100,
  currency: 'EUR', transaction_type: 'expense', payee_name: 'Store', posted: true, status: 'pending' })
const baseRows = {
  workspace_members: [{ workspace_id: 'workspace' }],
  workspaces: [{ id: 'workspace', name: 'Workspace', default_currency: 'EUR', estimated_company_tax_rate_bps: 0 }],
  accounts: [{ id: 'account', name: 'Bank', display_type: 'checking', scope: 'Personal', currency: 'EUR', color: '#123456', provider_account_id: 'linked' }],
  bank_connections: [{ id: 'connection', account_id: 'account', status: 'active', metadata: {} }],
  payees: [{ id: 'payee', name: 'Store', sort_order: 1 }],
  categories: [{ id: 'category', name: 'Shopping', sort_order: 1, report_group: 'expense' }],
  time_codes: [{ id: 'code', name: 'Work', sort_order: 1 }],
}

function query(table) {
  const state = { count: false, accountId: null }
  const builder = {
    select(_columns, options) { state.count = options?.count === 'exact'; return builder },
    eq(column, value) { if (column === 'account_id') state.accountId = value; return builder }, order() { return builder }, limit() { return builder },
    range(start, end) {
      scenario.tableReads[table] = (scenario.tableReads[table] ?? 0) + 1
      const data = scenario.tableReads[table] <= (scenario.emptyTableReads?.[table] ?? 0) ? []
        : scenario.partialTableReads?.[table] && scenario.tableReads[table] <= scenario.partialTableReads[table].attempts
          ? (scenario.rows[table] ?? []).slice(0, scenario.partialTableReads[table].length)
          : (scenario.rows[table] ?? [])
      return Promise.resolve({ data: data.slice(start, end + 1), error: null })
    },
    then(resolve, reject) {
      let data = scenario.rows[table] ?? []
      if (state.count) return Promise.resolve({ data: null, count: table === 'bank_import_candidates' ? (scenario.pendingCount === null ? null : state.accountId ? (scenario.pendingCount === 0 ? 0 : scenario.pendingRows.filter((row) => row.account_id === state.accountId).length) : scenario.pendingCount) : (scenario.counts && Object.hasOwn(scenario.counts, table) ? scenario.counts[table] : data.length), error: null }).then(resolve, reject)
      if (table === 'bank_import_candidates') {
        scenario.candidateReads++
        data = scenario.candidateReads <= scenario.emptyCandidateReads ? []
          : scenario.candidateReads <= (scenario.partialCandidateReads ?? 0) ? scenario.pendingRows.slice(0, 1) : scenario.pendingRows
      }
      return Promise.resolve({ data, error: null }).then(resolve, reject)
    },
  }
  return builder
}
const neon = {
  from: query,
  rpc(name) {
    const data = name === 'workspace_snapshot_revision' ? (scenario.revision ?? 79)
      : name === 'workspace_account_balances' ? (scenario.rows.accounts ?? []).map((account) => ({ account_id: account.id, balance_minor: 0 }))
        : []
    return Promise.resolve({ data, error: null })
  },
  auth: { getSession: async () => ({ data: { user: { id: 'alice' } }, error: null }) },
}
globalThis.__workspaceTestNeon = neon
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', plugins: [{
  name: 'mock-workspace-neon', enforce: 'pre',
  resolveId(source, importer) {
    if (source === './neon' && importer?.replaceAll('\\', '/').endsWith('/src/database.ts')) return '\0mock-workspace-neon'
  },
  load(id) { if (id === '\0mock-workspace-neon') return 'export const neon = globalThis.__workspaceTestNeon' },
}] })
try {
  const { loadWorkspace } = await server.ssrLoadModule('/src/database.ts')
  const reset = (overrides = {}) => { scenario = { rows: { ...baseRows }, pendingRows: [candidate('one'), candidate('two'), candidate('three')], pendingCount: 3, emptyCandidateReads: 0, candidateReads: 0, tableReads: {}, ...overrides } }

  reset({ partialCandidateReads: 99 })
  await assert.rejects(loadWorkspace('2026-10'), /incomplete|candidate|rows/i, 'first load with one of three pending rows must fail after retries')

  reset({ emptyCandidateReads: 1 })
  const recovered = await loadWorkspace('2026-10')
  assert.equal(recovered.data.bankImportCandidates.length, 3, 'first load must recover when row read is empty but independent count sees three pending rows')
  assert.ok(scenario.candidateReads >= 2, 'actual loader must retry the candidate read')

  reset({ emptyTableReads: { bank_connections: 1, time_codes: 1 } })
  const recoveredConnection = await loadWorkspace('2026-10')
  assert.equal(recoveredConnection.data.accounts[0].providerAccountId, 'linked', 'first load recovers a transiently empty connection read')
  assert.equal(recoveredConnection.data.timeCodes.length, 1, 'first load recovers a transiently empty time-code read')

  reset({ rows: { ...baseRows, accounts: [] }, counts: { accounts: 38 } })
  await assert.rejects(loadWorkspace('2026-10'), /incomplete|rows/i, 'first load must reject empty accounts and matching empty balance RPC when the account count is 38')

  reset({ rows: { ...baseRows, bank_connections: [baseRows.bank_connections[0], { id: 'second', account_id: 'other' }, { id: 'third', account_id: 'third' }] }, partialTableReads: { bank_connections: { attempts: 99, length: 1 } } })
  await assert.rejects(loadWorkspace('2026-10'), /incomplete|rows/i, 'first load must reject one of three bank connections')

  reset({ rows: { ...baseRows, time_codes: Array.from({ length: 8 }, (_, index) => ({ id: `code-${index}`, name: `Code ${index}`, sort_order: index })) }, partialTableReads: { time_codes: { attempts: 99, length: 2 } } })
  await assert.rejects(loadWorkspace('2026-10'), /incomplete|rows/i, 'first load must reject two of eight time codes')

  reset({ rows: { ...baseRows, bank_connections: [], time_codes: [] } })
  await assert.rejects(loadWorkspace('2026-10', recovered), /fewer rows|incomplete|previously populated/, 'same-revision connection and time-code loss must not replace the prior snapshot')

  reset({ revision: 80, rows: { ...baseRows, time_codes: [] } })
  await assert.rejects(loadWorkspace('2026-10', recovered), /fewer rows|incomplete|previously populated/, 'a revision change cannot replace known time codes with an empty read')

  reset({ revision: 80, rows: { ...baseRows, accounts: [] } })
  await assert.rejects(loadWorkspace('2026-10', recovered), /fewer rows|incomplete|previously populated/, 'a revision change cannot replace known accounts with an empty read and empty balance RPC')

  reset({ revision: 80, pendingRows: [], pendingCount: 0 })
  const deleted = await loadWorkspace('2026-10', recovered)
  assert.equal(deleted.data.bankImportCandidates.length, 0, 'a revision-advanced queue deletion is displayed')
  assert.equal(deleted.candidateQueueByAccount.account, 'empty', 'a twice-read zero is shown as checked empty')

  reset({ rows: { ...baseRows, payees: [] } })
  await assert.rejects(loadWorkspace('2026-10'), /Payees|payees|incomplete/, 'single missing payee register must not enter the cache')
  reset({ rows: { ...baseRows, categories: [] } })
  await assert.rejects(loadWorkspace('2026-10'), /categories|incomplete/, 'single missing category register must not enter the cache')

  reset({ pendingRows: [], pendingCount: 0 })
  const empty = await loadWorkspace('2026-10')
  assert.equal(empty.data.bankImportCandidates.length, 0, 'a genuinely empty queue must finish without infinite retries')
  assert.equal(empty.candidateQueueByAccount.account, 'empty', 'successful zero reads leave a usable empty state')
  assert.equal(scenario.candidateReads, 2, 'first load rechecks the empty row query')

  reset({ emptyCandidateReads: 99, pendingCount: 0 })
  const hidden = await loadWorkspace('2026-10')
  assert.equal(hidden.candidateQueueByAccount.account, 'empty', 'two RLS-filtered reads still look empty to the user')
  assert.equal(scenario.candidateReads, 2, 'the bounded recheck makes exactly one extra row read')

  reset({ rows: { ...baseRows, accounts: [...baseRows.accounts, { ...baseRows.accounts[0], id: 'other', provider_account_id: 'other-linked' }], bank_connections: [...baseRows.bank_connections, { id: 'other-connection', account_id: 'other', status: 'active', metadata: {} }] }, pendingRows: [candidate('one')], pendingCount: 1 })
  const mixed = await loadWorkspace('2026-10')
  assert.equal(mixed.candidateQueueByAccount.account, 'pending')
  assert.equal(mixed.candidateQueueByAccount.other, 'empty', 'another account with pending rows does not verify this empty account')

  reset({ revision: 80, rows: { ...baseRows, payees: [], categories: [] } })
  await assert.rejects(loadWorkspace('2026-10', recovered), /payee|categor|incomplete|fewer|previously populated/i, 'revision advance cannot confirm deletion of previously populated registers')

  reset({ rows: { ...baseRows, payees: [baseRows.payees[0]] }, counts: { payees: 3 } })
  await assert.rejects(loadWorkspace('2026-10'), /incomplete|could not be read completely/i, 'nonempty partial register must fail when independent count differs')

  reset({ pendingCount: null })
  const uncounted = await loadWorkspace('2026-10')
  assert.equal(uncounted.snapshotCountsAuthoritative, false, 'null candidate count prevents caching even with visible rows')

  for (const table of ['accounts', 'bank_connections', 'time_codes']) {
    reset({ counts: { [table]: null } })
    const uncountedRows = await loadWorkspace('2026-10')
    assert.equal(uncountedRows.snapshotCountsAuthoritative, false, `null ${table} count prevents caching`)
  }

  reset({ rows: { ...baseRows, bank_connections: [], time_codes: [] }, pendingRows: [], pendingCount: 0 })
  const ambiguousZeros = await loadWorkspace('2026-10')
  assert.equal(ambiguousZeros.snapshotCountsAuthoritative, false, 'zero auxiliary rows and counts in a populated workspace remain non-authoritative')

  reset({ rows: { ...baseRows, accounts: [], bank_connections: [], payees: [], categories: [], time_codes: [] }, pendingRows: [], pendingCount: 0 })
  neon.rpc = (name) => Promise.resolve({ data: name === 'workspace_snapshot_revision' ? 1 : [], error: null })
  const newWorkspace = await loadWorkspace('2026-10')
  assert.equal(newWorkspace.data.accounts.length, 0, 'an empty new workspace remains valid')
  assert.equal(newWorkspace.snapshotCountsAuthoritative, false, 'an empty workspace remains usable but cannot become an authoritative cache')
  console.log('Workspace first-load safeguards passed')
} finally {
  await server.close()
  delete globalThis.__workspaceTestNeon
}
