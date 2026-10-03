import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool, neonConfig } from '@neondatabase/serverless'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. All test changes are rolled back.')
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()
const workspace = randomUUID(), user = randomUUID(), code = randomUUID()
try {
  await client.query('begin')
  const migration = await readFile('db/migrations/073_verified_timesheet_reads.sql', 'utf8')
  await client.query(migration.replace(/^begin;/, '').replace(/commit;\s*$/, ''))
  await client.query('insert into public.workspaces(id,name) values ($1,$2)', [workspace, 'Rollback timesheet read test'])
  await client.query('insert into public.workspace_members(workspace_id,user_id) values ($1,$2)', [workspace, user])
  await client.query("insert into public.time_codes(id,workspace_id,name) values ($1,$2,'Test hours')", [code, workspace])
  await client.query("insert into public.time_entries(workspace_id,time_code_id,work_date,hours) values ($1,$2,'2025-12-01',7),($1,$2,'2026-10-01',8),($1,$2,'2026-12-01',9)", [workspace, code])
  await client.query("insert into public.time_code_month_comments(workspace_id,time_code_id,month_start,comment) values ($1,$2,'2026-10-01','Tickets')", [workspace, code])
  await client.query("insert into public.time_codes(workspace_id,name) select $1,'Bulk '||n from generate_series(1,34) n", [workspace])
  await client.query("insert into public.time_entries(workspace_id,time_code_id,work_date,hours) select $1,c.id,d::date,1 from public.time_codes c cross join generate_series('2026-10-01'::date,'2026-10-31'::date,'1 day') d where c.workspace_id=$1 and c.id<>$2", [workspace, code])
  await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user })])
  assert.equal((await client.query('select auth.user_id() as id')).rows[0].id, user)
  await client.query('set local role authenticated')
  const load = async (start, end, month = null, target = workspace) => (await client.query('select public.read_timesheet($1,$2,$3,$4) as result', [target, start, end, month])).rows[0].result
  const result = await load('2026-10-01', '2026-11-01', '2026-10-01')
  assert.equal(result.workspaceId, workspace)
  assert.equal(result.entries.length, 1055, 'All rows returned beyond Data API page limit')
  assert.deepEqual(result.comments, [{ time_code_id: code, month_start: '2026-10-01', comment: 'Tickets' }])
  assert.equal((await load('2025-12-01', '2026-12-01')).entries.length, 1056)
  assert.deepEqual((await load('2026-11-01', '2026-12-01')).entries, [])
  const rejected = async (action, pattern) => {
    await client.query('savepoint expected_failure')
    await assert.rejects(action, pattern)
    await client.query('rollback to savepoint expected_failure')
  }
  await rejected(() => load('2026-10-01', '2026-11-01', null, randomUUID()), /access to this workspace/)
  await rejected(() => load('2026-10-01', '2026-10-01'), /Invalid timesheet date range/)
  await rejected(() => load('2026-10-01', '2026-11-01', '2026-10-02'), /Invalid timesheet comment month/)
  await client.query('reset role')
  await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: randomUUID() })])
  await client.query('select auth.user_id()')
  await client.query('set local role authenticated')
  await rejected(() => load('2026-10-01', '2026-11-01'), /access to this workspace/)
  console.log('Timesheet database read: access denial, verified empty months, >1,000 rows, comments and date boundaries passed. Fixtures and migration rolled back.')
} finally {
  await client.query('rollback')
  client.release()
  await pool.end()
}
