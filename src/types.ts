export type AccountScope = 'Personal' | 'Company'
export type ReportGroup = 'income' | 'expense' | 'tax' | 'capital_gain'

export type Account = {
  id: string
  name: string
  type: 'Checking' | 'Savings' | 'Cash'
  balanceMinor: number
  color: string
  currency: string
  scope: AccountScope
  closed: boolean
  autoSync?: boolean
  providerAccountId?: string
  institutionId?: string
  country?: string
  lastSyncedAt?: string
  syncRunsLast24Hours?: number
  bankBalanceMinor?: number
  bankBalanceCurrency?: string
  bankBalanceUpdatedAt?: string
  lastSyncDiagnostic?: BankSyncDiagnostic
  connectionStatus?: 'active' | 'expired' | 'revoked' | 'error'
  rateLimits?: {
    transactions?: BankRateLimit
    balances?: BankRateLimit
  }
}

export type BankRateLimit = {
  limit?: number
  remaining?: number
  resetSeconds?: number
}

export type BankSyncDiagnostic = {
  fetchedAt: string
  bookedReturned: number
  pendingReturned: number
  malformedIgnored: number
  imported: number
  bookedImported: number
  pendingImported: number
  duplicates: number
  pendingPromoted: number
  cutoffIgnored: number
  futureIgnored: number
  balanceType?: string
  transactionError?: string
  balanceError?: string
}

export type Category = {
  id: string
  name: string
  color: string
  icon: string
  reportGroup: ReportGroup
  hidden: boolean
}

export type Payee = {
  id: string
  name: string
}

export type Budget = {
  id: string
  month: string
  categoryId: string
  scope: AccountScope
  amountMinor: number
}

export type Transaction = {
  id: string
  date: string
  payee: string
  payeeId?: string
  note?: string
  amountMinor: number
  destinationAmountMinor?: number
  type: 'expense' | 'income' | 'transfer'
  accountId: string
  categoryId?: string
  toAccountId?: string
  currency: string
  payeeRaw?: string
  source?: 'manual' | 'ios_import' | 'gocardless'
  sourceRowHash?: string
  providerTransactionId?: string
  posted?: boolean
}

export type AppData = {
  accounts: Account[]
  categories: Category[]
  payees: Payee[]
  budgets: Budget[]
  transactions: Transaction[]
  settings: {
    estimatedCompanyTaxRateBps: number
  }
}
