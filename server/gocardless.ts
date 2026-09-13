import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { allowedOrigin, assertUUID, authorizeBankRequest, bankReference, verifyBankReference, BankHttpError } from './bank-authorization.ts'
import type { BankServerConfig } from './bank-authorization.ts'

const API_ROOT = 'https://bankaccountdata.gocardless.com/api/v2'

type Token = { access: string; expiresAt: number }
type RateLimit = { limit?: number; remaining?: number; resetSeconds?: number }
type TransactionStatus = 'booked' | 'pending'

class GoCardlessRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage) {
  const parsed = (request as IncomingMessage & { body?: unknown }).body
  if (parsed !== undefined) {
    const encoded = typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
    if (Buffer.byteLength(encoded) > 65536) throw new BankHttpError('Request body is too large.', 413)
    const value = typeof parsed === 'string' ? JSON.parse(parsed) : parsed
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BankHttpError('Invalid request body.', 400)
    return value as Record<string, unknown>
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk)
    if (size > 65536) throw new BankHttpError('Request body is too large.', 413)
    chunks.push(Buffer.from(chunk))
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BankHttpError('Invalid request body.', 400)
  return value as Record<string, unknown>
}

function cleanError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object') return fallback
  const body = payload as Record<string, unknown>
  return String(body.detail ?? body.summary ?? fallback)
}

function providerText(value: unknown) {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .join(' · ')
}

function normalizeTransactions(transactions: Record<string, unknown>[], status: TransactionStatus) {
  return transactions.flatMap((transaction) => {
    const amountObject = transaction.transactionAmount && typeof transaction.transactionAmount === 'object'
      ? transaction.transactionAmount as Record<string, unknown>
      : {}
    const amount = String(amountObject.amount ?? '')
    const currency = String(amountObject.currency ?? '').toUpperCase()
    const date = String(transaction.bookingDate ?? transaction.valueDate ?? transaction.transactionDate ?? '')
    if (!/^-?\d+(\.\d+)?$/.test(amount) || !/^[A-Z]{3}$/.test(currency) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
    const outgoing = Number(amount) < 0
    const remittance = providerText(transaction.remittanceInformationUnstructured)
      || providerText(transaction.remittanceInformationUnstructuredArray)
      || providerText(transaction.remittanceInformationStructured)
      || providerText(transaction.remittanceInformationStructuredArray)
      || providerText(transaction.additionalInformation)
    const payee = providerText(outgoing ? transaction.creditorName : transaction.debtorName)
      || providerText(transaction.creditorName)
      || providerText(transaction.debtorName)
      || remittance
      || 'Bank transaction'
    const note = remittance
    // The iOS app persisted internalTransactionId. Keep that field as the
    // canonical ID so migrated history remains deduplicatable.
    const bankTransactionId = transaction.transactionId ? String(transaction.transactionId) : null
    const nativeId = transaction.internalTransactionId ?? bankTransactionId ?? transaction.entryReference ?? transaction.endToEndId
    const fallbackKey = JSON.stringify({ date, amount, currency, payee, note, code: transaction.bankTransactionCode ?? '' })
    const providerTransactionId = nativeId
      ? String(nativeId)
      : `fallback:${createHash('sha256').update(fallbackKey).digest('hex')}`
    return [{ providerTransactionId, bankTransactionId, date, amount, currency, payee, note, type: outgoing ? 'expense' as const : 'income' as const, status, rawPayload: transaction }]
  })
}

export function createGoCardlessHandler(secretId: string | undefined, secretKey: string | undefined, config: BankServerConfig) {
  let token: Token | null = null

  async function accessToken() {
    if (token && token.expiresAt > Date.now() + 60_000) return token.access
    if (!secretId || !secretKey) throw new Error('GoCardless credentials are not configured on the server.')

    const response = await fetch(`${API_ROOT}/token/new/`, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret_id: secretId, secret_key: secretKey }),
    })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(cleanError(payload, `GoCardless authentication failed (${response.status}).`))
    token = {
      access: String(payload.access),
      expiresAt: Date.now() + Number(payload.access_expires ?? 86_400) * 1000,
    }
    return token.access
  }

  async function gcRequestWithMeta(path: string, init?: RequestInit) {
    const response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      signal: AbortSignal.timeout(25_000),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${await accessToken()}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    const payload = await response.json().catch(() => ({})) as unknown
    if (!response.ok) throw new GoCardlessRequestError(cleanError(payload, `GoCardless request failed (${response.status}).`), response.status)
    const numberHeader = (name: string) => {
      const value = response.headers.get(name)
      return value === null || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value)
    }
    const rateLimit: RateLimit = {
      limit: numberHeader('x-ratelimit-account-success-limit'),
      remaining: numberHeader('x-ratelimit-account-success-remaining'),
      resetSeconds: numberHeader('x-ratelimit-account-success-reset'),
    }
    return { payload, rateLimit }
  }

  async function gcRequest(path: string, init?: RequestInit) {
    return (await gcRequestWithMeta(path, init)).payload
  }

  return async (request: IncomingMessage, response: ServerResponse) => {
        try {
          if (!['GET', 'POST'].includes(request.method ?? '')) throw new BankHttpError('Method not allowed.', 405)
          const origin = request.headers.origin
          if (origin && !allowedOrigin(origin, config)) throw new BankHttpError('This origin is not allowed.', 403)
          const url = new URL(request.url ?? '/', 'http://localhost')
          url.pathname = url.pathname.replace(/^\/api\/gocardless/, '')
          const body = request.method === 'POST' ? await readJson(request) : {}
          const auth = await authorizeBankRequest(request, body.workspaceId ?? url.searchParams.get('workspaceId'), body.accountId ?? url.searchParams.get('accountId'), config)
          if (request.method === 'GET' && url.pathname === '/institutions') {
            const country = (url.searchParams.get('country') ?? 'ES').toUpperCase()
            if (!/^[A-Z]{2}$/.test(country)) throw new Error('Choose a valid two-letter country code.')
            json(response, 200, await gcRequest(`/institutions/?country=${encodeURIComponent(country)}`))
            return
          }

          if (request.method === 'POST' && url.pathname === '/requisitions') {
            const institutionId = String(body.institutionId ?? '')
            const redirect = String(body.redirect ?? '')
            if (!institutionId) throw new Error('Choose a bank before continuing.')
            if (!auth.accountId) throw new BankHttpError('Choose an account before linking a bank.', 400)
            const destination = new URL(redirect)
            if (!allowedOrigin(destination.origin, config) || destination.pathname !== `/accounts/${auth.accountId}` || destination.username || destination.password) throw new BankHttpError('The bank redirect must return to this account in Next Expense.', 400)
            if (!secretKey) throw new BankHttpError('Bank linking is not configured.', 503)
            const result = await gcRequest('/requisitions/', {
              method: 'POST',
              body: JSON.stringify({
                redirect,
                institution_id: institutionId,
                reference: bankReference(auth.workspaceId, auth.accountId, secretKey),
                user_language: 'EN',
              }),
            })
            json(response, 201, result)
            return
          }

          if (request.method === 'GET' && url.pathname === '/requisition') {
            const requisitionId = assertUUID(url.searchParams.get('id'), 'Bank connection')
            if (!auth.accountId || !secretKey) throw new BankHttpError('Choose an account before continuing.', 400)
            const requisition = await gcRequest(`/requisitions/${requisitionId}/`) as Record<string, unknown>
            if (!verifyBankReference(requisition.reference, auth.workspaceId, auth.accountId, secretKey)) throw new BankHttpError('This bank authorization does not belong to this account. Start a new bank connection.', 403)
            const accountIds = Array.isArray(requisition.accounts) ? requisition.accounts.map(String) : []
            const accounts = await Promise.all(accountIds.map(async (id) => {
              const metadata = await gcRequest(`/accounts/${id}/`) as Record<string, unknown>
              return {
                id,
                name: String(metadata.name ?? metadata.owner_name ?? 'Bank account'),
                iban: String(metadata.iban ?? ''),
                currency: '',
              }
            }))
            json(response, 200, {
              id: requisition.id,
              status: requisition.status,
              institutionId: requisition.institution_id,
              accounts,
            })
            return
          }

          if (request.method === 'POST' && url.pathname === '/sync') {
            if (!auth.accountId || !auth.providerAccountId) throw new BankHttpError('This account is not connected to a bank.', 403)
            const connections = await auth.read('bank_connections', { select: 'id,provider_connection_id', workspace_id: `eq.${auth.workspaceId}`, account_id: `eq.${auth.accountId}`, provider: 'eq.gocardless_bank_account_data', status: 'eq.active', limit: '1' })
            if (!connections.length) throw new BankHttpError('There is no active bank connection for this account.', 403)
            // Account/connection rows are client-editable. Prove the binding
            // against the provider's signed reference before reading bank data.
            const requisitionId = assertUUID(connections[0].provider_connection_id, 'Bank connection')
            const requisition = await gcRequest(`/requisitions/${requisitionId}/`) as Record<string, unknown>
            if (!secretKey || !verifyBankReference(requisition.reference, auth.workspaceId, auth.accountId, secretKey)) throw new BankHttpError('Reconnect this bank account to authorize secure hosted sync.', 403)
            if (!Array.isArray(requisition.accounts) || !requisition.accounts.includes(auth.providerAccountId)) throw new BankHttpError('This bank account is not part of your authorization.', 403)
            const accountId = auth.providerAccountId
            const dateFrom = String(body.dateFrom ?? '')
            if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new Error('The connected bank account reference is invalid.')
            if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) throw new Error('The transaction start date is invalid.')

            const transactionPath = `/accounts/${accountId}/transactions/${dateFrom ? `?date_from=${encodeURIComponent(dateFrom)}` : ''}`
            const [transactionAttempt, balanceAttempt] = await Promise.allSettled([
              gcRequestWithMeta(transactionPath),
              gcRequestWithMeta(`/accounts/${accountId}/balances/`),
            ])
            if (transactionAttempt.status === 'rejected' && balanceAttempt.status === 'rejected') throw transactionAttempt.reason

            const transactionResponse = transactionAttempt.status === 'fulfilled' ? transactionAttempt.value : null
            const balanceResponse = balanceAttempt.status === 'fulfilled' ? balanceAttempt.value : null
            const transactionPayload = (transactionResponse?.payload ?? {}) as Record<string, unknown>
            const transactionGroups = transactionPayload.transactions && typeof transactionPayload.transactions === 'object'
              ? transactionPayload.transactions as Record<string, unknown>
              : {}
            const booked = Array.isArray(transactionGroups.booked) ? transactionGroups.booked as Record<string, unknown>[] : []
            const pending = Array.isArray(transactionGroups.pending) ? transactionGroups.pending as Record<string, unknown>[] : []
            const normalizedBooked = normalizeTransactions(booked, 'booked')
            const normalizedPending = normalizeTransactions(pending, 'pending')
            const normalizedTransactions = [...normalizedPending, ...normalizedBooked]

            const balancePayload = (balanceResponse?.payload ?? {}) as Record<string, unknown>
            const balances = Array.isArray(balancePayload.balances) ? balancePayload.balances as Record<string, unknown>[] : []
            const balancePriority = ['interimAvailable', 'expected', 'interimBooked', 'closingBooked', 'closingAvailable']
            const sortedBalances = [...balances].sort((left, right) => {
              const leftRank = balancePriority.indexOf(String(left.balanceType))
              const rightRank = balancePriority.indexOf(String(right.balanceType))
              return (leftRank < 0 ? 99 : leftRank) - (rightRank < 0 ? 99 : rightRank)
            })
            const selectedBalance = sortedBalances.find((balance) => {
              const value = balance.balanceAmount && typeof balance.balanceAmount === 'object' ? balance.balanceAmount as Record<string, unknown> : {}
              return /^-?\d+(\.\d+)?$/.test(String(value.amount ?? '')) && /^[A-Z]{3}$/.test(String(value.currency ?? ''))
            })
            const balanceAmount = selectedBalance?.balanceAmount && typeof selectedBalance.balanceAmount === 'object'
              ? selectedBalance.balanceAmount as Record<string, unknown>
              : null

            json(response, 200, {
              transactions: normalizedTransactions,
              rawProviderResponse: {
                transactions: transactionResponse?.payload ?? null,
                balances: balanceResponse?.payload ?? null,
              },
              providerDiagnostics: {
                bookedReturned: booked.length,
                pendingReturned: pending.length,
                malformedIgnored: booked.length + pending.length - normalizedTransactions.length,
              },
              balance: balanceAmount ? {
                amount: String(balanceAmount.amount),
                currency: String(balanceAmount.currency).toUpperCase(),
                type: String(selectedBalance?.balanceType ?? ''),
              } : null,
              rateLimits: {
                transactions: transactionResponse?.rateLimit,
                balances: balanceResponse?.rateLimit,
              },
              errors: {
                transactions: transactionAttempt.status === 'rejected' ? cleanError(transactionAttempt.reason, transactionAttempt.reason instanceof Error ? transactionAttempt.reason.message : 'Transactions could not be retrieved.') : null,
                balances: balanceAttempt.status === 'rejected' ? cleanError(balanceAttempt.reason, balanceAttempt.reason instanceof Error ? balanceAttempt.reason.message : 'The balance could not be retrieved.') : null,
              },
              fetchedAt: new Date().toISOString(),
            })
            return
          }

          json(response, 404, { error: 'Unknown GoCardless endpoint.' })
        } catch (error) {
          json(response, error instanceof GoCardlessRequestError || error instanceof BankHttpError ? error.status : error instanceof SyntaxError ? 400 : 500, { error: error instanceof Error ? error.message : 'The GoCardless request failed.' })
        }
  }
}
