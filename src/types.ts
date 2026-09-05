export type AccountScope = 'Personal' | 'Company'
export type BalanceSheetGroup = 'Personal' | 'Company' | 'Real estate' | 'Pension'
export type ReportGroup = 'income' | 'expense' | 'tax' | 'capital_gain'

export type Account = {
  id: string
  name: string
  type: 'Checking' | 'Savings' | 'Cash'
  balanceMinor: number
  color: string
  currency: string
  scope: AccountScope
  balanceSheetGroup: BalanceSheetGroup
  closed: boolean
  autoSync?: boolean
  bankImportMode?: 'review' | 'automatic'
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
  staged: number
  bookedImported: number
  pendingImported: number
  duplicates: number
  transfersMatched: number
  pendingPromoted: number
  cutoffIgnored: number
  futureIgnored: number
  balanceType?: string
  transactionError?: string
  balanceError?: string
}

export type BankImportCandidate = {
  id: string
  accountId: string
  date: string
  amountMinor: number
  currency: string
  type: 'expense' | 'income'
  payee: string
  payeeId?: string
  categoryId?: string
  note?: string
  posted: boolean
}

export type Category = {
  id: string
  name: string
  sortOrder?: number
  color: string
  icon: string
  reportGroup: ReportGroup
  categoryGroupId?: string
  hidden: boolean
}

export type CategoryGroup = {
  id: string
  name: string
  sortOrder: number
  showCategories: boolean
}

export type Payee = {
  id: string
  name: string
  defaultCategoryId?: string
  defaultAccountId?: string
}

export type PayeeMapping = {
  id: string
  sourceName: string
  payeeId: string
  matchType: 'exact' | 'starts_with'
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
  type: 'expense' | 'income' | 'transfer' | 'opening_balance'
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
  categoryGroups: CategoryGroup[]
  categories: Category[]
  payees: Payee[]
  payeeMappings: PayeeMapping[]
  budgets: Budget[]
  transactions: Transaction[]
  bankImportCandidates: BankImportCandidate[]
  settings: {
    estimatedCompanyTaxRateBps: number
  }
}
