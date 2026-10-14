import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AppData, Transaction } from './types.ts'
import { removeTransaction } from './transaction-deletion.ts'

function setup(overrides: Partial<Parameters<typeof removeTransaction>[1]> = {}, type: Transaction['type'] = 'expense') {
  const transaction = { id: 't1', date: '2026-10-14', type } as Transaction
  let data = { transactions: [transaction, { id: 't2' }], accounts: [{ id: 'a1', balanceMinor: 100 }, { id: 'a2', balanceMinor: 200 }] } as AppData
  const refreshed = { ...data, transactions: [{ id: 't2' } as Transaction], accounts: [{ ...data.accounts[0], balanceMinor: 300 }, { ...data.accounts[1], balanceMinor: 400 }] }
  const calls: string[] = []
  const errors: string[] = []
  const services: Parameters<typeof removeTransaction>[1] = {
    deleteTransaction: async () => { calls.push('delete') },
    clearTransactionCache: async () => { calls.push('clear') },
    invalidateTransactionMonth: (date) => { calls.push(date) },
    setWrittenData: (change) => { data = typeof change === 'function' ? change(data) : change },
    reloadWorkspaceSnapshot: async () => { calls.push('reload'); return { data: refreshed } },
    setSyncError: (message) => { errors.push(message) },
    getErrorMessage: (error, fallback) => error instanceof Error ? error.message : fallback,
    ...overrides,
  }
  return { transaction, services, calls, errors, refreshed, get data() { return data } }
}

for (const type of ['expense', 'income', 'transfer', 'opening_balance', 'balance_adjustment'] as const) {
  test(`deleting a ${type} invalidates history and reloads computed balances`, async () => {
    const state = setup({}, type)
    await removeTransaction(state.transaction, state.services)
    assert.deepEqual(state.calls, ['delete', '2026-10-14', 'clear', 'reload'])
    assert.deepEqual(state.data, state.refreshed)
    assert.deepEqual(state.errors, [''])
  })
}

test('keeps the transaction visible until the database confirms deletion', async () => {
  let finish: (() => void) | undefined
  const write = new Promise<void>((resolve) => { finish = resolve })
  const state = setup({ deleteTransaction: () => write })
  const pending = removeTransaction(state.transaction, state.services)
  assert.equal(state.data.transactions[0].id, 't1')
  assert.deepEqual(state.calls, [])
  finish?.()
  await pending
  assert.equal(state.data.transactions.some((item) => item.id === 't1'), false)
})

test('failed or unauthorized deletion preserves records and caches so it can be retried', async () => {
  const state = setup({ deleteTransaction: async () => { throw new Error('Permission denied') } })
  await assert.rejects(removeTransaction(state.transaction, state.services), /Permission denied/)
  assert.equal(state.data.transactions[0].id, 't1')
  assert.deepEqual(state.calls, [])
})

test('a refresh failure after deletion reports success with stale balances instead of inviting a second delete', async () => {
  const state = setup({ reloadWorkspaceSnapshot: async () => { throw new Error('Offline') } })
  await removeTransaction(state.transaction, state.services)
  assert.equal(state.data.transactions.some((item) => item.id === 't1'), false)
  assert.equal(state.data.transactions[0].id, 't2')
  assert.match(state.errors.at(-1)!, /Transaction deleted.*Reload the page.*Offline/)
})
