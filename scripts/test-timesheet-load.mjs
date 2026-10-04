import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createClient } from '@neondatabase/neon-js'

const calls = []
let replies = [], session = { data: { user: { id: 'user' } }, error: null }, refreshes = 0
globalThis.__timesheetTestNeon = {
  rpc(name, args, options) {
    assert.equal(name, 'read_timesheet')
    assert.deepEqual(options, { get: true })
    calls.push(args)
    return { async abortSignal(signal) { assert.ok(signal instanceof AbortSignal); return replies.shift() } }
  },
  auth: { async getSession() { refreshes++; return session } },
}
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', plugins: [{
  name: 'mock-timesheet-neon', enforce: 'pre',
  resolveId(source, importer) { if (source === '../../neon' && importer?.endsWith('/timesheet/api.ts')) return '\0timesheet-neon' },
  load(id) { if (id === '\0timesheet-neon') return 'export const neon = globalThis.__timesheetTestNeon' },
}] })
const success = { error: null, data: { workspaceId: 'workspace', entries: [{ time_code_id: 'code', work_date: '2026-10-01', hours: 8 }], comments: [{ time_code_id: 'code', month_start: '2026-10-01', comment: 'Tickets' }] } }
const denied = { data: null, error: { code: '42501', message: 'You do not have access to this workspace.' } }
try {
  const api = await server.ssrLoadModule('/src/features/timesheet/api.ts')
  replies = [denied, success]
  const month = await api.loadTimesheetMonth('workspace', '2026-10')
  assert.deepEqual(month, { entries: [{ codeId: 'code', date: '2026-10-01', hours: 8 }], comments: [{ codeId: 'code', month: '2026-10', comment: 'Tickets' }] })
  assert.equal(refreshes, 1)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], { p_workspace_id: 'workspace', p_start_date: '2026-10-01', p_end_date: '2026-11-01', p_comment_month: '2026-10-01' })
  replies = [denied, denied, denied]
  await assert.rejects(api.loadTimesheetMonth('workspace', '2026-10'), error => error.code === '42501')
  assert.equal(calls.length, 5, 'Permanent denial stops after three attempts')
  replies = [{ error: null, data: null }]
  await assert.rejects(api.loadTimesheetMonth('workspace', '2026-10'), /could not be verified/)
  replies = [{ error: null, data: { ...success.data, workspaceId: 'other' } }]
  await assert.rejects(api.loadTimesheetMonth('workspace', '2026-10'), /could not be verified/)
  replies = [{ error: null, data: { workspaceId: 'workspace', entries: [], comments: [] } }]
  assert.deepEqual(await api.loadTimesheetMonth('workspace', '2026-12'), { entries: [], comments: [] })
  assert.equal(calls.at(-1).p_end_date, '2027-01-01')
  replies = [{ data: null, error: { message: 'JWT token has expired' } }, success]
  await api.loadRevenueRecognitionEntries('workspace', 2026)
  assert.deepEqual(calls.at(-1), { p_workspace_id: 'workspace', p_start_date: '2025-12-01', p_end_date: '2026-12-01' })
  const missingFunction = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.read_timesheet without parameters in the schema cache' } }
  replies = [missingFunction, success]
  assert.equal((await api.loadTimesheetMonth('workspace', '2026-09')).entries[0].hours, 8)
  assert.equal(calls.at(-1).p_start_date, '2026-09-01')
  assert.equal(calls.at(-1).p_end_date, '2026-10-01')
  replies = [missingFunction, missingFunction, missingFunction]
  const priorCalls = calls.length
  await assert.rejects(api.loadTimesheetMonth('workspace', '2026-09'), /service is temporarily unavailable/)
  assert.equal(calls.length - priorCalls, 3, 'Missing function retries are bounded')
  session = { data: null, error: null }
  replies = [denied]
  await assert.rejects(api.loadTimesheetMonth('workspace', '2026-10'), /session could not be verified/)
  replies = [{ data: null, error: { code: '22007', message: 'Invalid date' } }]
  const before = refreshes
  await assert.rejects(api.loadTimesheetMonth('workspace', '2026-10'), error => error.code === '22007')
  assert.equal(refreshes, before, 'Non-auth errors are not retried')
  const wireRequests = []
  const client = createClient({ dataApi: {
    url: 'https://data.example/rest/v1', getToken: async () => 'test-token',
    options: { global: { fetch: async (input, init) => {
      const url = new URL(String(input))
      assert.equal(init.method, 'GET')
      assert.equal(init.body, undefined)
      assert.equal(url.pathname, '/rest/v1/rpc/read_timesheet')
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-token')
      wireRequests.push(Object.fromEntries(url.searchParams))
      return Response.json(success.data)
    } } },
  } })
  globalThis.__timesheetTestNeon.rpc = client.rpc.bind(client)
  await api.loadTimesheetMonth('workspace', '2026-09')
  await api.loadRevenueRecognitionEntries('workspace', 2026)
  assert.deepEqual(wireRequests, [
    { p_workspace_id: 'workspace', p_start_date: '2026-09-01', p_end_date: '2026-10-01', p_comment_month: '2026-09-01' },
    { p_workspace_id: 'workspace', p_start_date: '2025-12-01', p_end_date: '2026-12-01' },
  ])
  console.log('Timesheet reads: session recovery, bounded denial, verified empty months, malformed responses, date ranges and expired JWT passed.')
} finally { await server.close(); delete globalThis.__timesheetTestNeon }
