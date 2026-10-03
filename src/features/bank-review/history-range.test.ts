import assert from 'node:assert/strict'
import test from 'node:test'
import { bankReviewHistoryRange } from './history-range.ts'

test('review includes three days around every candidate, even imports older than 30 days', () => {
  assert.deepEqual(bankReviewHistoryRange('bank', [
    { accountId: 'bank', date: '2026-10-03' }, { accountId: 'bank', date: '2026-01-01' },
    { accountId: 'other', date: '2020-01-01' },
  ]), { accountId: 'bank', startDate: '2025-12-29', endDate: '2026-10-07' })
})

test('leap-day boundaries use an exclusive end; empty accounts need no query', () => {
  assert.deepEqual(bankReviewHistoryRange('bank', [{ accountId: 'bank', date: '2024-03-01' }]),
    { accountId: 'bank', startDate: '2024-02-27', endDate: '2024-03-05' })
  assert.equal(bankReviewHistoryRange('bank', [{ accountId: 'other', date: '2026-10-03' }]), null)
})
