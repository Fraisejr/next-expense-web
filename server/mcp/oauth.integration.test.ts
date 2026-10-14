import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { handle } from './http.ts'
import { challenge, secret } from './config.ts'
import type { Store } from './store.ts'

const connection = process.env.MCP_TEST_DATABASE_URL
const settings = { origin: 'https://expense.example', resource: 'https://expense.example/api/mcp', databaseUrl: 'unused', dataApiUrl: 'https://neon.example/rest/v1' }
const run = promisify(execFile)
const literal = (value: unknown) => value == null ? 'null' : `'${String(value).replaceAll("'", "''")}'`
test('complete OAuth consent, PKCE, replay, refresh rotation and revocation against PostgreSQL', { skip: !connection }, async () => {
  const url = new URL(connection!)
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use a disposable local database only.')
  const store: Store = { query: async (sql, values = []) => {
    let statement = sql.replace(/\$(\d+)/g, (_, index) => literal(values[Number(index) - 1]))
    if (/^(insert|update|delete)/i.test(statement) && !/returning/i.test(statement)) statement += ' returning 1'
    const query = `set role expense_mcp_runtime; ${statement};`
    const { stdout } = await run('psql', [connection!, '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', query]).catch(error => { console.error(error.stderr); throw error })
    const key = /returning scope|select g.scope/.test(sql) ? 'scope' : /as items/.test(sql) ? 'items' : 'value'
    return stdout.trim() ? stdout.trim().split('\n').map(value => ({ [key]: key === 'scope' ? value : JSON.parse(value) })) : []
  } }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/workspaces')) return Response.json([{ id: '10000000-0000-4000-8000-000000000001', name: 'MCP fixture' }])
    if (String(input).startsWith('https://neon.example/')) return Response.json([{ user_id: 'mcp-test-user', workspace_id: '10000000-0000-4000-8000-000000000001', role: 'owner' }])
    return originalFetch(input, init)
  }
  try {
    const post = (path: string, value: unknown, authorized = false) => handle(new Request(`${settings.origin}/api/mcp-oauth/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer neon-session', Origin: settings.origin } : {}) }, body: JSON.stringify(value) }), settings, store)
    const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect'
    const registered = await post('register', { client_name: 'ChatGPT fixture', redirect_uris: [redirect] })
    assert.equal(registered.status, 201)
    const client = (await registered.json()).client_id
    const verifier = secret()
    const authorization = new URL(`${settings.origin}/api/mcp-oauth/authorize`)
    authorization.search = new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: 'code', resource: settings.resource, scope: 'expenses:read expenses:write', code_challenge_method: 'S256', code_challenge: challenge(verifier), state: 'test-state' }).toString()
    const authorized = await handle(new Request(authorization), settings, store)
    assert.equal(authorized.status, 302)
    const id = new URL(authorized.headers.get('location')!).searchParams.get('request')!
    const info = await handle(new Request(`${settings.origin}/api/mcp-oauth/consent?request=${id}`, { headers: { Authorization: 'Bearer neon-session' } }), settings, store)
    assert.equal(info.status, 200)
    assert.equal((await info.json()).client_name, 'ChatGPT fixture')
    const approved = await post('consent', { request: id, workspace_id: '10000000-0000-4000-8000-000000000001', decision: 'allow' }, true)
    assert.equal(approved.status, 200)
    const returned = new URL((await approved.json()).redirect)
    assert.equal(returned.searchParams.get('state'), 'test-state')
    const code = returned.searchParams.get('code')!
    const exchange = { grant_type: 'authorization_code', client_id: client, redirect_uri: redirect, resource: settings.resource, code, code_verifier: verifier }
    assert.equal((await post('token', { ...exchange, code_verifier: secret() })).status, 400)
    const issued = await post('token', exchange)
    assert.equal(issued.status, 200)
    const tokens = await issued.json()
    assert.equal((await post('token', exchange)).status, 400, 'Authorization code must be one-use')
    const mcpRequest = (token: string) => handle(new Request(settings.resource, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), settings, store)
    assert.equal((await mcpRequest(tokens.access_token)).status, 200)
    const renewal = { grant_type: 'refresh_token', client_id: client, resource: settings.resource, refresh_token: tokens.refresh_token }
    assert.equal((await post('token', { ...renewal, client_id: 'different-client' })).status, 400)
    const renewed = await post('token', renewal)
    assert.equal(renewed.status, 200)
    const nextTokens = await renewed.json()
    assert.equal((await post('token', renewal)).status, 400, 'Rotated refresh token must be one-use')
    assert.equal((await mcpRequest(tokens.access_token)).status, 401)
    assert.equal((await mcpRequest(nextTokens.access_token)).status, 200)
    assert.equal((await post('revoke', { client_id: client, token: nextTokens.refresh_token })).status, 200)
    assert.equal((await mcpRequest(nextTokens.access_token)).status, 401)
  } finally { globalThis.fetch = originalFetch }
})
