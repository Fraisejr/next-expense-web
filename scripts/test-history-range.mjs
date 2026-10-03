import assert from 'node:assert/strict'
import { createServer } from 'vite'

const calls = []
let revision = 12
let mutate = false
const stored = new Map()
globalThis.indexedDB = {
  open: () => {
    const request = { result: {
      close() {},
      transaction: () => {
        const transaction = { objectStore: () => ({
          get(key) { const result = { result: stored.get(key) }; queueMicrotask(() => transaction.oncomplete()); return result },
          put(value, key) { stored.set(key, value); const result = { result: key }; queueMicrotask(() => transaction.oncomplete()); return result },
          delete(key) { stored.delete(key); const result = { result: undefined }; queueMicrotask(() => transaction.oncomplete()); return result },
        }) }
        return transaction
      },
    } }
    queueMicrotask(() => request.onsuccess())
    return request
  },
}
globalThis.__historyTestNeon = {
  rpc: async (name, args) => {
    calls.push({ name, args })
    if (name === 'workspace_transaction_revision') return { data: revision, error: null }
    assert.equal(name, 'list_workspace_transactions')
    if (mutate) { revision++; mutate = false }
    const total = args.p_account_id ? 1001 : 1
    const count = Math.min(1000, total - args.p_offset)
    return { error: null, data: Array.from({ length: count }, (_, index) => ({
      id: String(args.p_offset + index), total_count: total, account_id: 'bank',
      transaction_date: '2026-10-01', amount_minor: 10, currency: 'EUR', transaction_type: 'expense',
    })) }
  },
}
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', plugins: [{
  name: 'mock-history-neon', enforce: 'pre',
  resolveId(source, importer) { if (source === './neon' && importer?.endsWith('/src/database.ts')) return '\0history-neon' },
  load(id) { if (id === '\0history-neon') return 'export const neon = globalThis.__historyTestNeon' },
}] })
try {
  const { loadTransactionRange, loadCachedAllTransactions } = await server.ssrLoadModule('/src/database.ts')
  const rows = await loadTransactionRange('workspace', { accountId: 'bank', startDate: '2026-09-28', endDate: '2026-10-07' })
  assert.equal(rows.length, 1001)
  assert.deepEqual(calls.map(({ args }) => args.p_offset), [0, 1000])
  for (const { args } of calls) {
    assert.equal(args.p_account_id, 'bank')
    assert.equal(args.p_start_date, '2026-09-28')
    assert.equal(args.p_end_date, '2026-10-07')
  }
  calls.length = 0
  mutate = true
  await loadCachedAllTransactions('workspace')
  assert.equal(calls.filter(({ name }) => name === 'list_workspace_transactions').length, 2, 'overlapping write must trigger a fresh download')
  assert.equal(calls.filter(({ name }) => name === 'workspace_transaction_revision').length, 3)
  await new Promise((resolve) => setTimeout(resolve, 0))
  stored.get('workspace').savedAt = Date.now() - 2 * 60 * 60 * 1000
  calls.length = 0
  await loadCachedAllTransactions('workspace')
  assert.equal(calls.filter(({ name }) => name === 'list_workspace_transactions').length, 0, 'unchanged history older than an hour must stay cached')
  revision++
  calls.length = 0
  await loadCachedAllTransactions('workspace')
  assert.equal(calls.filter(({ name }) => name === 'list_workspace_transactions').length, 1, 'transaction revision changes invalidate cached history')
  console.log('History range pagination and revision integration checks passed.')
} finally { await server.close(); delete globalThis.__historyTestNeon; delete globalThis.indexedDB }
