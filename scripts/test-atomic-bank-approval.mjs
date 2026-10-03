import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool, neonConfig } from '@neondatabase/serverless'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. All test data is rolled back.')
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()
const workspace = randomUUID(), account = randomUUID(), otherAccount = randomUUID(), category = randomUUID(), hidden = randomUUID()
const first = randomUUID(), second = randomUUID(), invalid = randomUUID(), user = randomUUID()
try {
  await client.query('begin')
  await client.query('insert into public.workspaces(id,name) values ($1,$2)', [workspace, 'Rollback approval test'])
  await client.query('insert into public.workspace_members(workspace_id,user_id) values ($1,$2)', [workspace, user])
  await client.query("insert into public.accounts(id,workspace_id,name,account_type,currency) values ($1,$3,'Bank','Budget','EUR'),($2,$3,'Other','Budget','EUR')", [account, otherAccount, workspace])
  await client.query("insert into public.categories(id,workspace_id,name,category_type,report_group,hidden) values ($1,$3,'Shopping','Expense','personal_expense',false),($2,$3,'Hidden','Expense','personal_expense',true)", [category, hidden, workspace])
  for (const id of [first, second, invalid]) await client.query("insert into public.bank_import_candidates(id,workspace_id,account_id,provider,provider_transaction_id,transaction_date,amount_minor,currency,transaction_type,payee_name,fetched_at,posted) values ($1::uuid,$2,$3,'gocardless',($1::uuid)::text,'2026-01-05',100,'EUR','expense','Test &amp; Store',now(),false)", [id, workspace, account])
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })])
  assert.equal((await client.query('select auth.user_id() as id')).rows[0].id, user)
  await client.query('set local role authenticated')
  const approve = async (id, selectedCategory = category, selectedAccount = account, payeeId = null, rememberMapping = true) => {
    const { rows } = await client.query('select public.approve_bank_review_item($1,$2,$3,$4,$5,$6,true,true,$7) as result', [workspace, selectedAccount, id, selectedCategory, payeeId, 'My memo', rememberMapping])
    return rows[0].result
  }
  const reject = async (action, pattern) => {
    await client.query('savepoint expected_failure')
    await assert.rejects(action, pattern)
    await client.query('rollback to savepoint expected_failure')
  }
  await reject(() => approve(invalid, hidden), /active category/)
  await reject(() => approve(first, category, otherAccount), /no longer exists on this account/)
  await reject(() => approve(first, category, account, randomUUID()), /payee from this workspace/)
  const result = await approve(first)
  assert.equal(result.transaction.memo, 'My memo')
  assert.equal(result.transaction.posted, false)
  assert.equal(result.transaction.bank_memo, null)
  assert.equal(result.payee.default_category_id, category)
  assert.equal(result.payee.default_account_id, account)
  assert.equal(result.balanceMinor, -100)
  assert.equal(result.pendingCount, 2)
  assert.equal(result.mapping.payee_id, result.payee.id)
  assert.ok(result.rematched.some((row) => row.id === second && row.payee_id === result.payee.id && row.category_id === category))
  const retry = await approve(first, hidden, account, randomUUID())
  assert.equal(retry.transaction.id, result.transaction.id, 'retry returns the original transaction before applying changed inputs')
  assert.equal(retry.mapping.id, result.mapping.id, 'lost-response retry recovers saved mapping')
  assert.ok(retry.rematched.some((row) => row.id === second && row.payee_id === result.payee.id))
  assert.equal((await client.query('select count(*)::int as count from public.transactions where workspace_id=$1', [workspace])).rows[0].count, 1)
  const reused = await approve(second, category, account, null, false)
  assert.equal(reused.payee.id, result.payee.id, 'same normalized bank description reuses the payee')
  assert.equal(reused.balanceMinor, -200)
  assert.equal((await client.query('select count(*)::int as count from public.payees where workspace_id=$1', [workspace])).rows[0].count, 1)
  await reject(() => client.query('select public.approve_bank_review_item($1,$2,$3,$4)', [randomUUID(), account, invalid, category]), /access denied/)
  const names = await client.query("select public.bank_review_normalized_name('Ａ  &amp; &#x42;') as name")
  assert.equal(names.rows[0].name, 'a & b')
  assert.equal((await client.query("select public.bank_review_normalized_name('&amp;quot;') as name")).rows[0].name, '&quot;', 'HTML decoding preserves the client single-pass behavior')
  await client.query('select public.create_bank_import_transfer_from_candidate($1,$2,$3)', [workspace, invalid, otherAccount])
  await client.query("update public.bank_import_candidates set status='pending', payee_name='Unique failure payee',payee_id=null,memo=null where id=$1", [invalid])
  await reject(() => approve(invalid), /transfer cannot be approved/)
  assert.equal((await client.query('select count(*)::int as count from public.payees where workspace_id=$1', [workspace])).rows[0].count, 1, 'failed approval rolls back the newly created payee')
  const unchanged = (await client.query('select status,payee_id,memo from public.bank_import_candidates where id=$1', [invalid])).rows[0]
  assert.deepEqual(unchanged, { status: 'pending', payee_id: null, memo: null }, 'failed approval rolls back candidate changes')
  console.log('Atomic bank approval: access/account checks, rollback, new/reused payee, defaults, mapping/rematch, balances, pending status and retry idempotency passed.')
} finally {
  await client.query('rollback')
  client.release()
  await pool.end()
}

