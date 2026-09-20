import { BetterAuthVanillaAdapter, createClient } from '@neondatabase/neon-js'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BankDatabase } from '../shared/bank-data.ts'
import type { BankSyncSummary } from '../shared/bank-types.ts'
import { claimAutomaticSync, finishAutomaticSync } from './bank-sync.ts'
import { createGoCardlessService } from './gocardless.ts'

type CronConfig = {
  authUrl?: string
  dataApiUrl?: string
  email?: string
  password?: string
  cronSecret?: string
  appUrl?: string
  gocardlessSecretId?: string
  gocardlessSecretKey?: string
}

type AutomaticAccount = {
  id: string
  workspace_id: string
  name: string
  provider_account_id: string | null
}

type AccountResult = {
  accountId: string
  accountName: string
  status: 'completed' | 'failed' | 'skipped'
  imported?: number
  warnings?: string[]
  error?: string
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(body))
}

function authorized(request: IncomingMessage, secret: string | undefined) {
  if (!secret) return false
  const received = request.headers.authorization
  if (!received) return false
  const expected = Buffer.from(`Bearer ${secret}`)
  const actual = Buffer.from(received)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function cetDate(now: Date) {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10)
}

function cleanError(error: unknown) {
  return error && typeof error === 'object' && 'message' in error
    ? String(error.message).slice(0, 500)
    : 'Automatic bank sync failed.'
}

async function automaticAccounts(db: BankDatabase) {
  const accountsResult = await db.from('accounts').select('id,workspace_id,name,provider_account_id')
    .eq('auto_sync', true).eq('closed', false).order('sort_order', { ascending: true })
  if (accountsResult.error) throw accountsResult.error
  return ((accountsResult.data ?? []) as AutomaticAccount[]).filter((account) => Boolean(account.provider_account_id))
}

export async function runAutomaticBankSync(
  db: BankDatabase,
  syncAccount: (db: BankDatabase, workspaceId: string, accountId: string) => Promise<BankSyncSummary>,
  now = new Date(),
) {
  const accounts = await automaticAccounts(db)
  const date = cetDate(now)
  const results: AccountResult[] = []

  for (const account of accounts) {
    const startedAt = new Date().toISOString()
    try {
      const claimed = await claimAutomaticSync(db, account.workspace_id, account.id, date, startedAt)
      if (!claimed) {
        results.push({ accountId: account.id, accountName: account.name, status: 'skipped' })
        continue
      }
      const summary = await syncAccount(db, account.workspace_id, account.id)
      const completedAt = new Date().toISOString()
      await finishAutomaticSync(db, account.workspace_id, account.id, {
        date,
        status: 'completed',
        startedAt,
        completedAt,
        imported: summary.imported,
        warnings: summary.warnings,
      })
      results.push({ accountId: account.id, accountName: account.name, status: 'completed', imported: summary.imported, warnings: summary.warnings })
    } catch (error) {
      const message = cleanError(error)
      await finishAutomaticSync(db, account.workspace_id, account.id, {
        date,
        status: 'failed',
        startedAt,
        completedAt: new Date().toISOString(),
        error: message,
      }).catch(() => {})
      results.push({ accountId: account.id, accountName: account.name, status: 'failed', error: message })
    }
  }

  return { date, eligible: accounts.length, results }
}

export function createAutomaticBankSyncHandler(config: CronConfig) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'GET') {
      json(response, 405, { error: 'Method not allowed.' })
      return
    }
    if (!authorized(request, config.cronSecret)) {
      json(response, 401, { error: 'Unauthorized.' })
      return
    }
    if (!config.authUrl || !config.dataApiUrl || !config.email || !config.password || !config.appUrl) {
      json(response, 503, { error: 'Automatic bank sync authentication is not configured.' })
      return
    }

    try {
      let jwt = ''
      const authClient = createClient({
        auth: {
          url: config.authUrl,
          adapter: BetterAuthVanillaAdapter({
            fetchOptions: {
              headers: { Origin: new URL(config.appUrl).origin },
              onSuccess: (context) => { jwt = context.response.headers.get('set-auth-jwt') ?? jwt },
            },
          }),
        },
        dataApi: { url: config.dataApiUrl },
      })
      const signIn = await authClient.auth.signIn.email({ email: config.email, password: config.password })
      if (signIn.error) throw new Error('The automatic bank sync account could not sign in.')
      if (!jwt) throw new Error('The automatic bank sync account did not receive a database token.')
      const client = createClient({ dataApi: { url: config.dataApiUrl, getToken: async () => jwt } })
      const service = createGoCardlessService(config.gocardlessSecretId, config.gocardlessSecretKey)
      const db = client as unknown as BankDatabase
      const url = new URL(request.url ?? '/api/cron/bank-sync', config.appUrl)
      if (url.searchParams.get('dryRun') === '1') {
        const accounts = await automaticAccounts(db)
        json(response, 200, { dryRun: true, eligible: accounts.length })
        return
      }
      const result = await runAutomaticBankSync(db, service.syncAccount)
      const failed = result.results.filter((item) => item.status === 'failed')
      json(response, failed.length ? 500 : 200, { ...result, failed: failed.length })
    } catch (error) {
      json(response, 500, { error: cleanError(error) })
    }
  }
}
