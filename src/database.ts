import { neon } from './neon'
import { normalizeCategoryColor, normalizeCategoryIcon } from './categoryVisuals'
import type { Account, AccountScope, AppData, BankImportCandidate, BankRateLimit, BankSyncDiagnostic, Budget, Category, Payee, ReportGroup, Transaction } from './types'

type Row = Record<string, unknown>

export class WorkspaceNotLinkedError extends Error {
  constructor() {
    super('Your account has not been linked to the imported workspace yet.')
  }
}

function number(value: unknown) {
  return Number(value ?? 0)
}

function normalizedPayeeName(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en')
}

function daysApart(left: unknown, right: string) {
  const leftTime = Date.parse(`${String(left)}T12:00:00Z`)
  const rightTime = Date.parse(`${right}T12:00:00Z`)
  return Number.isFinite(leftTime) && Number.isFinite(rightTime)
    ? Math.abs(leftTime - rightTime) / (24 * 60 * 60 * 1000)
    : Number.POSITIVE_INFINITY
}

function shiftedDate(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const syncHistoryWindowMs = 24 * 60 * 60 * 1000

function recentSyncRuns(metadata: Row | undefined, lastSyncedAt?: unknown, now = Date.now()) {
  const cutoff = now - syncHistoryWindowMs
  const storedRuns = Array.isArray(metadata?.sync_history) ? metadata.sync_history : []
  const runs = storedRuns
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => {
      const timestamp = Date.parse(value)
      return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now
    })

  if (!runs.length && typeof lastSyncedAt === 'string') {
    const timestamp = Date.parse(lastSyncedAt)
    if (Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now) runs.push(lastSyncedAt)
  }
  return [...new Set(runs)].sort()
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
  return loadWorkspaceWithRetries(3)
}

async function loadWorkspaceWithRetries(retriesRemaining: number): Promise<LoadedWorkspace> {
  const { data: memberships, error: membershipError } = await neon
    .from('workspace_members')
    .select('workspace_id')
    .limit(1)
  if (membershipError) throw membershipError
  const workspaceId = (memberships?.[0] as Row | undefined)?.workspace_id as string | undefined
  if (!workspaceId) throw new WorkspaceNotLinkedError()

  const [workspaceResult, accountRows, categoryRows, periodRows, budgetRows, payeeRows, transactionRows, connectionRows, candidateRows] = await Promise.all([
    neon.from('workspaces').select('name,default_currency,estimated_company_tax_rate_bps').eq('id', workspaceId).limit(1),
    allRows('accounts', '*', 'sort_order'),
    allRows('categories', '*', 'sort_order'),
    allRows('periods', '*', 'period_start_date'),
    allRows('budgets'),
    allRows('payees', '*', 'sort_order'),
    allRows('transactions'),
    allRows('bank_connections'),
    allRows('bank_import_candidates'),
  ])
  if (workspaceResult.error) throw workspaceResult.error

  const payeeNames = new Map(payeeRows.map((row) => [row.id as string, row.name as string]))
  const periods = new Map(periodRows.map((row) => [row.id as string, `${row.year}-${String(row.month).padStart(2, '0')}`]))
  const transactions: Transaction[] = transactionRows.map((row) => ({
    id: row.id as string,
    date: row.transaction_date as string,
    payee: (payeeNames.get(row.payee_id as string) || row.payee_name || row.memo || 'Unknown payee') as string,
    payeeId: (row.payee_id as string | null) ?? undefined,
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
    posted: Boolean(row.posted),
  }))
  const balanceChanges = accountBalanceChanges(transactions)
  const connections = new Map(connectionRows
    .filter((row) => row.account_id && row.status === 'active')
    .map((row) => [row.account_id as string, row]))
  const accounts: Account[] = accountRows.map((row) => {
    const connection = connections.get(row.id as string)
    const metadata = connection?.metadata && typeof connection.metadata === 'object' ? connection.metadata as Row : undefined
    const bankBalance = metadata?.bank_balance && typeof metadata.bank_balance === 'object' ? metadata.bank_balance as Row : undefined
    const lastSyncDiagnostic = metadata?.last_sync_diagnostic && typeof metadata.last_sync_diagnostic === 'object' ? metadata.last_sync_diagnostic as BankSyncDiagnostic : undefined
    const calculatedBalanceMinor = number(row.opening_balance_minor) + (balanceChanges.get(row.id as string) ?? 0)
    return {
      id: row.id as string,
      name: row.name as string,
      type: row.display_type as Account['type'],
      balanceMinor: calculatedBalanceMinor,
      color: row.color as string,
      currency: row.currency as string,
      scope: row.scope as AccountScope,
      closed: Boolean(row.closed),
      autoSync: Boolean(row.auto_sync),
      bankImportMode: row.bank_import_mode === 'automatic' ? 'automatic' : 'review',
      // A migrated provider account ID is not sufficient proof that the bank
      // connection is still usable. Only expose it when this app has an active
      // connection record created by the reconnect flow.
      providerAccountId: connection ? ((row.provider_account_id as string | null) ?? undefined) : undefined,
      institutionId: (row.institution_id as string | null) ?? undefined,
      country: (row.country as string | null) ?? undefined,
      lastSyncedAt: (connection?.last_synced_at as string | null) ?? undefined,
      syncRunsLast24Hours: recentSyncRuns(metadata, connection?.last_synced_at).length,
      bankBalanceMinor: typeof bankBalance?.amount_minor === 'number' ? bankBalance.amount_minor : undefined,
      bankBalanceCurrency: typeof bankBalance?.currency === 'string' ? bankBalance.currency : undefined,
      bankBalanceUpdatedAt: typeof bankBalance?.fetched_at === 'string' ? bankBalance.fetched_at : undefined,
      lastSyncDiagnostic,
      connectionStatus: (connection?.status as Account['connectionStatus'] | undefined),
      rateLimits: (metadata?.rate_limits as Account['rateLimits'] | undefined),
    }
  })
  const categories: Category[] = categoryRows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    color: normalizeCategoryColor(row.color),
    icon: normalizeCategoryIcon(row.icon, row.name as string),
    reportGroup: row.report_group as ReportGroup,
    hidden: Boolean(row.hidden),
  }))
  const payees: Payee[] = payeeRows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    defaultCategoryId: (row.default_category_id as string | null) ?? undefined,
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
  const bankImportCandidates: BankImportCandidate[] = candidateRows
    .filter((row) => row.status === 'pending')
    .map((row) => ({
      id: String(row.id),
      accountId: String(row.account_id),
      date: String(row.transaction_date),
      amountMinor: number(row.amount_minor),
      currency: String(row.currency),
      type: row.transaction_type as BankImportCandidate['type'],
      payee: String(row.payee_name),
      payeeId: (row.payee_id as string | null) ?? undefined,
      categoryId: (row.category_id as string | null) ?? undefined,
      note: (row.memo as string | null) ?? undefined,
      posted: Boolean(row.posted),
    }))
  const workspace = (workspaceResult.data?.[0] as unknown as Row | undefined)
  if (!workspace) {
    // Neon Auth can restore its browser session just before the Data API starts
    // applying that session to RLS-protected reads. A membership row without its
    // referenced workspace cannot be a stable database state, so retry the whole
    // snapshot instead of asking the user to do it manually.
    if (retriesRemaining > 0) {
      const attempt = 4 - retriesRemaining
      await new Promise((resolve) => setTimeout(resolve, 200 * (2 ** (attempt - 1))))
      return loadWorkspaceWithRetries(retriesRemaining - 1)
    }
    throw new Error('The linked workspace could not be read.')
  }

  return {
    workspaceId,
    workspaceName: workspace.name as string,
    defaultCurrency: workspace.default_currency as string,
    data: {
      accounts,
      categories,
      payees,
      budgets,
      transactions,
      bankImportCandidates,
      settings: { estimatedCompanyTaxRateBps: number(workspace.estimated_company_tax_rate_bps) },
    },
  }
}

export async function createAccount(workspaceId: string, account: Account, sortOrder: number) {
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
    sort_order: sortOrder,
    closed: account.closed,
  })
  if (error) throw error
}

export async function saveAccountOrder(workspaceId: string, accountIds: string[]) {
  const results = await Promise.all(accountIds.map((accountId, sortOrder) => neon
    .from('accounts')
    .update({ sort_order: sortOrder })
    .eq('workspace_id', workspaceId)
    .eq('id', accountId)))
  const failed = results.find((result) => result.error)
  if (failed?.error) throw failed.error
}

export async function updateBankImportMode(workspaceId: string, accountId: string, mode: 'review' | 'automatic') {
  const { error } = await neon.from('accounts')
    .update({ bank_import_mode: mode })
    .eq('workspace_id', workspaceId)
    .eq('id', accountId)
  if (error) throw error
}

export async function approveBankImportCandidate(workspaceId: string, candidateId: string, categoryId: string, rememberCategory: boolean) {
  const { data, error } = await neon.rpc('approve_bank_import_candidate', {
    p_workspace_id: workspaceId,
    p_candidate_id: candidateId,
    p_category_id: categoryId,
    p_remember_category: rememberCategory,
  })
  if (error) throw error
  return String(data)
}

export async function rejectBankImportCandidate(workspaceId: string, candidateId: string) {
  const { error } = await neon.from('bank_import_candidates')
    .update({ status: 'rejected', decided_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('id', candidateId)
    .eq('status', 'pending')
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
    hidden: category.hidden,
  })
  if (error) throw error
}

export async function updateCategoryHidden(workspaceId: string, categoryId: string, hidden: boolean) {
  const { error } = await neon.from('categories')
    .update({ hidden })
    .eq('workspace_id', workspaceId)
    .eq('id', categoryId)
  if (error) throw error
}

async function resolvePayees(workspaceId: string, sourceNames: string[], createMissing: boolean): Promise<Array<Payee | undefined>> {
  const names = [...new Set(sourceNames.map((name) => name.normalize('NFKC').trim()).filter(Boolean))]
  if (!names.length) return []

  const [payeeResult, mappingResult] = await Promise.all([
    neon.from('payees').select('id,name,default_category_id').eq('workspace_id', workspaceId).order('id', { ascending: true }),
    neon.from('payee_mappings').select('normalized_name,payee_id').eq('workspace_id', workspaceId).order('id', { ascending: true }),
  ])
  if (payeeResult.error) throw payeeResult.error
  if (mappingResult.error) throw mappingResult.error

  const payees: Payee[] = (payeeResult.data ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    defaultCategoryId: row.default_category_id ? String(row.default_category_id) : undefined,
  }))
  const payeeById = new Map(payees.map((payee) => [payee.id, payee]))
  const payeeByName = new Map<string, Payee>()
  for (const row of mappingResult.data ?? []) {
    const payee = payeeById.get(String(row.payee_id))
    const normalized = String(row.normalized_name)
    if (payee && !payeeByName.has(normalized)) payeeByName.set(normalized, payee)
  }
  for (const payee of payees) {
    const normalized = normalizedPayeeName(payee.name)
    if (!payeeByName.has(normalized)) payeeByName.set(normalized, payee)
  }

  if (createMissing) {
    for (const name of names) {
      const normalized = normalizedPayeeName(name)
      if (payeeByName.has(normalized)) continue
      const payee: Payee = { id: crypto.randomUUID(), name }
      const { error } = await neon.from('payees').insert({
        id: payee.id,
        workspace_id: workspaceId,
        name: payee.name,
      })
      if (error) throw error
      payeeByName.set(normalized, payee)
      payeeById.set(payee.id, payee)
      payees.push(payee)
    }
  }

  return names.map((name) => payeeByName.get(normalizedPayeeName(name)))
}

export async function ensurePayees(workspaceId: string, sourceNames: string[]): Promise<Payee[]> {
  return (await resolvePayees(workspaceId, sourceNames, true)) as Payee[]
}

async function findPayees(workspaceId: string, sourceNames: string[]) {
  return resolvePayees(workspaceId, sourceNames, false)
}

export async function assignPayeeMapping(workspaceId: string, sourceName: string, payeeId: string): Promise<string[]> {
  const normalizedName = normalizedPayeeName(sourceName)
  const { data, error } = await neon.rpc('assign_payee_mapping', {
    p_workspace_id: workspaceId,
    p_source_name: sourceName.normalize('NFKC').trim(),
    p_payee_id: payeeId,
  })
  if (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
    if (code !== 'PGRST202') throw error
    return assignPayeeMappingWithoutRpc(workspaceId, sourceName, normalizedName, payeeId)
  }
  return Array.isArray(data) ? data.map(String) : []
}

async function assignPayeeMappingWithoutRpc(workspaceId: string, sourceName: string, normalizedName: string, payeeId: string): Promise<string[]> {
  const existingMapping = await neon.from('payee_mappings')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('normalized_name', normalizedName)
    .eq('payee_id', payeeId)
    .limit(1)
  if (existingMapping.error) throw existingMapping.error
  if (!existingMapping.data?.length) {
    const { error } = await neon.from('payee_mappings').insert({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      normalized_name: normalizedName,
      source_name: sourceName.normalize('NFKC').trim(),
      payee_id: payeeId,
    })
    if (error) throw error
  }

  const matchedIds: string[] = []
  const pageSize = 1000
  for (let start = 0; ; start += pageSize) {
    const { data: transactionRows, error } = await neon.from('transactions')
      .select('id,payee_name,memo')
      .eq('workspace_id', workspaceId)
      .is('payee_id', null)
      .neq('transaction_type', 'transfer')
      .order('id', { ascending: true })
      .range(start, start + pageSize - 1)
    if (error) throw error
    const rows = (transactionRows ?? []) as unknown as Row[]
    matchedIds.push(...rows.flatMap((row) => {
      const description = String(row.payee_name ?? '').trim() || String(row.memo ?? '').trim() || 'Unknown payee'
      return normalizedPayeeName(description) === normalizedName ? [String(row.id)] : []
    }))
    if (rows.length < pageSize) break
  }
  if (!matchedIds.length) throw new Error('No unmatched transactions matched this description.')

  for (let start = 0; start < matchedIds.length; start += 50) {
    const { error } = await neon.from('transactions')
      .update({ payee_id: payeeId })
      .eq('workspace_id', workspaceId)
      .in('id', matchedIds.slice(start, start + 50))
    if (error) throw error
  }
  return matchedIds
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
  if (transaction.type === 'transfer' ? transaction.categoryId : !transaction.categoryId) {
    throw new Error(transaction.type === 'transfer' ? 'Transfers cannot have a category.' : 'Choose a category before saving this transaction.')
  }
  const periodId = await ensurePeriod(workspaceId, transaction.date.slice(0, 7))
  const { error } = await neon.from('transactions').insert({
    id: transaction.id,
    workspace_id: workspaceId,
    account_id: transaction.accountId,
    destination_account_id: transaction.toAccountId ?? null,
    period_id: periodId,
    category_id: transaction.categoryId ?? null,
    payee_id: transaction.payeeId ?? null,
    transaction_date: transaction.date,
    source_timestamp: `${transaction.date}T12:00:00Z`,
    source_created_at: new Date().toISOString(),
    amount_minor: transaction.amountMinor,
    destination_amount_minor: transaction.destinationAmountMinor ?? (transaction.type === 'transfer' ? transaction.amountMinor : 0),
    currency: transaction.currency,
    transaction_type: transaction.type,
    payee_name: transaction.payee,
    memo: transaction.note ?? null,
    posted: true,
    reconciled: true,
    source: 'manual',
  })
  if (error) throw error
}

export async function updateTransactionDetails(workspaceId: string, transactionId: string, payeeId: string, categoryId: string) {
  const { data, error } = await neon.from('transactions')
    .update({ payee_id: payeeId, category_id: categoryId })
    .eq('workspace_id', workspaceId)
    .eq('id', transactionId)
    .neq('transaction_type', 'transfer')
    .select('id')
  if (error) throw error
  if (!data?.length) throw new Error('The transaction could not be updated. Transfers do not have categories.')
}

export async function updatePayeeDefaultCategory(workspaceId: string, payeeId: string, categoryId: string) {
  const { data, error } = await neon.from('payees')
    .update({ default_category_id: categoryId })
    .eq('workspace_id', workspaceId)
    .eq('id', payeeId)
    .select('id')
  if (error) throw error
  if (!data?.length) throw new Error('The payee default category could not be updated.')
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

export async function saveBankSync(workspaceId: string, account: Account, sync: BankSyncPayload): Promise<BankSyncSummary> {
  if (!account.providerAccountId) throw new Error('This account is not connected to a bank.')

  const connectionResult = await neon.from('bank_connections')
    .select('id,metadata,last_synced_at')
    .eq('workspace_id', workspaceId)
    .eq('account_id', account.id)
    .eq('provider', 'gocardless_bank_account_data')
    .eq('status', 'active')
    .limit(1)
  if (connectionResult.error) throw connectionResult.error
  const connection = connectionResult.data?.[0] as Row | undefined
  if (!connection) throw new Error('Reconnect this account before syncing again.')
  const connectionMetadata = connection?.metadata && typeof connection.metadata === 'object' ? connection.metadata as Row : {}
  const syncHistory = recentSyncRuns(connectionMetadata, connection?.last_synced_at, Date.parse(sync.fetchedAt))
  syncHistory.push(sync.fetchedAt)

  const [aliasResult, referenceResult, transferResult, candidateResult] = await Promise.all([
    neon.from('bank_account_aliases')
      .select('account_id,normalized_alias')
      .eq('workspace_id', workspaceId)
      .eq('provider', 'gocardless_bank_account_data'),
    neon.from('bank_transaction_refs')
      .select('id,transaction_id,provider_transaction_id,bank_transaction_id')
      .eq('workspace_id', workspaceId)
      .eq('provider', 'gocardless_bank_account_data')
      .eq('account_id', account.id),
    neon.from('transactions')
      .select('id,account_id,destination_account_id,transaction_date,amount_minor,destination_amount_minor,currency,transaction_type')
      .eq('workspace_id', workspaceId)
      .eq('transaction_type', 'transfer')
      .or(`account_id.eq.${account.id},destination_account_id.eq.${account.id}`),
    neon.from('bank_import_candidates')
      .select('id,status,transaction_id,provider_transaction_id,bank_transaction_id,posted')
      .eq('workspace_id', workspaceId)
      .eq('provider', 'gocardless_bank_account_data')
      .eq('account_id', account.id),
  ])
  if (aliasResult.error) throw aliasResult.error
  if (referenceResult.error) throw referenceResult.error
  if (transferResult.error) throw transferResult.error
  if (candidateResult.error) throw candidateResult.error

  const aliasAccountIds = new Map(((aliasResult.data ?? []) as unknown as Row[])
    .map((row) => [String(row.normalized_alias), String(row.account_id)]))
  const referenceRows = (referenceResult.data ?? []) as unknown as Row[]
  const referencedProviderIds = new Set(referenceRows.flatMap((row) => row.provider_transaction_id ? [String(row.provider_transaction_id)] : []))
  const referencedBankIds = new Set(referenceRows.flatMap((row) => row.bank_transaction_id ? [String(row.bank_transaction_id)] : []))
  const transferRows = (transferResult.data ?? []) as unknown as Row[]
  const candidateRows = (candidateResult.data ?? []) as unknown as Row[]
  const candidateByProviderId = new Map(candidateRows.flatMap((row) => row.provider_transaction_id ? [[String(row.provider_transaction_id), row] as const] : []))
  const candidateByBankId = new Map(candidateRows.flatMap((row) => row.bank_transaction_id ? [[String(row.bank_transaction_id), row] as const] : []))
  const candidateFor = (transaction: BankSyncPayload['transactions'][number]) => candidateByProviderId.get(transaction.providerTransactionId)
    ?? (transaction.bankTransactionId ? candidateByBankId.get(transaction.bankTransactionId) : undefined)

  const matchingTransfer = (transaction: BankSyncPayload['transactions'][number]) => {
    const counterpartyAccountId = aliasAccountIds.get(normalizedPayeeName(transaction.payee))
    if (!counterpartyAccountId || transaction.currency !== account.currency) return undefined
    const amountMinor = amountToMinor(transaction.amount, transaction.currency)
    const candidates = transferRows.filter((row) => {
      if (daysApart(row.transaction_date, transaction.date) > 3) return false
      if (transaction.type === 'income') {
        return row.destination_account_id === account.id
          && row.account_id === counterpartyAccountId
          && number(row.destination_amount_minor || row.amount_minor) === amountMinor
      }
      return row.account_id === account.id
        && row.destination_account_id === counterpartyAccountId
        && number(row.amount_minor) === amountMinor
    })
    if (!candidates.length) return undefined
    const closestDays = Math.min(...candidates.map((row) => daysApart(row.transaction_date, transaction.date)))
    const closest = candidates.filter((row) => daysApart(row.transaction_date, transaction.date) === closestDays)
    return closest.length === 1 ? closest[0] : undefined
  }

  const unique = new Map<string, BankSyncPayload['transactions'][number]>()
  for (const transaction of sync.transactions) {
    const current = unique.get(transaction.providerTransactionId)
    if (!current || transaction.status === 'booked') unique.set(transaction.providerTransactionId, transaction)
  }
  const existingIds = new Set<string>(referencedProviderIds)
  const existingBankIds = new Set<string>(referencedBankIds)
  const existingByProviderId = new Map<string, Row>()
  const existingByBankId = new Map<string, Row>()
  const existingBankFingerprints = new Map<string, Row[]>()
  const existingPendingFingerprints = new Map<string, Row[]>()
  let hasGoCardlessHistory = false
  let latestLedgerDate = ''
  const pageSize = 1000
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await neon.from('transactions')
      .select('id,provider_transaction_id,bank_transaction_id,transaction_date,source,amount_minor,currency,transaction_type,payee_name,memo,posted')
      .eq('workspace_id', workspaceId)
      .eq('account_id', account.id)
      .order('id', { ascending: true })
      .range(start, start + pageSize - 1)
    if (error) throw error
    const page = (data ?? []) as unknown as Row[]
    for (const row of page) {
      if (row.provider_transaction_id) {
        existingIds.add(String(row.provider_transaction_id))
        existingByProviderId.set(String(row.provider_transaction_id), row)
      }
      if (row.bank_transaction_id) {
        existingBankIds.add(String(row.bank_transaction_id))
        existingByBankId.set(String(row.bank_transaction_id), row)
      }
      if (row.source === 'gocardless') {
        hasGoCardlessHistory = true
        const key = `${row.transaction_date}|${row.currency}|${row.transaction_type}|${row.amount_minor}|${String(row.payee_name ?? '').trim().toLocaleLowerCase('en')}`
        existingBankFingerprints.set(key, [...(existingBankFingerprints.get(key) ?? []), row])
        if (row.posted === false) {
          const pendingKey = `${row.currency}|${row.transaction_type}|${row.amount_minor}|${String(row.payee_name ?? '').trim().toLocaleLowerCase('en')}`
          existingPendingFingerprints.set(pendingKey, [...(existingPendingFingerprints.get(pendingKey) ?? []), row])
        }
      }
      if (String(row.transaction_date ?? '') > latestLedgerDate) latestLedgerDate = String(row.transaction_date)
    }
    if (page.length < pageSize) break
  }

  for (const transaction of unique.values()) {
    const candidate = candidateFor(transaction)
    if (!candidate || candidate.status === 'approved') continue
    if (candidate.status === 'pending') {
      const candidateUpdate = await neon.from('bank_import_candidates').update({
        transaction_date: transaction.date,
        amount_minor: amountToMinor(transaction.amount, transaction.currency),
        currency: transaction.currency,
        transaction_type: transaction.type,
        payee_name: transaction.payee,
        memo: transaction.note || null,
        posted: transaction.status === 'booked',
        fetched_at: sync.fetchedAt,
        raw_payload: transaction.rawPayload ?? null,
        provider_transaction_id: transaction.providerTransactionId,
        bank_transaction_id: transaction.bankTransactionId ?? null,
      }).eq('workspace_id', workspaceId).eq('id', candidate.id)
      if (candidateUpdate.error) throw candidateUpdate.error
    }
    existingIds.add(transaction.providerTransactionId)
    if (transaction.bankTransactionId) existingBankIds.add(transaction.bankTransactionId)
  }

  let pendingPromoted = 0
  let transfersMatched = 0
  const promotePending = async (row: Row, transaction: BankSyncPayload['transactions'][number]) => {
    const periodId = await ensurePeriod(workspaceId, transaction.date.slice(0, 7))
    const promotionResult = await neon.from('transactions').update({
      period_id: periodId,
      transaction_date: transaction.date,
      source_timestamp: `${transaction.date}T12:00:00Z`,
      source_created_at: sync.fetchedAt,
      amount_minor: amountToMinor(transaction.amount, transaction.currency),
      currency: transaction.currency,
      transaction_type: transaction.type,
      payee_name: transaction.payee,
      memo: transaction.note || null,
      provider_transaction_id: transaction.providerTransactionId,
      bank_transaction_id: transaction.bankTransactionId ?? null,
      posted: true,
      reconciled: true,
    }).eq('workspace_id', workspaceId).eq('id', row.id)
    if (promotionResult.error) throw promotionResult.error
    row.posted = true
    existingIds.add(transaction.providerTransactionId)
    existingByProviderId.set(transaction.providerTransactionId, row)
    if (transaction.bankTransactionId) {
      existingBankIds.add(transaction.bankTransactionId)
      existingByBankId.set(transaction.bankTransactionId, row)
    }
    pendingPromoted += 1
  }

  for (const transaction of unique.values()) {
    if (candidateFor(transaction)?.status === 'rejected') continue
    if (referencedProviderIds.has(transaction.providerTransactionId)) continue
    if (transaction.bankTransactionId && referencedBankIds.has(transaction.bankTransactionId)) continue
    const transfer = matchingTransfer(transaction)
    if (!transfer) continue

    const existingReference = referenceRows.find((row) => row.transaction_id === transfer.id
      && (row.provider_transaction_id === transaction.providerTransactionId
        || (transaction.bankTransactionId && row.bank_transaction_id === transaction.bankTransactionId)))
    if (!existingReference) {
      const referenceInsert = await neon.from('bank_transaction_refs').insert({
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        transaction_id: transfer.id,
        account_id: account.id,
        provider: 'gocardless_bank_account_data',
        provider_transaction_id: transaction.providerTransactionId,
        bank_transaction_id: transaction.bankTransactionId ?? null,
      })
      if (referenceInsert.error) throw referenceInsert.error
    }

    const duplicate = existingByProviderId.get(transaction.providerTransactionId)
      ?? (transaction.bankTransactionId ? existingByBankId.get(transaction.bankTransactionId) : undefined)
    if (duplicate && duplicate.id !== transfer.id) {
      const deleteResult = await neon.from('transactions')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('id', duplicate.id)
      if (deleteResult.error) throw deleteResult.error
    }

    referencedProviderIds.add(transaction.providerTransactionId)
    existingIds.add(transaction.providerTransactionId)
    if (transaction.bankTransactionId) {
      referencedBankIds.add(transaction.bankTransactionId)
      existingBankIds.add(transaction.bankTransactionId)
    }
    const candidate = candidateFor(transaction)
    if (candidate?.status === 'pending') {
      const candidateUpdate = await neon.from('bank_import_candidates').update({
        status: 'matched',
        transaction_id: transfer.id,
        decided_at: new Date().toISOString(),
      }).eq('workspace_id', workspaceId).eq('id', candidate.id)
      if (candidateUpdate.error) throw candidateUpdate.error
    }
    transfersMatched += 1
  }

  for (const transaction of unique.values()) {
    if (transaction.status !== 'booked') continue
    const existing = existingByProviderId.get(transaction.providerTransactionId)
      ?? (transaction.bankTransactionId ? existingByBankId.get(transaction.bankTransactionId) : undefined)
    if (existing?.posted === false) {
      await promotePending(existing, transaction)
    } else if (existing && String(existing.payee_name ?? '').trim().toLocaleLowerCase('en') === 'bank transaction'
      && (transaction.payee !== 'Bank transaction' || transaction.note)) {
      const repairResult = await neon.from('transactions').update({
        payee_name: transaction.payee,
        memo: transaction.note || existing.memo || null,
      }).eq('workspace_id', workspaceId).eq('id', existing.id)
      if (repairResult.error) throw repairResult.error
      existing.payee_name = transaction.payee
      existing.memo = transaction.note || existing.memo || null
    }
  }

  for (const transaction of unique.values()) {
    if (existingIds.has(transaction.providerTransactionId)) continue
    if (transaction.bankTransactionId && existingBankIds.has(transaction.bankTransactionId)) continue
    const amountMinor = amountToMinor(transaction.amount, transaction.currency)
    const normalizedPayee = transaction.payee.trim().toLocaleLowerCase('en')
    const fingerprint = `${transaction.date}|${transaction.currency}|${transaction.type}|${amountMinor}|${normalizedPayee}`
    let matches = existingBankFingerprints.get(fingerprint) ?? []
    if (matches.length !== 1 && transaction.status === 'booked') {
      const pendingFingerprint = `${transaction.currency}|${transaction.type}|${amountMinor}|${normalizedPayee}`
      const pendingMatches = existingPendingFingerprints.get(pendingFingerprint) ?? []
      if (pendingMatches.length === 1) matches = pendingMatches
    }
    if (matches.length !== 1) continue
    if (transaction.status === 'booked' && matches[0].posted === false) {
      await promotePending(matches[0], transaction)
    } else {
      const repairResult = await neon.from('transactions')
        .update({
          provider_transaction_id: transaction.providerTransactionId,
          bank_transaction_id: transaction.bankTransactionId ?? null,
        })
        .eq('workspace_id', workspaceId)
        .eq('id', matches[0].id)
      if (repairResult.error) throw repairResult.error
    }
    existingIds.add(transaction.providerTransactionId)
    if (transaction.bankTransactionId) existingBankIds.add(transaction.bankTransactionId)
  }

  const legacyCutoff = String(connectionMetadata.legacy_cutoff ?? (!hasGoCardlessHistory ? latestLedgerDate : ''))
  const receivedTransactions = [...unique.values()]
  const unseenTransactions = receivedTransactions
    .filter((transaction) => !existingIds.has(transaction.providerTransactionId))
    .filter((transaction) => !transaction.bankTransactionId || !existingBankIds.has(transaction.bankTransactionId))
  const cutoffIgnored = unseenTransactions.filter((transaction) => Boolean(legacyCutoff) && transaction.date <= legacyCutoff).length
  const afterCutoff = unseenTransactions.filter((transaction) => !legacyCutoff || transaction.date > legacyCutoff)
  const today = todayInParis()
  const futureIgnored = afterCutoff.filter((transaction) => transaction.date > today).length
  const newTransactions = afterCutoff
    // A migrated account may contain the same bank history under provider IDs
    // from an older consent. Establish a clean delta boundary on its first sync.
    .filter((transaction) => transaction.date <= today)
  const duplicates = Math.max(0, receivedTransactions.length - unseenTransactions.length - pendingPromoted - transfersMatched)

  const sourcePayeeNames = [...new Set(newTransactions.map((transaction) => transaction.payee.normalize('NFKC').trim()).filter(Boolean))]
  const [resolvedPayees, categoryResult] = await Promise.all([
    findPayees(workspaceId, sourcePayeeNames),
    neon.from('categories').select('id,hidden').eq('workspace_id', workspaceId),
  ])
  if (categoryResult.error) throw categoryResult.error
  const hiddenCategoryIds = new Set((categoryResult.data ?? []).filter((category) => category.hidden).map((category) => String(category.id)))
  const payeeIdByName = new Map<string, string>()
  const defaultCategoryIdByName = new Map<string, string>()
  sourcePayeeNames.forEach((name, index) => {
    const payee = resolvedPayees[index]
    if (!payee) return
    const normalizedName = normalizedPayeeName(name)
    payeeIdByName.set(normalizedName, payee.id)
    if (payee.defaultCategoryId) defaultCategoryIdByName.set(normalizedName, payee.defaultCategoryId)
  })
  const defaultCategoryFor = (transaction: BankSyncPayload['transactions'][number]) => defaultCategoryIdByName.get(normalizedPayeeName(transaction.payee))
  const canApplyDefaultCategory = (transaction: BankSyncPayload['transactions'][number]) => {
    const categoryId = defaultCategoryFor(transaction)
    return Boolean(categoryId && !hiddenCategoryIds.has(categoryId))
  }
  const transactionsToInsert = account.bankImportMode === 'automatic'
    ? newTransactions.filter(canApplyDefaultCategory)
    : []
  const transactionsToStage = account.bankImportMode === 'automatic'
    ? newTransactions.filter((transaction) => !canApplyDefaultCategory(transaction))
    : newTransactions

  const periodIds = new Map<string, string>()
  const rows: Row[] = []
  for (const transaction of transactionsToInsert) {
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
      category_id: defaultCategoryFor(transaction),
      payee_id: payeeIdByName.get(normalizedPayeeName(transaction.payee)) ?? null,
      payee_name: transaction.payee,
      memo: transaction.note || null,
      provider_transaction_id: transaction.providerTransactionId,
      bank_transaction_id: transaction.bankTransactionId ?? null,
      posted: transaction.status === 'booked',
      reconciled: transaction.status === 'booked',
      source: 'gocardless',
    })
  }
  for (let start = 0; start < rows.length; start += 500) {
    const { error } = await neon.from('transactions').insert(rows.slice(start, start + 500))
    if (error) throw error
  }

  const candidateRowsToInsert = transactionsToStage.map((transaction) => ({
    id: crypto.randomUUID(),
    workspace_id: workspaceId,
    account_id: account.id,
    provider: 'gocardless_bank_account_data',
    provider_transaction_id: transaction.providerTransactionId,
    bank_transaction_id: transaction.bankTransactionId ?? null,
    transaction_date: transaction.date,
    amount_minor: amountToMinor(transaction.amount, transaction.currency),
    currency: transaction.currency,
    transaction_type: transaction.type,
    category_id: defaultCategoryFor(transaction) ?? null,
    payee_id: payeeIdByName.get(normalizedPayeeName(transaction.payee)) ?? null,
    payee_name: transaction.payee,
    memo: transaction.note || null,
    posted: transaction.status === 'booked',
    status: 'pending',
    fetched_at: sync.fetchedAt,
    raw_payload: transaction.rawPayload ?? null,
  }))
  for (let start = 0; start < candidateRowsToInsert.length; start += 500) {
    const { error } = await neon.from('bank_import_candidates').insert(candidateRowsToInsert.slice(start, start + 500))
    if (error) throw error
  }

  const receivedDates = sync.transactions.map((transaction) => transaction.date).sort()
  if (receivedDates.length && aliasAccountIds.size) {
    const candidateResult = await neon.from('transactions')
      .select('id,account_id,transaction_date,amount_minor,currency,transaction_type,payee_name,posted')
      .eq('workspace_id', workspaceId)
      .eq('source', 'gocardless')
      .eq('posted', true)
      .in('transaction_type', ['income', 'expense'])
      .gte('transaction_date', shiftedDate(receivedDates[0], -3))
      .lte('transaction_date', shiftedDate(receivedDates[receivedDates.length - 1], 3))
    if (candidateResult.error) throw candidateResult.error
    const candidates = (candidateResult.data ?? []) as unknown as Row[]
    const incomes = candidates.filter((row) => row.transaction_type === 'income')
    const expenses = candidates.filter((row) => row.transaction_type === 'expense')
    const usedIds = new Set<string>()

    for (const income of incomes) {
      const sourceAccountId = aliasAccountIds.get(normalizedPayeeName(String(income.payee_name ?? '')))
      if (!sourceAccountId || sourceAccountId === income.account_id || usedIds.has(String(income.id))) continue
      const possibleExpenses = expenses.filter((expense) => !usedIds.has(String(expense.id))
        && expense.account_id === sourceAccountId
        && expense.currency === income.currency
        && number(expense.amount_minor) === number(income.amount_minor)
        && daysApart(expense.transaction_date, String(income.transaction_date)) <= 3)
      if (!possibleExpenses.length) continue
      const closestDays = Math.min(...possibleExpenses.map((expense) => daysApart(expense.transaction_date, String(income.transaction_date))))
      const closest = possibleExpenses.filter((expense) => daysApart(expense.transaction_date, String(income.transaction_date)) === closestDays)
      if (closest.length !== 1) continue

      const expense = closest[0]
      const reconciliationResult = await neon.rpc('reconcile_bank_transfer', {
        p_workspace_id: workspaceId,
        p_expense_id: expense.id,
        p_income_id: income.id,
        p_provider: 'gocardless_bank_account_data',
      })
      if (reconciliationResult.error) throw reconciliationResult.error
      usedIds.add(String(expense.id))
      usedIds.add(String(income.id))
      transfersMatched += 1
    }
  }

  let balanceUpdated = false
  const accountUpdate: Row = { last_refresh_at: sync.fetchedAt }
  const bankBalance = sync.balance ? {
    amount_minor: amountToMinor(sync.balance.amount, sync.balance.currency) * (Number(sync.balance.amount) < 0 ? -1 : 1),
    currency: sync.balance.currency,
    type: sync.balance.type,
    fetched_at: sync.fetchedAt,
  } : undefined
  balanceUpdated = Boolean(bankBalance)
  const accountResult = await neon.from('accounts').update(accountUpdate).eq('workspace_id', workspaceId).eq('id', account.id)
  if (accountResult.error) throw accountResult.error

  const bookedImported = transactionsToInsert.filter((transaction) => transaction.status === 'booked').length
  const pendingImported = transactionsToInsert.filter((transaction) => transaction.status === 'pending').length
  const diagnostic: BankSyncDiagnostic = {
    fetchedAt: sync.fetchedAt,
    bookedReturned: sync.providerDiagnostics?.bookedReturned ?? sync.transactions.filter((transaction) => transaction.status === 'booked').length,
    pendingReturned: sync.providerDiagnostics?.pendingReturned ?? sync.transactions.filter((transaction) => transaction.status === 'pending').length,
    malformedIgnored: sync.providerDiagnostics?.malformedIgnored ?? 0,
    imported: rows.length,
    staged: candidateRowsToInsert.length,
    bookedImported,
    pendingImported,
    duplicates,
    transfersMatched,
    pendingPromoted,
    cutoffIgnored,
    futureIgnored,
    balanceType: sync.balance?.type || undefined,
    transactionError: sync.errors?.transactions || undefined,
    balanceError: sync.errors?.balances || undefined,
  }
  const previousDiagnostics = Array.isArray(connectionMetadata.sync_diagnostics)
    ? connectionMetadata.sync_diagnostics.filter((item) => item && typeof item === 'object').slice(-24)
    : []

  if (connection) {
    const updateResult = await neon.from('bank_connections').update({
      last_synced_at: sync.fetchedAt,
      metadata: {
        ...connectionMetadata,
        legacy_cutoff: legacyCutoff || null,
        rate_limits: sync.rateLimits,
        sync_history: [...new Set(syncHistory)].sort(),
        bank_balance: bankBalance ?? connectionMetadata.bank_balance,
        last_imported: rows.length,
        last_sync_diagnostic: diagnostic,
        sync_diagnostics: [...previousDiagnostics, diagnostic],
        last_provider_response: sync.rawProviderResponse ? {
          fetched_at: sync.fetchedAt,
          ...sync.rawProviderResponse,
        } : connectionMetadata.last_provider_response,
      },
    }).eq('id', connection.id)
    if (updateResult.error) throw updateResult.error
  }

  return {
    imported: rows.length,
    duplicates,
    balanceUpdated,
    rateLimits: sync.rateLimits,
    syncedAt: sync.fetchedAt,
    syncRunsLast24Hours: [...new Set(syncHistory)].length,
    diagnostic,
    warnings: [sync.errors?.transactions, sync.errors?.balances].filter((warning): warning is string => Boolean(warning)),
  }
}
