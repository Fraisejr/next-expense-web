import assert from 'node:assert/strict'
import test from 'node:test'
import { eligibleBankApprovals, createBankApprovalBatch, shouldAutoLoadBankHistory, bankApprovalReview, approveReadyBankRow, bankReviewChoices } from './bank-batch-review.ts'

const candidate = { id: 'one', accountId: 'account', date: '2026-09-24', amountMinor: 1200, currency: 'EUR', type: 'expense' as const, payee: 'Shop', payeeId: 'payee', categoryId: 'category', note: 'original', posted: true }
const options = { accountId: 'account', candidates: [candidate], payees: [{ id: 'payee' }], categories: [{ id: 'category', hidden: false }], transactions: [], choices: {} }

test('payees created in the review picker remain eligible and carry checked defaults/mapping choices', () => {
  const candidates = [{ ...candidate, payeeId: undefined, categoryId: undefined }, { ...candidate, id: 'two', amountMinor: 500, payeeId: undefined, categoryId: undefined }]
  const selections = { payeeAssignments: { one: 'new-one', two: 'new-two' }, categoryAssignments: { one: 'category', two: 'category' },
    memoAssignments: {}, createdPayeeIds: { one: 'new-one', two: 'new-two' }, rememberChoices: {}, mappingChoices: {}, transferCandidateId: '' }
  const choices = bankReviewChoices(candidates, [], selections)
  assert.equal(choices.one.transfer, false)
  const review = bankApprovalReview({ ...options, candidates, choices, payees: [{ id: 'new-one' }, { id: 'new-two' }], historyLoaded: true })
  assert.equal(review.readyRows?.length, 2)
  assert.deepEqual(review.excluded, { missingPayee: 0, missingCategory: 0, ambiguous: 0 })
  for (const row of review.readyRows!) assert.deepEqual([row.rememberCategory, row.rememberMapping, row.setPayeeDefaults], [true, true, true])
  const unchecked = bankReviewChoices(candidates, [], { ...selections, rememberChoices: { one: false }, mappingChoices: { one: false }, transferCandidateId: 'two' })
  assert.equal(unchecked.one.rememberCategory, false)
  assert.equal(unchecked.one.rememberMapping, false)
  assert.equal(unchecked.two.transfer, true)
  assert.equal(eligibleBankApprovals({ ...options, candidates, choices: unchecked, payees: [{ id: 'new-one' }, { id: 'new-two' }] }).length, 1)
})

test('bank account with candidates checks history before showing a ready count, then uses local choices', () => {
  const choices = { one: { payeeId: 'payee', categoryId: 'category' } }
  const pending = { ...options, candidates: [{ ...candidate, payeeId: undefined, categoryId: undefined }], choices }
  assert.equal(shouldAutoLoadBankHistory(true, 1, false), true)
  assert.equal(shouldAutoLoadBankHistory(false, 1, false), false)
  assert.equal(shouldAutoLoadBankHistory(true, 0, false), false)
  assert.equal(shouldAutoLoadBankHistory(true, 1, true), false)
  assert.equal(shouldAutoLoadBankHistory(true, 1, false, true), false)
  assert.equal(bankApprovalReview({ ...pending, historyLoaded: false }).readyRows, null)
  assert.deepEqual(bankApprovalReview({ ...pending, historyLoaded: true }).readyRows?.map(row => row.id), ['one'])
})

test('unposted pending candidate with an existing payee and category is ready after history loads', () => {
  const pending = { ...options, candidates: [{ ...candidate, posted: false }] }
  assert.equal(bankApprovalReview({ ...pending, historyLoaded: false }).readyRows, null)
  assert.deepEqual(bankApprovalReview({ ...pending, historyLoaded: true }), {
    readyRows: [{ id: 'one', accountId: 'account', payeeId: 'payee', categoryId: 'category', memo: 'original' }],
    excluded: { missingPayee: 0, missingCategory: 0, ambiguous: 0 },
  })
})

test('unposted pending candidate uses edited local payee, category, and memo', () => {
  const pending = { ...options, candidates: [{ ...candidate, posted: false, payeeId: undefined, categoryId: undefined }],
    payees: [{ id: 'payee' }, { id: 'edited' }], categories: [{ id: 'category', hidden: false }, { id: 'edited-category', hidden: false }],
    choices: { one: { payeeId: 'edited', categoryId: 'edited-category', memo: 'edited memo' } } }
  assert.deepEqual(bankApprovalReview({ ...pending, historyLoaded: true }).readyRows, [
    { id: 'one', accountId: 'account', payeeId: 'edited', categoryId: 'edited-category', memo: 'edited memo' },
  ])
})

test('only explicitly selected, unambiguous rows on this account are eligible', () => {
  assert.deepEqual(eligibleBankApprovals(options).map(row => row.id), ['one'])
  for (const change of [{ payeeId: 'deleted-payee' }, { categoryId: undefined }, { accountId: 'other' }]) {
    assert.equal(eligibleBankApprovals({ ...options, candidates: [{ ...candidate, ...change }] }).length, 0)
  }
  assert.deepEqual(bankApprovalReview({ ...options, candidates: [{ ...candidate, posted: false, payeeId: undefined, payee: '   ' }], historyLoaded: true }).excluded,
    { missingPayee: 1, missingCategory: 0, ambiguous: 0 })
  assert.equal(eligibleBankApprovals({ ...options, categories: [{ id: 'category', hidden: true }] }).length, 0)
  assert.equal(eligibleBankApprovals({ ...options, payees: [] }).length, 0)
  assert.equal(eligibleBankApprovals({ ...options, choices: { one: { transfer: true } } }).length, 0)
  assert.equal(eligibleBankApprovals({ ...options, transactions: [{ id: 'transfer', accountId: 'account', type: 'transfer', currency: 'EUR', amountMinor: 1200, date: '2026-09-24' }] }).length, 0)
  assert.equal(eligibleBankApprovals({ ...options, transactions: [{ id: 'duplicate', accountId: 'account', type: 'expense', currency: 'EUR', amountMinor: 1200, date: '2026-09-24' }] }).length, 0)
  assert.equal(eligibleBankApprovals({ ...options, candidates: [candidate, { ...candidate, id: 'same-amount' }] }).length, 0)
  assert.equal(eligibleBankApprovals({ ...options, candidates: [{ ...candidate, transactionId: 'provisional' }], transactions: [{ id: 'provisional', accountId: 'account', type: 'expense', currency: 'EUR', amountMinor: 1200, date: '2026-09-24' }] }).length, 1)
})

test('category without a selected payee is ready for payee creation, including unposted rows', () => {
  const pending = { ...options, candidates: [{ ...candidate, posted: false }], choices: { one: { payeeId: '', categoryId: 'category', memo: 'edited memo' } } }
  assert.deepEqual(bankApprovalReview({ ...pending, historyLoaded: true }), {
    readyRows: [{ id: 'one', accountId: 'account', payeeId: '', payeeName: 'Shop', categoryId: 'category', memo: 'edited memo' }],
    excluded: { missingPayee: 0, missingCategory: 0, ambiguous: 0 },
  })
  assert.equal(eligibleBankApprovals({ ...pending, categories: [{ id: 'category', hidden: true }] }).length, 0)
  assert.equal(eligibleBankApprovals({ ...pending, choices: { one: { payeeId: '', categoryId: '' } } }).length, 0)
  assert.equal(eligibleBankApprovals({ ...pending, transactions: [{ id: 'duplicate', accountId: 'account', type: 'expense', currency: 'EUR', amountMinor: 1200, date: '2026-09-24' }] }).length, 0)
})

test('bulk approval resolves the bank description to a payee before posting, preserving edits and account scope', async () => {
  const rows = eligibleBankApprovals({ ...options, candidates: [{ ...candidate, payeeId: undefined }], choices: { one: { memo: 'edited memo' } } })
  const calls: unknown[][] = []
  await approveReadyBankRow('workspace', rows[0], {
    ensurePayees: async (...args) => { calls.push(['payee', ...args]); return [{ id: 'created', name: 'Shop' }] },
    updateBankImportCandidateDetails: async (...args) => { calls.push(['details', ...args]) },
    approveBankImportCandidate: async (...args) => { calls.push(['approve', ...args]); return 'transaction' },
  })
  assert.deepEqual(calls, [
    ['payee', 'workspace', ['Shop']],
    ['details', 'workspace', 'one', 'created', 'edited memo', 'account'],
    ['approve', 'workspace', 'one', 'category', false],
  ])
})

test('payee creation failure prevents posting and does not stop other rows', async () => {
  const rows = eligibleBankApprovals({ ...options, candidates: [{ ...candidate, payeeId: undefined }, { ...candidate, id: 'two', amountMinor: 1300 }] })
  const approved: string[] = []
  const services = {
    ensurePayees: async () => { throw new Error('Could not create payee') },
    updateBankImportCandidateDetails: async () => {},
    approveBankImportCandidate: async (_workspaceId: string, id: string) => { approved.push(id); return 'transaction' },
  }
  const result = await createBankApprovalBatch(row => approveReadyBankRow('workspace', row, services)).run(rows)
  assert.deepEqual(approved, ['two'])
  assert.deepEqual(result, { approved: 1, failed: 1, skipped: 0, errors: ['one: Could not create payee'] })
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
