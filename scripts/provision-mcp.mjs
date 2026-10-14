import { Pool, neonConfig } from '@neondatabase/serverless'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

// Run only after migration 074 using the local owner connection. Never log
// passwords or upload this owner connection to Vercel.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for provisioning.')
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const password = randomBytes(32).toString('hex')
try {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const existing = await client.query("select 1 from pg_roles where rolname='next_expense_mcp'")
    if (existing.rowCount) throw new Error('MCP login already exists. Rotate its password explicitly instead of overwriting it.')
    await client.query(`create role next_expense_mcp login password '${password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`)
    await client.query('grant expense_mcp_runtime to next_expense_mcp')
    const connection = new URL(process.env.DATABASE_URL)
    connection.username = 'next_expense_mcp'; connection.password = password
    await client.query('set local role next_expense_mcp')
    await client.query('select count(*) from expense_mcp.grants')
    await client.query('savepoint permission_check')
    let denied = false
    try { await client.query('select id from public.transactions limit 0') } catch (error) { denied = error.code === '42501' }
    await client.query('rollback to savepoint permission_check')
    await client.query('reset role')
    if (!denied) throw new Error('MCP role unexpectedly has direct financial table access.')
    await writeFile('.env.mcp.local', `MCP_DATABASE_URL=${connection.href}\n`, { mode: 0o600, flag: 'wx' })
    await client.query('commit')
    console.log('Created restricted MCP login. Server credential saved to ignored .env.mcp.local (mode 0600).')
  } catch (error) { await client.query('rollback'); throw error }
  finally { client.release() }
} finally { await pool.end() }
