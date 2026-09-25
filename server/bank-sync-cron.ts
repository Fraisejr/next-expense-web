import { BetterAuthVanillaAdapter, createClient } from '@neondatabase/neon-js'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BankDatabase } from '../shared/bank-data.ts'
import type { BankSyncSummary } from '../shared/bank-types.ts'
import { bankClient, claimAutomaticSync, finishAutomaticSync } from './bank-sync.ts'
import { createCronRunReporter, type CronAccountResult } from './cron-diagnostics.ts'
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
  diagnosticsDatabaseUrl?: string
  deploymentId?: string
  deploymentUrl?: string
  gitCommitSha?: string
}

type AutomaticAccount = {
  id: string
  workspace_id: string
  name: string
  provider_account_id: string | null
  auto_sync: boolean
  closed: boolean
}

type AccountResult = CronAccountResult

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
  const accountsResult = await db.from('accounts').select('id,workspace_id,name,provider_account_id,auto_sync,closed')
    .order('sort_order', { ascending: true })
  if (accountsResult.error) throw accountsResult.error
  return ((accountsResult.data ?? []) as AutomaticAccount[]).filter((account) => (
    account.auto_sync === true && account.closed !== true && Boolean(account.provider_account_id)
  ))
}

export async function runAutomaticBankSync(
  db: BankDatabase,
  syncAccount: (db: BankDatabase, workspaceId: string, accountId: string) => Promise<BankSyncSummary>,
  now = new Date(),
  onProgress?: (results: AccountResult[]) => Promise<void>,
  suppliedAccounts?: AutomaticAccount[],
) {
  const accounts = suppliedAccounts ?? await automaticAccounts(db)
  const date = cetDate(now)
  const results: AccountResult[] = []

  for (const account of accounts) {
    const startedAt = new Date().toISOString()
    try {
      const claimed = await claimAutomaticSync(db, account.workspace_id, account.id, date, startedAt)
      if (!claimed) {
        results.push({ accountId: account.id, accountName: account.name, status: 'skipped' })
        await onProgress?.([...results])
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
    await onProgress?.([...results])
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
    const url = new URL(request.url ?? '/api/cron/bank-sync', config.appUrl ?? 'https://next-expense.invalid')
    const dryRun = url.searchParams.get('dryRun') === '1'
    const now = new Date()
    const reporter = createCronRunReporter(config.diagnosticsDatabaseUrl, {
      runDate: cetDate(now),
      dryRun,
      deploymentId: config.deploymentId,
      deploymentUrl: config.deploymentUrl,
      gitCommitSha: config.gitCommitSha,
      requestId: typeof request.headers['x-vercel-id'] === 'string' ? request.headers['x-vercel-id'] : undefined,
      userAgent: request.headers['user-agent'],
    })
    await reporter.start()
    if (!config.authUrl || !config.dataApiUrl || !config.email || !config.password || !config.appUrl) {
      await reporter.checkpoint({
        phase: 'failed', status: 'failed', error: 'Automatic bank sync authentication is not configured.', responseStatus: 503,
      })
      json(response, 503, { error: 'Automatic bank sync authentication is not configured.' })
      return
    }

    try {
      await reporter.checkpoint({ phase: 'authenticating' })
      let jwt = ''
      const cookies = new Map<string, string>()
      const origin = new URL(config.appUrl).origin
      const authClient = createClient({
        auth: {
          url: config.authUrl,
          adapter: BetterAuthVanillaAdapter({
            fetchOptions: {
              headers: { Origin: origin },
              onSuccess: (context) => {
                jwt = context.response.headers.get('set-auth-jwt') ?? jwt
                for (const value of context.response.headers.getSetCookie()) {
                  const pair = value.split(';', 1)[0]
                  const name = pair.slice(0, pair.indexOf('='))
                  if (name) cookies.set(name, pair)
                }
              },
            },
          }),
        },
        dataApi: { url: config.dataApiUrl },
      })
      const signIn = await authClient.auth.signIn.email({ email: config.email, password: config.password })
      if (signIn.error) throw new Error('The automatic bank sync account could not sign in.')
      if (!jwt && cookies.size) {
        const session = await fetch(`${config.authUrl.replace(/\/$/, '')}/get-session`, {
          headers: { Accept: 'application/json', Cookie: [...cookies.values()].join('; '), Origin: origin },
          signal: AbortSignal.timeout(15_000),
        })
        if (session.ok) jwt = session.headers.get('set-auth-jwt') ?? ''
      }
      if (!jwt) throw new Error('The automatic bank sync account did not receive a database token.')
      const service = createGoCardlessService(config.gocardlessSecretId, config.gocardlessSecretKey)
      // Use the same Data API client as a manual sync, including its query
      // semantics, while authenticating with the cron account's JWT.
      const db = bankClient(config.dataApiUrl, `Bearer ${jwt}`)
      const memberships = await db.from('workspace_members').select('workspace_id')
      if (memberships.error) throw memberships.error
      const workspaceIds = (memberships.data ?? []).map((membership) => String(membership.workspace_id))
      await reporter.checkpoint({ phase: 'authenticated', workspaceIds })
      if (dryRun) {
        const [visibleAccounts, accounts] = await Promise.all([
          db.from('accounts').select('id,provider_account_id,auto_sync,closed'),
          automaticAccounts(db),
        ])
        if (visibleAccounts.error) throw visibleAccounts.error
        await reporter.checkpoint({
          phase: 'completed', status: 'completed', workspaceIds, eligible: accounts.length, responseStatus: 200,
        })
        json(response, 200, {
          dryRun: true,
          runId: reporter.id,
          memberships: workspaceIds.length,
          visibleAccounts: visibleAccounts.data?.length ?? 0,
          connectedAccounts: (visibleAccounts.data ?? []).filter((account) => Boolean(account.provider_account_id)).length,
          eligible: accounts.length,
        })
        return
      }
      const accounts = await automaticAccounts(db)
      await reporter.checkpoint({ phase: 'enumerated', workspaceIds, eligible: accounts.length })
      const result = await runAutomaticBankSync(db, service.syncAccount, now, async (results) => {
        await reporter.checkpoint({ phase: 'syncing', workspaceIds, eligible: accounts.length, results })
      }, accounts)
      const failed = result.results.filter((item) => item.status === 'failed')
      const status = failed.length ? 500 : 200
      await reporter.checkpoint({
        phase: failed.length ? 'failed' : 'completed',
        status: failed.length ? 'failed' : 'completed',
        workspaceIds,
        eligible: accounts.length,
        results: result.results,
        error: failed.length ? `${failed.length} account sync${failed.length === 1 ? '' : 's'} failed.` : undefined,
        responseStatus: status,
      })
      json(response, status, { ...result, runId: reporter.id, failed: failed.length })
    } catch (error) {
      const message = cleanError(error)
      await reporter.checkpoint({ phase: 'failed', status: 'failed', error: message, responseStatus: 500 })
      json(response, 500, { runId: reporter.id, error: message })
    }
  }
}
