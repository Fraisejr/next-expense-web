import { Pool, neonConfig } from '@neondatabase/serverless'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

// Use the local owner connection only for provisioning. Verify permissions
// through a separate login: Neon owners cannot necessarily SET ROLE to it.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for provisioning.')
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const password = randomBytes(32).toString('hex')
let created = false
try {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const existing = await client.query("select 1 from pg_roles where rolname='next_expense_mcp'")
    if (existing.rowCount) throw new Error('MCP login already exists. Rotate its password explicitly instead of overwriting it.')
    await client.query(`create role next_expense_mcp login password '${password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`)
    await client.query('grant expense_mcp_runtime to next_expense_mcp')
    await client.query('commit')
    created = true
  } catch (error) { await client.query('rollback'); throw error }
  finally { client.release() }

  const connection = new URL(process.env.DATABASE_URL)
  connection.username = 'next_expense_mcp'; connection.password = password
  const restricted = new Pool({ connectionString: connection.href })
  try {
    await restricted.query('select count(*) from expense_mcp.grants')
    let denied = false
    try { await restricted.query('select id from public.transactions limit 0') } catch (error) { denied = error.code === '42501' }
    if (!denied) throw new Error('MCP role unexpectedly has direct financial table access.')
  } finally { await restricted.end() }
  await writeFile('.env.mcp.local', `MCP_DATABASE_URL=${connection.href}\n`, { mode: 0o600, flag: 'wx' })
  console.log('Created and verified restricted MCP login. Credential saved to ignored .env.mcp.local (mode 0600).')
} catch (error) {
  // Only remove the login created by this invocation, never an existing one.
  if (created) await pool.query('drop role next_expense_mcp')
  throw error
} finally { await pool.end() }
