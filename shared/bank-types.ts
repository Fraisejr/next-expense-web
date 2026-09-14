import type { BankRateLimit, BankSyncDiagnostic } from '../src/types.ts'

export type BankSyncPayload = {
  transactions: Array<{
    providerTransactionId: string
    bankTransactionId?: string | null
    date: string
    amount: string
    currency: string
    payee: string
    note: string
    type: 'expense' | 'income'
    status: 'booked' | 'pending'
    rawPayload?: unknown
  }>
  rawProviderResponse?: {
    transactions: unknown
    balances: unknown
  }
  providerDiagnostics?: {
    bookedReturned: number
    pendingReturned: number
    malformedIgnored: number
  }
  balance: { amount: string; currency: string; type: string } | null
  rateLimits: { transactions?: BankRateLimit; balances?: BankRateLimit }
  errors?: { transactions?: string | null; balances?: string | null }
  fetchedAt: string
}

export type BankSyncSummary = {
  imported: number
  duplicates: number
  balanceUpdated: boolean
  rateLimits: BankSyncPayload['rateLimits']
  syncedAt: string
  syncRunsLast24Hours: number
  diagnostic: BankSyncDiagnostic
  warnings: string[]
}
