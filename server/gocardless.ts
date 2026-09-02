import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { Plugin } from 'vite'

const API_ROOT = 'https://bankaccountdata.gocardless.com/api/v2'

type Token = { access: string; expiresAt: number }
type RateLimit = { limit?: number; remaining?: number; resetSeconds?: number }

class GoCardlessRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
}

function cleanError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object') return fallback
  const body = payload as Record<string, unknown>
  return String(body.detail ?? body.summary ?? fallback)
}

export function goCardlessDevApi(secretId: string | undefined, secretKey: string | undefined): Plugin {
  let token: Token | null = null

  async function accessToken() {
    if (token && token.expiresAt > Date.now() + 60_000) return token.access
    if (!secretId || !secretKey) throw new Error('GoCardless credentials are not configured on the local server.')

    const response = await fetch(`${API_ROOT}/token/new/`, {
      method: 'POST',
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

  return {
    name: 'next-expense-gocardless-dev-api',
    configureServer(server) {
      server.middlewares.use('/api/gocardless', async (request, response) => {
        try {
          const origin = request.headers.origin
          if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
            json(response, 403, { error: 'This local integration only accepts requests from localhost.' })
            return
          }

          const url = new URL(request.url ?? '/', 'http://localhost')
          if (request.method === 'GET' && url.pathname === '/institutions') {
            const country = (url.searchParams.get('country') ?? 'ES').toUpperCase()
            if (!/^[A-Z]{2}$/.test(country)) throw new Error('Choose a valid two-letter country code.')
            json(response, 200, await gcRequest(`/institutions/?country=${encodeURIComponent(country)}`))
            return
          }

          if (request.method === 'POST' && url.pathname === '/requisitions') {
            const body = await readJson(request)
            const institutionId = String(body.institutionId ?? '')
            const redirect = String(body.redirect ?? '')
            if (!institutionId) throw new Error('Choose a bank before continuing.')
            if (!/^http:\/\/localhost:\d+\//.test(redirect)) throw new Error('The bank redirect must return to localhost.')
            const result = await gcRequest('/requisitions/', {
              method: 'POST',
              body: JSON.stringify({
                redirect,
                institution_id: institutionId,
                reference: crypto.randomUUID(),
                user_language: 'EN',
              }),
            })
            json(response, 201, result)
            return
          }

          if (request.method === 'GET' && url.pathname === '/requisition') {
            const requisitionId = url.searchParams.get('id') ?? ''
            if (!/^[0-9a-f-]{36}$/i.test(requisitionId)) throw new Error('The bank connection reference is invalid.')
            const requisition = await gcRequest(`/requisitions/${requisitionId}/`) as Record<string, unknown>
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
            const body = await readJson(request)
            const accountId = String(body.providerAccountId ?? '')
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
            const normalizedTransactions = booked.flatMap((transaction) => {
              const amountObject = transaction.transactionAmount && typeof transaction.transactionAmount === 'object'
                ? transaction.transactionAmount as Record<string, unknown>
                : {}
              const amount = String(amountObject.amount ?? '')
              const currency = String(amountObject.currency ?? '').toUpperCase()
              const date = String(transaction.bookingDate ?? transaction.valueDate ?? '')
              if (!/^-?\d+(\.\d+)?$/.test(amount) || !/^[A-Z]{3}$/.test(currency) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
              const signedAmount = Number(amount)
              const outgoing = signedAmount < 0
              const payee = String(
                (outgoing ? transaction.creditorName : transaction.debtorName)
                ?? transaction.creditorName
                ?? transaction.debtorName
                ?? transaction.remittanceInformationUnstructured
                ?? transaction.additionalInformation
                ?? 'Bank transaction',
              )
              const note = String(transaction.remittanceInformationUnstructured ?? transaction.additionalInformation ?? '')
              // The iOS app persisted internalTransactionId. Keep that field as
              // the canonical ID so migrated history remains deduplicatable.
              const bankTransactionId = transaction.transactionId ? String(transaction.transactionId) : null
              const nativeId = transaction.internalTransactionId ?? bankTransactionId ?? transaction.entryReference ?? transaction.endToEndId
              const fallbackKey = JSON.stringify({ date, amount, currency, payee, note, code: transaction.bankTransactionCode ?? '' })
              const providerTransactionId = nativeId
                ? String(nativeId)
                : `fallback:${createHash('sha256').update(fallbackKey).digest('hex')}`
              return [{ providerTransactionId, bankTransactionId, date, amount, currency, payee, note, type: outgoing ? 'expense' : 'income' }]
            })

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
          json(response, error instanceof GoCardlessRequestError ? error.status : 500, { error: error instanceof Error ? error.message : 'The GoCardless request failed.' })
        }
      })
    },
  }
}
