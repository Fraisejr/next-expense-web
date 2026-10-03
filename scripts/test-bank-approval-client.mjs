import assert from 'node:assert/strict'
import { createServer } from 'vite'

const calls = []
let response = { candidateId: 'review', accountId: 'bank', balanceMinor: -100, pendingCount: 0,
  transaction: { id: 'transaction', account_id: 'bank', transaction_date: '2026-10-03', amount_minor: 100, currency: 'EUR', transaction_type: 'expense', payee_id: 'payee', payee: 'Shop', memo: 'Note', posted: false },
  payee: { id: 'payee', name: 'Shop', default_account_id: 'bank', default_category_id: 'category' }, mapping: null, rematched: [],
}
globalThis.__approvalTestNeon = { rpc: async (name, args) => { calls.push({ name, args }); return { data: response, error: null } } }
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', plugins: [{
  name: 'mock-approval-neon', enforce: 'pre',
  resolveId(source, importer) { if (source === './neon' && importer?.endsWith('/src/database.ts')) return '\0approval-neon' },
  load(id) { if (id === '\0approval-neon') return 'export const neon = globalThis.__approvalTestNeon' },
}] })
try {
  const { approveBankReviewItem } = await server.ssrLoadModule('/src/database.ts')
  const result = await approveBankReviewItem('workspace', 'bank', 'review', 'category', { memo: 'Note', rememberMapping: true, setPayeeDefaults: true })
  assert.equal(calls.length, 1, 'approval and all related writes must use one RPC')
  assert.deepEqual(calls[0], { name: 'approve_bank_review_item', args: { p_workspace_id: 'workspace', p_account_id: 'bank', p_candidate_id: 'review', p_category_id: 'category', p_payee_id: null, p_memo: 'Note', p_remember_category: false, p_set_payee_defaults: true, p_remember_mapping: true } })
  assert.equal(result.transaction.note, 'Note')
  assert.equal(result.payee.defaultAccountId, 'bank')
  assert.equal(result.pendingCount, 0)
  response = { ...response, accountId: 'another-account' }
  await assert.rejects(approveBankReviewItem('workspace', 'bank', 'review', 'category', {}), /could not be verified/)
  console.log('Single-request bank approval client and response-validation checks passed.')
} finally { await server.close(); delete globalThis.__approvalTestNeon }
