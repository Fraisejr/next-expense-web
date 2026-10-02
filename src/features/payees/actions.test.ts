import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Dispatch, SetStateAction } from 'react'
import { createPayeeActions, type PayeeActionServices } from './actions.ts'
import type { AppData } from '../../types.ts'
import type { LoadedWorkspace } from '../../database.ts'

function setup(services: Partial<PayeeActionServices>) {
  let data = {
    payees: [{ id: 'p1', name: 'Old name' }, { id: 'p2', name: 'Other payee' }],
    transactions: [{ id: 't1', payeeId: 'p1', payee: 'Old name' }],
    payeeMappings: [{ id: 'm1', sourceName: 'OLD NAME', payeeId: 'p1', matchType: 'exact' }],
  } as AppData
  const errors: string[] = []
  const setWrittenData: Dispatch<SetStateAction<AppData>> = (change) => {
    data = typeof change === 'function' ? change(data) : change
  }
  const actions = createPayeeActions({
    workspaceId: 'w1', data, setWrittenData, setSyncError: (value) => { errors.push(String(value)) },
    reloadWorkspaceSnapshot: async () => ({ data } as LoadedWorkspace),
    services: {
      getErrorMessage: (error) => error instanceof Error ? error.message : String(error),
      ...services,
    } as PayeeActionServices,
  })
  return { actions, get data() { return data }, errors }
}

test('rename writes to the database before changing the payee and linked transactions', async () => {
  let finishWrite: (() => void) | undefined
  const write = new Promise<void>((resolve) => { finishWrite = resolve })
  const state = setup({ updatePayeeName: async () => write })
  const pending = state.actions.renamePayee('p1', ' New name ')
  assert.equal(state.data.payees[0].name, 'Old name')
  finishWrite?.()
  await pending
  assert.equal(state.data.payees[0].name, 'New name')
  assert.equal(state.data.transactions[0].payee, 'New name')
})

test('failed rename leaves local data intact and reports the error', async () => {
  const state = setup({ updatePayeeName: async () => { throw new Error('Write failed') } })
  await assert.rejects(state.actions.renamePayee('p1', 'New name'), /Write failed/)
  assert.equal(state.data.payees[0].name, 'Old name')
  assert.equal(state.data.transactions[0].payee, 'Old name')
  assert.equal(state.errors.at(-1), 'Write failed')
})

test('mapping update saves before displaying the cleaned source name', async () => {
  const calls: unknown[][] = []
  const state = setup({
    updatePayeeMapping: async (...args) => { calls.push(args) },
    cleanedMappingName: (name) => name.normalize('NFKC').trim(),
  })
  await state.actions.changePayeeMapping('m1', '  New source  ', 'p2', 'starts_with')
  assert.deepEqual(calls, [['w1', 'm1', '  New source  ', 'p2', 'starts_with']])
  assert.deepEqual(state.data.payeeMappings[0], { id: 'm1', sourceName: 'New source', payeeId: 'p2', matchType: 'starts_with' })
})
