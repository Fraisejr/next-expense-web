import test from 'node:test'
import assert from 'node:assert/strict'
import { handle } from './http.ts'
import { config, hash, parseScopes, validRedirect, challenge } from './config.ts'
import { definitions } from './tools.ts'
import type { Store } from './store.ts'

const settings = { origin: 'https://expense.example', resource: 'https://expense.example/api/mcp', databaseUrl: 'unused', dataApiUrl: 'https://neon.example/rest/v1' }
const token = 'a'.repeat(43)
const store: Store = { query: async (sql, args) => /expense_mcp\.(execute_tool|read_timesheet)/.test(sql) ? [{ result: { id: 'workspace', received: args?.[1] } }] : [{ scope: 'expenses:read expenses:write' }] }
const request = (value: unknown, authorization = `Bearer ${token}`) => new Request(settings.resource, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(value) })

test('configuration fails closed and redirect validation excludes unsafe schemes', () => {
  assert.equal(config({} as NodeJS.ProcessEnv), null)
  assert.equal(validRedirect('javascript:alert(1)'), false)
  assert.equal(validRedirect('https://user:pass@example.com/callback'), false)
  assert.equal(validRedirect('http://evil.example/callback'), false)
  assert.equal(validRedirect('http://127.0.0.1:1234/callback'), true)
  assert.equal(validRedirect('https://chatgpt.com/connector_platform_oauth_redirect'), true)
  assert.throws(() => parseScopes('expenses:read admin'))
  assert.equal(challenge('test').length, 43)
})
test('OAuth discovery, missing authorization, invalid grants and origins', async () => {
  const discovery = await handle(new Request(`${settings.origin}/.well-known/oauth-protected-resource/api/mcp`), settings, store)
  assert.equal((await discovery.json()).resource, settings.resource)
  const rewritten = await handle(new Request(`${settings.origin}/api/mcp-oauth?mcp_route=metadata`), settings, store)
  assert.equal((await rewritten.json()).issuer, settings.origin)
  const oidc = await handle(new Request(`${settings.origin}/api/mcp-oauth?mcp_route=openid`), settings, store)
  assert.equal(oidc.status, 404, 'OAuth-only server must not advertise OIDC')
  const missing = await handle(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ''), settings, store)
  assert.equal(missing.status, 401)
  assert.match(missing.headers.get('www-authenticate') || '', /resource_metadata/)
  assert.equal((await handle(request({}), settings, { query: async () => [] })).status, 401)
  const crossOrigin = request({}); crossOrigin.headers.set('Origin', 'https://evil.example')
  assert.equal((await handle(crossOrigin, settings, store)).status, 403)
})
test('MCP protocol initializes, discovers tools and executes through scoped SQL', async () => {
  const initialized = await handle(request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }), settings, store)
  assert.equal(initialized.status, 200)
  assert.equal((await initialized.json()).result.serverInfo.name, 'next-expense')
  const listed = await handle(request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), settings, store)
  const tools = (await listed.json()).result.tools
  assert.equal(tools.length, 13)
  const called = await handle(request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_workspace', arguments: {} } }), settings, store)
  assert.equal(JSON.parse((await called.json()).result.content[0].text).received, 'get_workspace')
})
test('read-only connection hides write tools and invalid input never reaches SQL', async () => {
  const readOnly: Store = { query: async () => [{ scope: 'expenses:read' }] }
  const response = await handle(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), settings, readOnly)
  assert.equal((await response.json()).result.tools.length, 9)
  let calls = 0
  const spy: Store = { query: async sql => { if (/expense_mcp\.(execute_tool|read_timesheet)/.test(sql)) calls++; return [{ scope: 'expenses:read expenses:write' }] } }
  for (const args of [{ start_date: '2020-02-30', end_date: '2020-03-01' }, { start_date: '2020-03-02', end_date: '2020-03-01' }]) {
    const response = await handle(request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_transactions', arguments: args } }), settings, spy)
    const body = await response.json()
    assert.ok(body.error || body.result.isError)
  }
  assert.equal(calls, 0)
  assert.equal(definitions.find(tool => tool.name === 'create_transaction')!.schema.safeParse({}).success, false)
})
test('OAuth token exchange enforces resource and verifier before querying', async () => {
  const response = await handle(new Request(`${settings.origin}/api/mcp-oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', resource: 'https://wrong.example/api/mcp' }) }), settings, store)
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'invalid_target')
  assert.equal(hash(token).length, 64)
})

test('timesheet tools are read-only, enforce dates, and use the private timesheet function', async () => {
  const calls: { sql: string; args?: unknown[] }[] = []
  const database: Store = { query: async (sql, args) => {
    if (sql.includes('read_timesheet')) { calls.push({ sql, args }); return [{ result: { entries: [], total_hours: 0 } }] }
    return [{ scope: 'expenses:read' }]
  } }
  const listed = await handle(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), settings, database)
  const tools = (await listed.json()).result.tools
  for (const name of ['read_timesheet', 'list_time_codes']) {
    const descriptor = tools.find((tool: { name: string }) => tool.name === name)
    assert.equal(descriptor.annotations.readOnlyHint, true)
    assert.equal(descriptor.annotations.destructiveHint, false)
  }
  const args = { start_date: '2026-10-05', end_date: '2026-10-11', limit: 1, revision: 'a'.repeat(32) }
  const read = await handle(request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_timesheet', arguments: args } }), settings, database)
  assert.equal((await read.json()).result.isError, undefined)
  assert.match(calls[0].sql, /expense_mcp.read_timesheet/)
  assert.equal(calls[0].args?.[0], hash(token))
  assert.equal(calls[0].args?.[1], 'read_timesheet')
  assert.deepEqual(JSON.parse(String(calls[0].args?.[2])), { ...args, offset: 0 })
  for (const invalid of [
    { start_date: '2026-10-11', end_date: '2026-10-05' },
    { start_date: '2026-02-30', end_date: '2026-03-01' },
    { start_date: '2025-01-01', end_date: '2026-01-02' },
    { start_date: '2026-10-05', end_date: '2026-10-11', limit: 101 },
    { start_date: '2026-10-05', end_date: '2026-10-11', client_id: 'not-an-id' },
  ]) {
    const response = await handle(request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_timesheet', arguments: invalid } }), settings, database)
    const value = await response.json()
    assert.ok(value.error || value.result.isError)
  }
  assert.equal(calls.length, 1, 'Invalid requests never query the timesheet')
})
