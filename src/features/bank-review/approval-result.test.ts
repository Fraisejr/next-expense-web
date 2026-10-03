import assert from 'node:assert/strict'
import test from 'node:test'
import { applyBankApproval, type BankApprovalResult } from './approval-result.ts'
import type { AppData } from '../../types'

const result: BankApprovalResult = {
  candidateId: 'review', accountId: 'bank', balanceMinor: 800, pendingCount: 1,
  transaction: { id: 'transaction', accountId: 'bank', date: '2026-10-03', amountMinor: 200, currency: 'EUR', type: 'expense', payee: 'Shop', payeeId: 'payee', categoryId: 'shopping', note: 'My memo' },
  payee: { id: 'payee', name: 'Shop', defaultCategoryId: 'shopping', defaultAccountId: 'bank' },
  mapping: { id: 'mapping', sourceName: 'Shop bank description', payeeId: 'payee', matchType: 'exact' },
  rematched: [{ id: 'next', payeeId: 'payee', categoryId: 'shopping' }],
}
const fixture = (): AppData => ({ accounts: [{ id: 'bank', balanceMinor: 1000 }, { id: 'other', balanceMinor: 500 }],
  transactions: [], payees: [{ id: 'existing', name: 'Existing' }], payeeMappings: [], unusedPayeeIds: ['payee', 'existing'],
  bankImportCandidates: [{ id: 'review', accountId: 'bank' }, { id: 'next', accountId: 'bank' }, { id: 'other', accountId: 'other' }],
} as unknown as AppData)

test('confirmed approval updates the row, balance, defaults and rematches while preserving other accounts', () => {
  const current = fixture()
  const next = applyBankApproval(current, result, '2026-10', false)
  assert.equal(current.bankImportCandidates.length, 3)
  assert.deepEqual(next.transactions, [result.transaction])
  assert.equal(next.accounts[0].balanceMinor, 800)
  assert.equal(next.accounts[1], current.accounts[1])
  assert.deepEqual(next.bankImportCandidates.map((candidate) => candidate.id), ['next', 'other'])
  assert.equal(next.bankImportCandidates[0].payeeId, 'payee')
  assert.deepEqual(next.payeeMappings, [result.mapping])
  assert.deepEqual(next.unusedPayeeIds, ['existing'])
})

test('replayed responses cannot duplicate transactions, payees or mappings', () => {
  const once = applyBankApproval(fixture(), result, '2026-10', true)
  assert.deepEqual(applyBankApproval(once, result, '2026-10', true), once)
})

test('approving an older import updates its balance without contaminating the selected month', () => {
  assert.equal(applyBankApproval(fixture(), result, '2026-11', false).transactions.length, 0)
  assert.equal(applyBankApproval(fixture(), result, '2026-11', true).transactions.length, 1)
})

test('server transaction replaces a linked pending ledger row instead of adding another', () => {
  const current = fixture()
  current.transactions = [{ ...result.transaction, amountMinor: 99 }]
  assert.deepEqual(applyBankApproval(current, result, '2026-10', true).transactions, [result.transaction])
})
