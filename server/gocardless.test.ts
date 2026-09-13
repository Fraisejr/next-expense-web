import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createGoCardlessHandler } from './gocardless.ts'
import { bankReference, verifyBankReference } from './bank-authorization.ts'

const workspace = '10000000-0000-0000-0000-000000000001'
const account = '10000000-0000-0000-0000-000000000002'
const provider = '10000000-0000-0000-0000-000000000003'
const requisition = '10000000-0000-0000-0000-000000000004'
const origin = 'https://expense.example'
const key = 'test-only-key'
const config = { dataApiUrl: 'https://data.example/rest/v1', appUrl: origin }

async function invoke(path: string, body?: object, headers: Record<string,string> = { authorization: 'Bearer test-jwt', origin }) {
  const request = Readable.from(body ? [JSON.stringify(body)] : []) as IncomingMessage
  request.method = body ? 'POST' : 'GET'
  request.url = `/api/gocardless${path}`
  request.headers = headers
  let status = 200
  let payload: Record<string, unknown> = {}
  const response = {
    get statusCode() { return status }, set statusCode(value: number) { status = value },
    setHeader() {}, end(value: string) { payload = JSON.parse(value) },
  } as unknown as ServerResponse
  await createGoCardlessHandler('test-id', key, config)(request, response)
  return { status, payload }
}

function mockFetch(t: TestContext, options: { member?: boolean; account?: boolean; reference?: string; providerAccounts?: string[] } = {}) {
  const original = globalThis.fetch
  const calls: URL[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url)
    if (url.host === 'data.example') {
      assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer test-jwt')
      assert.equal(url.searchParams.get('workspace_id'), `eq.${workspace}`)
      switch(url.pathname.split('/').pop()) {
        case 'workspace_members': return Response.json(options.member === false ? [] : [{workspace_id:workspace}])
        case 'accounts':
          assert.equal(url.searchParams.get('id'), `eq.${account}`)
          return Response.json(options.account === false ? [] : [{id:account, provider_account_id:provider}])
        case 'bank_connections':
          assert.equal(url.searchParams.get('account_id'), `eq.${account}`)
          return Response.json([{id:requisition,provider_connection_id:requisition}])
      }
    }
    if (url.pathname.endsWith('/token/new/')) return Response.json({access:'provider-token',access_expires:3600})
    if (url.pathname.endsWith('/transactions/')) return Response.json({transactions:{booked:[{internalTransactionId:'bank-1',bookingDate:'2026-09-13',transactionAmount:{amount:'-12.34',currency:'SEK'},creditorName:'Market'}],pending:[]}})
    if (url.pathname.endsWith('/balances/')) return Response.json({balances:[]})
    if (url.pathname === `/api/v2/accounts/${provider}/`) return Response.json({id:provider,name:'Bank account'})
    if (url.pathname.includes('/requisitions/')) return Response.json({id:requisition,reference:options.reference ?? bankReference(workspace,account,key),accounts:options.providerAccounts ?? [provider]})
    throw new Error(`Unexpected request: ${url.pathname}`)
  }
  t.after(() => { globalThis.fetch = original })
  return calls
}

test('anonymous bank requests never reach provider', async t => {
  const calls = mockFetch(t)
  const result = await invoke(`/institutions?workspaceId=${workspace}`, undefined, {})
  assert.equal(result.status,401); assert.equal(calls.length,0)
})
test('unlinked signed-in users cannot reach provider', async t => {
  const calls=mockFetch(t,{member:false})
  assert.equal((await invoke(`/institutions?workspaceId=${workspace}`)).status,403)
  assert.equal(calls.length,1)
})
test('cross-origin calls fail before authentication', async t => {
  const calls=mockFetch(t)
  assert.equal((await invoke(`/institutions?workspaceId=${workspace}`,undefined,{authorization:'Bearer test-jwt',origin:'https://evil.example'})).status,403)
  assert.equal(calls.length,0)
})
test('cross-workspace account lookup fails closed', async t => {
  const calls=mockFetch(t,{account:false})
  assert.equal((await invoke('/sync',{workspaceId:workspace,accountId:account})).status,403)
  assert.ok(calls.every(x=>x.host==='data.example'))
})
test('sync uses server-read provider ID, ignoring a forged client provider ID', async t => {
  const calls=mockFetch(t)
  const result=await invoke('/sync',{workspaceId:workspace,accountId:account,providerAccountId:requisition})
  assert.equal(result.status,200)
  assert.ok(calls.some(x=>x.pathname===`/api/v2/accounts/${provider}/transactions/`))
  assert.ok(!calls.some(x=>x.pathname.includes(`/accounts/${requisition}/`)))
  assert.equal((result.payload.transactions as {amount:string}[])[0].amount,'-12.34')
})
test('requisition belongs to the workspace and account that initiated it',async t=>{
  mockFetch(t,{reference:bankReference(workspace,account,key)})
  assert.equal((await invoke(`/requisition?id=${requisition}&workspaceId=${workspace}&accountId=${account}`)).status,200)
})
test('another account cannot inspect a requisition',async t=>{
  mockFetch(t,{reference:bankReference(workspace,provider,key)})
  assert.equal((await invoke(`/requisition?id=${requisition}&workspaceId=${workspace}&accountId=${account}`)).status,403)
})
test('signed bank references reject tampering',()=>{
  const reference=bankReference(workspace,account,key)
  assert.ok(verifyBankReference(reference,workspace,account,key))
  assert.equal(verifyBankReference(reference,workspace,account,'other-key'),false)
  assert.equal(verifyBankReference(reference+'x',workspace,account,key),false)
})

test('client-edited provider account outside the signed requisition cannot sync',async t=>{
  const calls=mockFetch(t,{providerAccounts:[requisition]})
  assert.equal((await invoke('/sync',{workspaceId:workspace,accountId:account})).status,403)
  assert.ok(!calls.some(x=>x.pathname.endsWith('/transactions/') || x.pathname.endsWith('/balances/')))
})
test('legacy or another workspace requisition cannot authorize hosted sync',async t=>{
  const calls=mockFetch(t,{reference:'legacy-reference'})
  assert.equal((await invoke('/sync',{workspaceId:workspace,accountId:account})).status,403)
  assert.ok(!calls.some(x=>x.pathname.endsWith('/transactions/') || x.pathname.endsWith('/balances/')))
})
