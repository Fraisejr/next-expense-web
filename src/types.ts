export type Account = {
  id: string
  name: string
  type: 'Checking' | 'Savings' | 'Cash'
  balanceMinor: number
  color: string
  currency: 'EUR'
}

export type Category = {
  id: string
  name: string
  budgetMinor: number
  color: string
  icon: string
  kind: 'expense' | 'income'
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
  transactions: Transaction[]
}
