import assert from 'node:assert/strict'
import { createServer } from 'vite'

const calls = []
let replies = [], session = { data: { user: { id: 'user' } }, error: null }, refreshes = 0
globalThis.__timesheetTestNeon = {
  rpc(name, args) {
    assert.equal(name, 'read_timesheet')
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
  assert.deepEqual(calls.at(-1), { p_workspace_id: 'workspace', p_start_date: '2025-12-01', p_end_date: '2026-12-01', p_comment_month: null })
  session = { data: null, error: null }
  replies = [denied]
  await assert.rejects(api.loadTimesheetMonth('workspace', '2026-10'), /session could not be verified/)
  replies = [{ data: null, error: { code: '22007', message: 'Invalid date' } }]
  const before = refreshes
  await assert.rejects(api.loadTimesheetMonth('workspace', '2026-10'), error => error.code === '22007')
  assert.equal(refreshes, before, 'Non-auth errors are not retried')
  console.log('Timesheet reads: session recovery, bounded denial, verified empty months, malformed responses, date ranges and expired JWT passed.')
} finally { await server.close(); delete globalThis.__timesheetTestNeon }
