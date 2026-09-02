export type AccountScope = 'Personal' | 'Company'
export type ReportGroup = 'income' | 'expense' | 'tax' | 'capital_gain'

export type Account = {
  id: string
  name: string
  type: 'Checking' | 'Savings' | 'Cash'
  balanceMinor: number
  color: string
  currency: 'EUR'
  scope: AccountScope
}

export type Category = {
  id: string
  name: string
  color: string
  icon: string
  reportGroup: ReportGroup
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
  merchant: string
  note?: string
  amountMinor: number
  type: 'expense' | 'income' | 'transfer'
  accountId: string
  categoryId?: string
  toAccountId?: string
  currency: 'EUR'
  payeeRaw?: string
  source?: 'manual' | 'ios_import'
  sourceRowHash?: string
}

export type AppData = {
  accounts: Account[]
  categories: Category[]
  budgets: Budget[]
  transactions: Transaction[]
  settings: {
    estimatedCompanyTaxRateBps: number
  }
}
