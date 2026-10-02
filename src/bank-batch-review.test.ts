import assert from 'node:assert/strict'
import test from 'node:test'
import { eligibleBankApprovals, createBankApprovalBatch } from './bank-batch-review.ts'

const candidate = { id: 'one', accountId: 'account', date: '2026-09-24', amountMinor: 1200, currency: 'EUR', type: 'expense' as const, payee: 'Shop', payeeId: 'payee', categoryId: 'category', note: 'original', posted: true }
const options = { accountId: 'account', candidates: [candidate], payees: [{ id: 'payee' }], categories: [{ id: 'category', hidden: false }], transactions: [], choices: {} }

test('only explicitly selected, posted, unambiguous rows are eligible', () => {
  assert.deepEqual(eligibleBankApprovals(options).map(row => row.id), ['one'])
  for (const change of [{ posted: false }, { payeeId: undefined }, { categoryId: undefined }, { accountId: 'other' }]) {
    assert.equal(eligibleBankApprovals({ ...options, candidates: [{ ...candidate, ...change }] }).length, 0)
  }
  assert.equal(eligibleBankApprovals({ ...options, categories: [{ id: 'category', hidden: true }] }).length, 0)
  assert.equal(eligibleBankApprovals({ ...options, payees: [] }).length, 0)
  assert.equal(eligibleBankApprovals({ ...options, choices: { one: { transfer: true } } }).length, 0)
  assert.equal(eligibleBankApprovals({ ...options, transactions: [{ id: 'transfer', accountId: 'account', type: 'transfer', currency: 'EUR', amountMinor: 1200, date: '2026-09-24' }] }).length, 0)
  assert.equal(eligibleBankApprovals({ ...options, transactions: [{ id: 'duplicate', accountId: 'account', type: 'expense', currency: 'EUR', amountMinor: 1200, date: '2026-09-24' }] }).length, 0)
  assert.equal(eligibleBankApprovals({ ...options, candidates: [candidate, { ...candidate, id: 'same-amount' }] }).length, 0)
  assert.equal(eligibleBankApprovals({ ...options, candidates: [{ ...candidate, transactionId: 'provisional' }], transactions: [{ id: 'provisional', accountId: 'account', type: 'expense', currency: 'EUR', amountMinor: 1200, date: '2026-09-24' }] }).length, 1)
})

test('batch uses edited choices, skips stale rows, reports partial failures, and guards double submit', async () => {
  const rows = eligibleBankApprovals({ ...options, candidates: [candidate, { ...candidate, id: 'two', amountMinor: 1300 }, { ...candidate, id: 'three', amountMinor: 1400 }], choices: { one: { payeeId: 'edited', categoryId: 'edited-category', memo: 'edited memo' } }, payees: [{ id: 'payee' }, { id: 'edited' }], categories: [{ id: 'category', hidden: false }, { id: 'edited-category', hidden: false }] })
  const calls: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const batch = createBankApprovalBatch(async row => { calls.push(`${row.id}:${row.payeeId}:${row.categoryId}:${row.memo}`); await gate; if (row.id === 'three') throw new Error('stale') })
  const first = batch.run(rows, row => row.id !== 'two')
  assert.equal(await batch.run(rows), null)
  release()
  assert.deepEqual(await first, { approved: 1, failed: 1, skipped: 1, errors: ['three: stale'] })
  assert.deepEqual(calls, ['one:edited:edited-category:edited memo', 'three:payee:category:original'])
  assert.deepEqual(await batch.run([]), { approved: 0, failed: 0, skipped: 0, errors: [] })
  assert.equal(calls.length, 2)
})
