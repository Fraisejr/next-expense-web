import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const archiveArg = args.find((arg) => !arg.startsWith('--'))
const apply = args.includes('--apply')
const timeZone = 'Europe/Paris'

if (!archiveArg) {
  console.error('Usage: node scripts/import-ios-archive.mjs <archive.json> [--apply]')
  process.exit(1)
}

const archivePath = resolve(archiveArg)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = resolve(projectRoot, 'data/private/archive-import-report.local.json')
const raw = await readFile(archivePath, 'utf8')
const archiveSha256 = createHash('sha256').update(raw).digest('hex')
const archive = JSON.parse(raw)

const requiredCollections = [
  'accounts',
  'categoryGroups',
  'categories',
  'payees',
  'payeeMappings',
  'periods',
  'budgets',
  'fxRates',
  'transactions',
]

if (archive.schemaVersion !== 1 || archive.source !== 'Next Expense iOS') {
  throw new Error('Unsupported archive source or schema version')
}
for (const key of requiredCollections) {
  if (!Array.isArray(archive[key])) throw new Error(`Archive is missing ${key}`)
}

const localDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const localDate = (value) => {
  if (!value) return null
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) throw new Error('Archive contains an invalid timestamp')
  const parts = Object.fromEntries(
    localDateFormatter.formatToParts(instant).map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

const isUuid = (value) => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

const ids = (rows, label) => {
  const values = rows.map(({ id }) => id)
  if (values.some((id) => !isUuid(id))) throw new Error(`${label} contains an invalid ID`)
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate IDs`)
  return new Set(values)
}

const accountIds = ids(archive.accounts, 'Accounts')
const groupIds = ids(archive.categoryGroups, 'Category groups')
const categoryIds = ids(archive.categories, 'Categories')
const payeeIds = ids(archive.payees, 'Payees')
const periodIds = ids(archive.periods, 'Periods')
ids(archive.budgets, 'Budgets')
ids(archive.fxRates, 'FX rates')
ids(archive.transactions, 'Transactions')

const requireReference = (rows, field, validIds, label, nullable = false) => {
  for (const row of rows) {
    const value = row[field]
    if (nullable && (value === null || value === undefined)) continue
    if (!validIds.has(value)) throw new Error(`${label} contains an orphaned ${field}`)
  }
}

requireReference(archive.categories, 'categoryGroupId', groupIds, 'Categories', true)
requireReference(archive.payees, 'defaultAccountId', accountIds, 'Payees', true)
requireReference(archive.payees, 'defaultCategoryId', categoryIds, 'Payees', true)
requireReference(archive.fxRates, 'periodId', periodIds, 'FX rates')
requireReference(archive.transactions, 'accountId', accountIds, 'Transactions', true)
requireReference(archive.transactions, 'destinationAccountId', accountIds, 'Transactions', true)
requireReference(archive.transactions, 'periodId', periodIds, 'Transactions')
requireReference(archive.transactions, 'categoryId', categoryIds, 'Transactions', true)
requireReference(archive.transactions, 'payeeId', payeeIds, 'Transactions', true)
requireReference(archive.transactions, 'debtorId', payeeIds, 'Transactions', true)

const stableUuid = (value) => {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4]
  const joined = hex.join('')
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`
}

const workspaceId = stableUuid('next-expense:Next Expense iOS')
const companyAccountPattern = /inspiraeon|företag|revolut pro/i
const normalizedPayeeName = (value) => value.normalize('NFKC').trim().toLocaleLowerCase('en')
const normalizeCategoryColor = (value) => {
  const color = typeof value === 'string' ? value.trim() : ''
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toUpperCase()
  if (/^[0-9a-f]{6}$/i.test(color)) return `#${color.toUpperCase()}`
  return '#5D7D91'
}
const supportedIconKeys = new Set([
  'banknote', 'basket', 'briefcase', 'car', 'credit-card', 'dumbbell', 'heart',
  'house', 'medical', 'plane', 'receipt', 'shield', 'shopping-bag', 'sparkles',
  'target', 'tv', 'utensils', 'wine', 'zap',
])
const sfSymbolIconKeys = {
  'briefcase.fill': 'briefcase',
  'banknote.fill': 'banknote',
  'cart.fill': 'basket',
  'wineglass.fill': 'wine',
  'play.tv.fill': 'tv',
  'house.fill': 'house',
  'exclamationmark.shield.fill': 'shield',
  'bag.fill': 'shopping-bag',
  'bolt.fill': 'zap',
  target: 'target',
  'car.fill': 'car',
  'cross.case.fill': 'medical',
  'creditcard.fill': 'credit-card',
  airplane: 'plane',
  'fork.knife': 'utensils',
}
const normalizeCategoryIcon = (value, categoryName) => {
  const icon = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (supportedIconKeys.has(icon)) return icon
  if (sfSymbolIconKeys[icon]) return sfSymbolIconKeys[icon]
  const name = categoryName.toLowerCase()
  if (/salary|business/.test(name)) return 'briefcase'
  if (/income|saving|dividend|investment|emergency fund/.test(name)) return 'banknote'
  if (/grocer/.test(name)) return 'basket'
  if (/going out|per diem/.test(name)) return 'utensils'
  if (/leisure/.test(name)) return 'tv'
  if (/transport|car/.test(name)) return 'car'
  if (/apartment|rent/.test(name)) return 'house'
  if (/insurance/.test(name)) return 'shield'
  if (/shopping/.test(name)) return 'shopping-bag'
  if (/utilit/.test(name)) return 'zap'
  if (/cleaning/.test(name)) return 'target'
  if (/gym/.test(name)) return 'dumbbell'
  if (/medical/.test(name)) return 'medical'
  if (/subscription/.test(name)) return 'credit-card'
  if (/travel/.test(name)) return 'plane'
  if (/tax|fee|expense/.test(name)) return 'receipt'
  if (/charity/.test(name)) return 'heart'
  return 'sparkles'
}

const accounts = archive.accounts.map((account) => ({
  id: account.id,
  workspace_id: workspaceId,
  name: account.name,
  account_type: account.type,
  scope: companyAccountPattern.test(account.name) ? 'Company' : 'Personal',
  currency: account.currency,
  sort_order: account.order,
  closed: account.closed,
  investment: account.investment,
  pension: account.pension,
  auto_sync: account.autoSync,
  provider_account_id: account.externalId ?? null,
  institution_id: account.institutionId ?? null,
  country: account.country ?? null,
  last_refresh_at: account.lastRefreshDate ?? null,
  display_type: account.investment || account.pension || account.type === 'External' ? 'Savings' : 'Checking',
  color: account.investment || account.pension ? '#d68853' : account.type === 'External' ? '#777a6d' : '#234e46',
}))

const categoryGroups = archive.categoryGroups.map((group) => ({
  id: group.id,
  workspace_id: workspaceId,
  name: group.name,
  sort_order: group.order,
  show_categories: group.showCategories,
}))

const categories = archive.categories.map((category) => ({
  id: category.id,
  workspace_id: workspaceId,
  category_group_id: category.categoryGroupId ?? null,
  name: category.name,
  category_type: category.type,
  color: normalizeCategoryColor(category.color),
  icon: normalizeCategoryIcon(category.icon, category.name),
  sort_order: category.order,
  hidden: category.hidden,
  default_budget_minor: category.defaultBudgetMinor,
  report_group: category.type === 'Income'
    ? 'income'
    : category.type === 'Investment'
      ? 'capital_gain'
      : /tax|irpf|cuota ss/i.test(category.name)
        ? 'tax'
        : 'expense',
}))

const payees = archive.payees.map((payee) => ({
  id: payee.id,
  workspace_id: workspaceId,
  name: payee.name.trim() || 'Unnamed payee',
  sort_order: payee.order,
  show_on_watch: payee.showOnWatch,
  transfer_payee: payee.transferPayee,
  default_account_id: payee.defaultAccountId ?? null,
  default_category_id: payee.defaultCategoryId ?? null,
}))

const orphanedPayeeMappings = archive.payeeMappings.filter((mapping) => !payeeIds.has(mapping.payeeId))
const uniquePayeeMappings = new Map()
for (const mapping of archive.payeeMappings.filter((item) => payeeIds.has(item.payeeId))) {
  uniquePayeeMappings.set(`${mapping.name}\u0000${mapping.payeeId}`, mapping)
}
const duplicatePayeeMappingRows = archive.payeeMappings.length
  - orphanedPayeeMappings.length
  - uniquePayeeMappings.size
const payeeMappings = [...uniquePayeeMappings.values()].map((mapping) => ({
  id: stableUuid(`payee-mapping:${mapping.name}:${mapping.payeeId}`),
  workspace_id: workspaceId,
  normalized_name: normalizedPayeeName(mapping.name),
  source_name: mapping.name,
  payee_id: mapping.payeeId,
}))

const periods = archive.periods.map((period) => ({
  id: period.id,
  workspace_id: workspaceId,
  year: period.year,
  month: period.month,
  month_label: period.monthString ?? null,
  period_start_date: localDate(period.startDate),
  source_start_at: period.startDate,
  show_transactions: period.showTransactions,
}))

const orphanedBudgets = archive.budgets.filter(
  (budget) => !periodIds.has(budget.periodId) || !categoryIds.has(budget.categoryId),
)
const budgets = archive.budgets.filter(
  (budget) => periodIds.has(budget.periodId) && categoryIds.has(budget.categoryId),
).map((budget) => ({
  id: budget.id,
  workspace_id: workspaceId,
  period_id: budget.periodId,
  category_id: budget.categoryId,
  amount_minor: budget.amountMinor,
  scope: 'Personal',
}))

const fxRates = archive.fxRates.map((rate) => ({
  id: rate.id,
  workspace_id: workspaceId,
  period_id: rate.periodId,
  base_currency: rate.currency1,
  quote_currency: rate.currency2,
  rate_hundredths: rate.rate,
  rate_date: localDate(rate.startDate),
  source_start_at: rate.startDate,
}))

let dateShiftedFromUtc = 0
const todayInImportTimeZone = localDate(new Date().toISOString())
const futureTransactions = archive.transactions.filter((transaction) => localDate(transaction.date) > todayInImportTimeZone)
const transactions = archive.transactions.filter((transaction) => localDate(transaction.date) <= todayInImportTimeZone).map((transaction) => {
  const transactionDate = localDate(transaction.date)
  if (transactionDate !== transaction.date.slice(0, 10)) dateShiftedFromUtc += 1
  return {
    id: transaction.id,
    workspace_id: workspaceId,
    account_id: transaction.accountId ?? null,
    destination_account_id: transaction.destinationAccountId ?? null,
    period_id: transaction.periodId,
    category_id: transaction.categoryId ?? null,
    payee_id: transaction.payeeId ?? null,
    debtor_id: transaction.debtorId ?? null,
    transaction_date: transactionDate,
    source_timestamp: transaction.date,
    source_created_at: transaction.createdAt ?? null,
    amount_minor: transaction.amountMinor,
    destination_amount_minor: transaction.destinationAmountMinor,
    currency: transaction.currency,
    transaction_type: transaction.transfer ? 'transfer' : transaction.income ? 'income' : 'expense',
    payee_name: transaction.payeeName ?? null,
    memo: transaction.memo ?? null,
    provider_transaction_id: transaction.externalId ?? null,
    posted: transaction.posted,
    reconciled: transaction.reconciled,
    recurring: transaction.recurring,
    recurrence: transaction.recurrence || null,
    last_day_of_month: transaction.lastDayOfMonth,
    expense_claim: transaction.expense,
    expense_invoiced: transaction.expenseInvoiced,
    expense_posted: transaction.expensePosted,
    expense_settled: transaction.expenseSettled,
    source: 'ios_import',
  }
})

const ignoredSplits = archive.transactions.reduce((sum, transaction) => sum + transaction.splits.length, 0)
const ignoredNonzeroSplits = archive.transactions.reduce(
  (sum, transaction) => sum + transaction.splits.filter((split) => split.amountMinor !== 0).length,
  0,
)
const sourceCounts = Object.fromEntries(requiredCollections.map((key) => [key, archive[key].length]))
const importedCounts = {
  accounts: accounts.length,
  categoryGroups: categoryGroups.length,
  categories: categories.length,
  payees: payees.length,
  payeeMappings: payeeMappings.length,
  periods: periods.length,
  budgets: budgets.length,
  fxRates: fxRates.length,
  transactions: transactions.length,
}
const ignoredCounts = {
  splitTransactions: archive.transactions.filter((transaction) => transaction.split).length,
  splitComponents: ignoredSplits,
  nonzeroSplitComponents: ignoredNonzeroSplits,
  orphanedPayeeMappings: orphanedPayeeMappings.length,
  duplicatePayeeMappingRows,
  orphanedBudgets: orphanedBudgets.length,
  blankPayeesRenamed: archive.payees.filter((payee) => !payee.name.trim()).length,
  futureTransactions: futureTransactions.length,
}
const report = {
  mode: apply ? 'applied' : 'dry-run',
  source: archive.source,
  schemaVersion: archive.schemaVersion,
  exportedAt: archive.exportedAt,
  archiveSha256,
  workspaceId,
  timeZone,
  sourceCounts,
  importedCounts,
  ignoredCounts,
  dateShiftedFromUtc,
  currencies: [...new Set(transactions.map(({ currency }) => currency))].sort(),
}

const literal = (value) => {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Archive contains an unsafe integer')
    return String(value)
  }
  return `'${String(value).replaceAll("'", "''")}'`
}

const insertBatches = (table, rows, columns, conflictColumns, updateColumns, batchSize = 400) => {
  const statements = []
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize)
    const values = batch
      .map((row) => `(${columns.map((column) => literal(row[column])).join(',')})`)
      .join(',\n')
    const updates = updateColumns.map((column) => `${column} = excluded.${column}`).join(', ')
    statements.push(`insert into public.${table} (${columns.join(',')}) values\n${values}\non conflict (${conflictColumns.join(',')}) do update set ${updates};`)
  }
  return statements.join('\n')
}

const runId = randomUUID()
const webManagedAccountFields = new Set([
  'auto_sync',
  'provider_account_id',
  'institution_id',
  'country',
  'last_refresh_at',
])
const sql = [
  'begin;',
  `insert into public.workspaces (id, name, default_currency, import_timezone)
   values (${literal(workspaceId)}, 'Next Expense', 'EUR', ${literal(timeZone)})
   on conflict (id) do update set name = excluded.name, import_timezone = excluded.import_timezone;`,
  `insert into public.import_runs
    (id, workspace_id, archive_sha256, source, source_schema_version, source_exported_at,
     import_timezone, status, source_counts, imported_counts, ignored_counts)
   values (${literal(runId)}, ${literal(workspaceId)}, ${literal(archiveSha256)},
     ${literal(archive.source)}, ${literal(archive.schemaVersion)}, ${literal(archive.exportedAt)},
     ${literal(timeZone)}, 'running', ${literal(JSON.stringify(sourceCounts))}::jsonb,
     '{}'::jsonb, ${literal(JSON.stringify(ignoredCounts))}::jsonb)
   on conflict (workspace_id, archive_sha256) do update
     set status = 'running', error_message = null, completed_at = null;`,
  insertBatches('accounts', accounts, Object.keys(accounts[0]), ['id'], Object.keys(accounts[0]).filter((key) => !['id', 'workspace_id'].includes(key) && !webManagedAccountFields.has(key))),
  insertBatches('category_groups', categoryGroups, Object.keys(categoryGroups[0]), ['id'], Object.keys(categoryGroups[0]).filter((key) => !['id', 'workspace_id'].includes(key))),
  insertBatches('categories', categories, Object.keys(categories[0]), ['id'], Object.keys(categories[0]).filter((key) => !['id', 'workspace_id'].includes(key))),
  insertBatches('payees', payees, Object.keys(payees[0]), ['id'], Object.keys(payees[0]).filter((key) => !['id', 'workspace_id'].includes(key))),
  insertBatches('payee_mappings', payeeMappings, Object.keys(payeeMappings[0]), ['id'], ['normalized_name', 'source_name', 'payee_id']),
  insertBatches('periods', periods, Object.keys(periods[0]), ['id'], Object.keys(periods[0]).filter((key) => !['id', 'workspace_id'].includes(key))),
  insertBatches('budgets', budgets, Object.keys(budgets[0]), ['id'], Object.keys(budgets[0]).filter((key) => !['id', 'workspace_id'].includes(key))),
  insertBatches('fx_rates', fxRates, Object.keys(fxRates[0]), ['id'], Object.keys(fxRates[0]).filter((key) => !['id', 'workspace_id'].includes(key))),
  insertBatches('transactions', transactions, Object.keys(transactions[0]), ['id'], Object.keys(transactions[0]).filter((key) => !['id', 'workspace_id'].includes(key))),
  `update public.import_runs
   set status = 'completed', imported_counts = ${literal(JSON.stringify(importedCounts))}::jsonb,
       ignored_counts = ${literal(JSON.stringify(ignoredCounts))}::jsonb, completed_at = now()
   where workspace_id = ${literal(workspaceId)} and archive_sha256 = ${literal(archiveSha256)};`,
  'commit;',
].join('\n\n')

if (apply) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required with --apply')
  const result = spawnSync('psql', [process.env.DATABASE_URL, '-q', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const databaseError = result.stderr
      .split(/\r?\n/)
      .find((line) => line.startsWith('ERROR:') || line.startsWith('psql:'))
    console.error(`Database import failed; Postgres rolled back the complete import.${databaseError ? ` ${databaseError}` : ''}`)
    process.exit(result.status ?? 1)
  }
}

await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
