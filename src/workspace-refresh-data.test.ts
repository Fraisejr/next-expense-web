import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppData } from './types'
import type { LoadedWorkspace } from './database'
import { dataFromWorkspaceRefresh } from './workspace-refresh-data.ts'

const displayed = { transactions: [{ id: 'displayed' }], payees: [{ id: 'old' }] } as unknown as AppData
const loaded = { loadedMonthKey: '2026-10', data: { transactions: [{ id: 'loaded' }], payees: [{ id: 'new' }] } } as unknown as LoadedWorkspace

test('same-month refresh replaces the visible transaction page', () => {
  const next = dataFromWorkspaceRefresh(displayed, loaded, '2026-10', false)
  assert.equal(next.transactions, loaded.data.transactions)
  assert.equal(next.payees, loaded.data.payees)
})

test('refresh keeps full history visible while updating other workspace data', () => {
  const next = dataFromWorkspaceRefresh(displayed, loaded, '2026-10', true)
  assert.equal(next.transactions, displayed.transactions)
  assert.equal(next.payees, loaded.data.payees)
})

test('refresh for a different month preserves the selected month until its page loads', () => {
  const next = dataFromWorkspaceRefresh(displayed, loaded, '2026-09', false)
  assert.equal(next.transactions, displayed.transactions)
  assert.equal(next.payees, loaded.data.payees)
})
