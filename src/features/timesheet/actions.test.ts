import assert from 'node:assert/strict'
import test from 'node:test'
import type { Dispatch, SetStateAction } from 'react'
import type { AppData, TimeCode } from '../../types'
import { createTimesheetActions, type TimesheetActionServices } from './actions.ts'

function fixture(overrides: Partial<TimesheetActionServices> = {}) {
  let data = {
    timeCodes: [
      { id: 'first', name: 'First', sortOrder: 0, clientId: 'client' },
      { id: 'second', name: 'Second', sortOrder: 1, clientId: 'client' },
    ],
    timesheetClients: [],
    timesheetClientRates: [],
    timesheetClientForecasts: [],
  } as unknown as AppData
  let writes = 0
  const setWrittenData: Dispatch<SetStateAction<AppData>> = (value) => {
    writes++
    data = typeof value === 'function' ? value(data) : value
  }
  const services: TimesheetActionServices = {
    uid: () => 'new-id',
    todayInParis: () => '2026-10-02',
    createTimeCode: async () => {},
    updateTimeCode: async () => {},
    createTimesheetClient: async () => {},
    updateTimesheetClient: async () => {},
    saveTimesheetClientRate: async () => {},
    saveTimesheetClientForecast: async () => {},
    saveTimeCodeOrder: async () => {},
    ...overrides,
  }
  return {
    actions: createTimesheetActions('workspace', data, setWrittenData, services),
    data: () => data,
    writes: () => writes,
  }
}

test('a time code appears locally only after its database write succeeds', async () => {
  let complete!: () => void
  const pending = new Promise<void>((resolve) => { complete = resolve })
  let saved: TimeCode | undefined
  const result = fixture({ createTimeCode: async (workspaceId, code) => {
    assert.equal(workspaceId, 'workspace')
    saved = code
    await pending
  } })
  const write = result.actions.addTimeCode('  Café  ', 'client')
  assert.equal(result.writes(), 0)
  assert.equal(result.data().timeCodes.length, 2)
  complete()
  await write
  assert.equal(saved?.name, 'Café')
  assert.equal(saved?.sortOrder, 2)
  assert.equal(result.writes(), 1)
  assert.equal(result.data().timeCodes[2]?.id, 'new-id')
})

test('a failed client creation leaves local data and mutation tracking unchanged', async () => {
  const result = fixture({ createTimesheetClient: async () => { throw new Error('write failed') } })
  await assert.rejects(result.actions.addTimesheetClient('Client', 'sek', 12500), /write failed/)
  assert.equal(result.writes(), 0)
  assert.deepEqual(result.data().timesheetClients, [])
  assert.deepEqual(result.data().timesheetClientRates, [])
})

test('a new client and its initial rate enter local state together', async () => {
  const result = fixture({ createTimesheetClient: async (workspaceId, client, rate) => {
    assert.equal(workspaceId, 'workspace')
    assert.equal(client.currency, 'SEK')
    assert.equal(rate.effectiveFrom, '2026-01-01')
    assert.equal(result.writes(), 0)
  } })
  await result.actions.addTimesheetClient('  New client  ', 'sek', 12500)
  assert.equal(result.writes(), 1)
  assert.equal(result.data().timesheetClients[0]?.name, 'New client')
  assert.equal(result.data().timesheetClientRates[0]?.hourlyRateMinor, 12500)
})

test('reordering saves the complete code order before updating local state', async () => {
  let savedIds: string[] = []
  const result = fixture({ saveTimeCodeOrder: async (_workspaceId, ids) => {
    savedIds = ids
    assert.equal(result.writes(), 0)
  } })
  await result.actions.reorderTimeCodes(['second', 'missing'])
  assert.deepEqual(savedIds, ['second', 'first'])
  assert.deepEqual(result.data().timeCodes.map(({ id, sortOrder }) => [id, sortOrder]), [['second', 0], ['first', 1]])
  assert.equal(result.writes(), 1)
})
