import { readFile } from 'node:fs/promises'
import { Pool, neonConfig } from '@neondatabase/serverless'

const path = process.argv[2]
if (!path || !/^db\/migrations\/\d+_[\w-]+\.sql$/.test(path)) throw new Error('Pass a versioned db/migrations/*.sql path.')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.')
neonConfig.webSocketConstructor = WebSocket
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
try {
  await pool.query(await readFile(path, 'utf8'))
  console.log(`Applied ${path}`)
} finally { await pool.end() }
