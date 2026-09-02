import { neon } from './neon'
import type { Account, AccountScope, AppData, BankRateLimit, Budget, Category, ReportGroup, Transaction } from './types'

type Row = Record<string, unknown>

export class WorkspaceNotLinkedError extends Error {
  constructor() {
    super('Your account has not been linked to the imported workspace yet.')
  }
}

function number(value: unknown) {
  return Number(value ?? 0)
}

async function allRows(table: string, columns = '*', orderColumn = 'id'): Promise<Row[]> {
  const pageSize = 1000
  const rows: Row[] = []

  for (let start = 0; ; start += pageSize) {
    let query = neon.from(table).select(columns).order(orderColumn, { ascending: true })
    if (orderColumn !== 'id') query = query.order('id', { ascending: true })
    const { data, error } = await query.range(start, start + pageSize - 1)
    if (error) throw error
    const page = (data ?? []) as unknown as Row[]
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

function accountBalanceChanges(transactions: Transaction[]) {
  const changes = new Map<string, number>()
  const add = (accountId: string | undefined, amount: number) => {
    if (accountId) changes.set(accountId, (changes.get(accountId) ?? 0) + amount)
  }

  for (const transaction of transactions) {
    if (transaction.type === 'income') add(transaction.accountId, transaction.amountMinor)
    if (transaction.type === 'expense') add(transaction.accountId, -transaction.amountMinor)
    if (transaction.type === 'transfer') {
      add(transaction.accountId, -transaction.amountMinor)
      add(transaction.toAccountId, transaction.destinationAmountMinor ?? transaction.amountMinor)
    }
  }
  return changes
}

export type LoadedWorkspace = {
  workspaceId: string
  workspaceName: string
  defaultCurrency: string
  data: AppData
}

export async function loadWorkspace(): Promise<LoadedWorkspace> {
  const { data: memberships, error: membershipError } = await neon
    .from('workspace_members')
    .select('workspace_id')
    .limit(1)
  if (membershipError) throw membershipError
  const workspaceId = (memberships?.[0] as Row | undefined)?.workspace_id as string | undefined
  if (!workspaceId) throw new WorkspaceNotLinkedError()

  const [workspaceResult, accountRows, categoryRows, periodRows, budgetRows, payeeRows, transactionRows, connectionRows] = await Promise.all([
    neon.from('workspaces').select('name,default_currency,estimated_company_tax_rate_bps').eq('id', workspaceId).limit(1),
    allRows('accounts', '*', 'sort_order'),
    allRows('categories', '*', 'sort_order'),
    allRows('periods', '*', 'period_start_date'),
    allRows('budgets'),
    allRows('payees', '*', 'sort_order'),
    allRows('transactions'),
    allRows('bank_connections'),
  ])
  if (workspaceResult.error) throw workspaceResult.error

  const payees = new Map(payeeRows.map((row) => [row.id as string, row.name as string]))
  const periods = new Map(periodRows.map((row) => [row.id as string, `${row.year}-${String(row.month).padStart(2, '0')}`]))
  const transactions: Transaction[] = transactionRows.map((row) => ({
    id: row.id as string,
    date: row.transaction_date as string,
    merchant: (row.payee_name || payees.get(row.payee_id as string) || row.memo || 'Unknown payee') as string,
    note: (row.memo as string | null) ?? undefined,
    amountMinor: number(row.amount_minor),
    destinationAmountMinor: row.destination_amount_minor ? number(row.destination_amount_minor) : undefined,
    type: row.transaction_type as Transaction['type'],
    accountId: row.account_id as string,
    categoryId: (row.category_id as string | null) ?? undefined,
    toAccountId: (row.destination_account_id as string | null) ?? undefined,
    currency: row.currency as string,
    payeeRaw: (row.payee_name as string | null) ?? undefined,
    source: row.source as Transaction['source'],
    providerTransactionId: (row.provider_transaction_id as string | null) ?? undefined,
  }))
  const balanceChanges = accountBalanceChanges(transactions)
  const connections = new Map(connectionRows
    .filter((row) => row.account_id && row.status === 'active')
    .map((row) => [row.account_id as string, row]))
  const accounts: Account[] = accountRows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    type: row.display_type as Account['type'],
    balanceMinor: number(row.opening_balance_minor) + (balanceChanges.get(row.id as string) ?? 0),
    color: row.color as string,
    currency: row.currency as string,
    scope: row.scope as AccountScope,
    closed: Boolean(row.closed),
    autoSync: Boolean(row.auto_sync),
    providerAccountId: (row.provider_account_id as string | null) ?? undefined,
    institutionId: (row.institution_id as string | null) ?? undefined,
    country: (row.country as string | null) ?? undefined,
    lastSyncedAt: (connections.get(row.id as string)?.last_synced_at as string | null) ?? undefined,
    connectionStatus: (connections.get(row.id as string)?.status as Account['connectionStatus'] | undefined),
    rateLimits: ((connections.get(row.id as string)?.metadata as Row | undefined)?.rate_limits as Account['rateLimits'] | undefined),
  }))
  const categories: Category[] = categoryRows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    color: (row.color as string | null) ?? '#5d7d91',
    icon: (row.icon as string | null) ?? 'sparkles',
    reportGroup: row.report_group as ReportGroup,
  }))
  const budgets: Budget[] = budgetRows.flatMap((row) => {
    const month = periods.get(row.period_id as string)
    return month ? [{
      id: row.id as string,
      month,
      categoryId: row.category_id as string,
      scope: row.scope as AccountScope,
      amountMinor: number(row.amount_minor),
    }] : []
  })
  const workspace = (workspaceResult.data?.[0] as unknown as Row | undefined)
  if (!workspace) throw new Error('The linked workspace could not be read.')

  return {
    workspaceId,
    workspaceName: workspace.name as string,
    defaultCurrency: workspace.default_currency as string,
    data: {
      accounts,
      categories,
      budgets,
      transactions,
      settings: { estimatedCompanyTaxRateBps: number(workspace.estimated_company_tax_rate_bps) },
    },
  }
}

export async function createAccount(workspaceId: string, account: Account) {
  const { error } = await neon.from('accounts').insert({
    id: account.id,
    workspace_id: workspaceId,
    name: account.name,
    account_type: account.type === 'Savings' ? 'External' : 'Budget',
    display_type: account.type,
    scope: account.scope,
    currency: account.currency,
    color: account.color,
    opening_balance_minor: account.balanceMinor,
    closed: account.closed,
  })
  if (error) throw error
}

export async function createCategory(workspaceId: string, category: Category) {
  const categoryType = category.reportGroup === 'income' ? 'Income' : category.reportGroup === 'capital_gain' ? 'Investment' : 'Expense'
  const { error } = await neon.from('categories').insert({
    id: category.id,
    workspace_id: workspaceId,
    name: category.name,
    category_type: categoryType,
    report_group: category.reportGroup,
    color: category.color,
    icon: category.icon,
  })
  if (error) throw error
}

async function ensurePeriod(workspaceId: string, monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number)
  const existing = await neon.from('periods').select('id').eq('workspace_id', workspaceId).eq('year', year).eq('month', month).limit(1)
  if (existing.error) throw existing.error
  if (existing.data?.[0]) return (existing.data[0] as Row).id as string

  const id = crypto.randomUUID()
  const { error } = await neon.from('periods').insert({
    id,
    workspace_id: workspaceId,
    year,
    month,
    month_label: new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1)),
    period_start_date: `${monthKey}-01`,
    source_start_at: `${monthKey}-01T12:00:00Z`,
  })
  if (error) throw error
  return id
}

export async function saveBudget(workspaceId: string, budget: Budget) {
  const periodId = await ensurePeriod(workspaceId, budget.month)
  const row = {
    id: budget.id,
    workspace_id: workspaceId,
    period_id: periodId,
    category_id: budget.categoryId,
    scope: budget.scope,
    amount_minor: budget.amountMinor,
  }
  const { error } = await neon.from('budgets').upsert(row, { onConflict: 'id' })
  if (error) throw error
}

export async function createTransaction(workspaceId: string, transaction: Transaction) {
  const periodId = await ensurePeriod(workspaceId, transaction.date.slice(0, 7))
  const { error } = await neon.from('transactions').insert({
    id: transaction.id,
    workspace_id: workspaceId,
    account_id: transaction.accountId,
    destination_account_id: transaction.toAccountId ?? null,
    period_id: periodId,
    category_id: transaction.categoryId ?? null,
    transaction_date: transaction.date,
    source_timestamp: `${transaction.date}T12:00:00Z`,
    source_created_at: new Date().toISOString(),
    amount_minor: transaction.amountMinor,
    destination_amount_minor: transaction.destinationAmountMinor ?? (transaction.type === 'transfer' ? transaction.amountMinor : 0),
    currency: transaction.currency,
    transaction_type: transaction.type,
    payee_name: transaction.merchant,
    memo: transaction.note ?? null,
    posted: true,
    reconciled: true,
    source: 'manual',
  })
  if (error) throw error
}

export async function updateTaxRate(workspaceId: string, estimatedCompanyTaxRateBps: number) {
  const { error } = await neon.from('workspaces').update({ estimated_company_tax_rate_bps: estimatedCompanyTaxRateBps }).eq('id', workspaceId)
  if (error) throw error
}

export async function linkBankAccount(workspaceId: string, accountId: string, connection: {
  requisitionId: string
  providerAccountId: string
  institutionId: string
  country: string
}) {
  const previousResult = await neon.from('bank_connections').update({ status: 'expired' })
    .eq('workspace_id', workspaceId)
    .eq('account_id', accountId)
    .eq('provider', 'gocardless_bank_account_data')
    .eq('status', 'active')
  if (previousResult.error) throw previousResult.error

  const accountResult = await neon.from('accounts').update({
    provider_account_id: connection.providerAccountId,
    institution_id: connection.institutionId,
    country: connection.country,
    auto_sync: true,
    last_refresh_at: new Date().toISOString(),
  }).eq('workspace_id', workspaceId).eq('id', accountId)
  if (accountResult.error) throw accountResult.error

  const connectionResult = await neon.from('bank_connections').upsert({
    workspace_id: workspaceId,
    account_id: accountId,
    provider: 'gocardless_bank_account_data',
    provider_connection_id: connection.requisitionId,
    institution_id: connection.institutionId,
    status: 'active',
    metadata: { provider_account_id: connection.providerAccountId, country: connection.country },
  }, { onConflict: 'workspace_id,provider,provider_connection_id' })
  if (connectionResult.error) throw connectionResult.error
}

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
  }>
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
  warnings: string[]
}

function amountToMinor(value: string, currency: string) {
  let fractionDigits = 2
  try {
    fractionDigits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
  }
  const amount = Number(value)
  const minor = Math.round(Math.abs(amount) * 10 ** fractionDigits)
  if (!Number.isSafeInteger(minor)) throw new Error(`The bank returned an invalid ${currency} amount.`)
  return minor
}

function todayInParis() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

async function accountTransactionRows(workspaceId: string, accountId: string) {
  const pageSize = 1000
  const rows: Row[] = []
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await neon.from('transactions')
      .select('account_id,destination_account_id,amount_minor,destination_amount_minor,transaction_type')
      .eq('workspace_id', workspaceId)
      .or(`account_id.eq.${accountId},destination_account_id.eq.${accountId}`)
      .range(start, start + pageSize - 1)
    if (error) throw error
    const page = (data ?? []) as unknown as Row[]
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

export async function saveBankSync(workspaceId: string, account: Account, sync: BankSyncPayload): Promise<BankSyncSummary> {
  if (!account.providerAccountId) throw new Error('This account is not connected to a bank.')

  const connectionResult = await neon.from('bank_connections')
    .select('id,metadata')
    .eq('workspace_id', workspaceId)
    .eq('account_id', account.id)
    .eq('provider', 'gocardless_bank_account_data')
    .eq('status', 'active')
    .limit(1)
  if (connectionResult.error) throw connectionResult.error
  const connection = connectionResult.data?.[0] as Row | undefined
  const connectionMetadata = connection?.metadata && typeof connection.metadata === 'object' ? connection.metadata as Row : {}

  const unique = new Map(sync.transactions.map((transaction) => [transaction.providerTransactionId, transaction]))
  const existingIds = new Set<string>()
  const existingBankIds = new Set<string>()
  const existingBankFingerprints = new Map<string, Row[]>()
  let hasGoCardlessHistory = false
  let latestLedgerDate = ''
  const pageSize = 1000
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await neon.from('transactions')
      .select('id,provider_transaction_id,bank_transaction_id,transaction_date,source,amount_minor,currency,transaction_type,payee_name')
      .eq('workspace_id', workspaceId)
      .eq('account_id', account.id)
      .order('id', { ascending: true })
      .range(start, start + pageSize - 1)
    if (error) throw error
    const page = (data ?? []) as unknown as Row[]
    for (const row of page) {
      if (row.provider_transaction_id) {
        existingIds.add(String(row.provider_transaction_id))
      }
      if (row.bank_transaction_id) existingBankIds.add(String(row.bank_transaction_id))
      if (row.source === 'gocardless') {
        hasGoCardlessHistory = true
        const key = `${row.transaction_date}|${row.currency}|${row.transaction_type}|${row.amount_minor}|${String(row.payee_name ?? '').trim().toLocaleLowerCase('en')}`
        existingBankFingerprints.set(key, [...(existingBankFingerprints.get(key) ?? []), row])
      }
      if (String(row.transaction_date ?? '') > latestLedgerDate) latestLedgerDate = String(row.transaction_date)
    }
    if (page.length < pageSize) break
  }

  for (const transaction of unique.values()) {
    if (existingIds.has(transaction.providerTransactionId)) continue
    if (transaction.bankTransactionId && existingBankIds.has(transaction.bankTransactionId)) continue
    const fingerprint = `${transaction.date}|${transaction.currency}|${transaction.type}|${amountToMinor(transaction.amount, transaction.currency)}|${transaction.payee.trim().toLocaleLowerCase('en')}`
    const matches = existingBankFingerprints.get(fingerprint) ?? []
    if (matches.length !== 1) continue
    const repairResult = await neon.from('transactions')
      .update({
        provider_transaction_id: transaction.providerTransactionId,
        bank_transaction_id: transaction.bankTransactionId ?? null,
      })
      .eq('workspace_id', workspaceId)
      .eq('id', matches[0].id)
    if (repairResult.error) throw repairResult.error
    existingIds.add(transaction.providerTransactionId)
    if (transaction.bankTransactionId) existingBankIds.add(transaction.bankTransactionId)
  }

  const legacyCutoff = String(connectionMetadata.legacy_cutoff ?? (!hasGoCardlessHistory ? latestLedgerDate : ''))
  const newTransactions = [...unique.values()]
    .filter((transaction) => !existingIds.has(transaction.providerTransactionId))
    .filter((transaction) => !transaction.bankTransactionId || !existingBankIds.has(transaction.bankTransactionId))
    // A migrated account may contain the same bank history under provider IDs
    // from an older consent. Establish a clean delta boundary on its first sync.
    .filter((transaction) => !legacyCutoff || transaction.date > legacyCutoff)
    .filter((transaction) => transaction.date <= todayInParis())

  const periodIds = new Map<string, string>()
  const rows: Row[] = []
  for (const transaction of newTransactions) {
    const month = transaction.date.slice(0, 7)
    let periodId = periodIds.get(month)
    if (!periodId) {
      periodId = await ensurePeriod(workspaceId, month)
      periodIds.set(month, periodId)
    }
    rows.push({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      account_id: account.id,
      period_id: periodId,
      transaction_date: transaction.date,
      source_timestamp: `${transaction.date}T12:00:00Z`,
      source_created_at: sync.fetchedAt,
      amount_minor: amountToMinor(transaction.amount, transaction.currency),
      destination_amount_minor: 0,
      currency: transaction.currency,
      transaction_type: transaction.type,
      payee_name: transaction.payee,
      memo: transaction.note || null,
      provider_transaction_id: transaction.providerTransactionId,
      bank_transaction_id: transaction.bankTransactionId ?? null,
      posted: true,
      reconciled: true,
      source: 'gocardless',
    })
  }
  for (let start = 0; start < rows.length; start += 500) {
    const { error } = await neon.from('transactions').insert(rows.slice(start, start + 500))
    if (error) throw error
  }

  let balanceUpdated = false
  const accountUpdate: Row = { last_refresh_at: sync.fetchedAt }
  if (sync.balance?.currency === account.currency) {
    const ledgerRows = await accountTransactionRows(workspaceId, account.id)
    const ledgerBalance = ledgerRows.reduce((sum, row) => {
      const amount = number(row.amount_minor)
      if (row.transaction_type === 'income' && row.account_id === account.id) return sum + amount
      if (row.transaction_type === 'expense' && row.account_id === account.id) return sum - amount
      if (row.transaction_type === 'transfer' && row.account_id === account.id) return sum - amount
      if (row.transaction_type === 'transfer' && row.destination_account_id === account.id) {
        const destinationAmount = number(row.destination_amount_minor)
        return sum + (destinationAmount || amount)
      }
      return sum
    }, 0)
    accountUpdate.opening_balance_minor = amountToMinor(sync.balance.amount, sync.balance.currency) * (Number(sync.balance.amount) < 0 ? -1 : 1) - ledgerBalance
    balanceUpdated = true
  }
  const accountResult = await neon.from('accounts').update(accountUpdate).eq('workspace_id', workspaceId).eq('id', account.id)
  if (accountResult.error) throw accountResult.error

  if (connection) {
    const updateResult = await neon.from('bank_connections').update({
      last_synced_at: sync.fetchedAt,
      metadata: { ...connectionMetadata, legacy_cutoff: legacyCutoff || null, rate_limits: sync.rateLimits, last_imported: rows.length },
    }).eq('id', connection.id)
    if (updateResult.error) throw updateResult.error
  }

  return {
    imported: rows.length,
    duplicates: [...unique.values()].filter((transaction) => existingIds.has(transaction.providerTransactionId) || Boolean(transaction.bankTransactionId && existingBankIds.has(transaction.bankTransactionId))).length,
    balanceUpdated,
    rateLimits: sync.rateLimits,
    syncedAt: sync.fetchedAt,
    warnings: [sync.errors?.transactions, sync.errors?.balances].filter((warning): warning is string => Boolean(warning)),
  }
}
