import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , transactionsPath, budgetsPath, period = '2026-08'] = process.argv

if (!transactionsPath || !budgetsPath || !/^\d{4}-\d{2}$/.test(period)) {
  console.error('Usage: npm run import:ios -- <transactions.txt> <budgets.txt> <YYYY-MM>')
  process.exit(1)
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = resolve(projectRoot, 'public/imported-data.local.json')
const reportPath = resolve(projectRoot, 'data/private/import-report.local.json')

const unquote = (value) => {
  const trimmed = value.trim()
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replaceAll('""', '"')
    : trimmed
}

const parseRows = (contents, expectedFields) => {
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
  const header = lines.shift().split('\t').map(unquote)
  if (header.length !== expectedFields) throw new Error(`Expected ${expectedFields} columns, found ${header.length}`)
  return lines.map((raw, index) => {
    const values = raw.split('\t').map(unquote)
    return { lineNumber: index + 2, raw, values }
  })
}

const slug = (value) => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '') || 'unnamed'

const decimalToMinor = (value) => {
  const normalized = value.trim().replace(',', '.')
  const negative = normalized.startsWith('-')
  const unsigned = negative ? normalized.slice(1) : normalized
  if (!/^\d+(\.\d{0,2})?$/.test(unsigned)) throw new Error(`Invalid money value: ${value}`)
  const [whole, fraction = ''] = unsigned.split('.')
  const result = (Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) * (negative ? -1 : 1)
  if (!Number.isSafeInteger(result)) throw new Error(`Unsafe money value: ${value}`)
  return result
}

const importTimeZone = 'Europe/Paris'
const localDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: importTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const iosTimestampToLocalDate = (value) => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/)
  if (!match) return null
  const [, year, month, day, hour, minute, second, sign, offsetHour, offsetMinute] = match
  const instant = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`)
  if (Number.isNaN(instant.getTime())) return null
  const parts = Object.fromEntries(localDateFormatter.formatToParts(instant).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

const [transactionContents, budgetContents] = await Promise.all([
  readFile(resolve(transactionsPath), 'utf8'),
  readFile(resolve(budgetsPath), 'utf8'),
])

const transactionRows = parseRows(transactionContents, 15)
const budgetRows = parseRows(budgetContents, 4)

const datedTransactionRows = transactionRows.map((row) => ({
  ...row,
  localDate: iosTimestampToLocalDate(row.values[1]),
}))
const selectedRows = datedTransactionRows.filter(({ localDate }) => localDate?.startsWith(period))
const invalidRows = []
const skippedRows = []
const importedRows = []
const accountNames = new Set()
const categoryNames = new Set()

for (const row of selectedRows) {
  const [account, dateFull, payee, category, memo, amount, currency, income, transfer, toAccount] = row.values
  const recurring = row.values[13]
  if (recurring === 'true') {
    skippedRows.push({ lineNumber: row.lineNumber, reason: 'recurring transaction excluded' })
    continue
  }
  const issues = []
  if (!account) issues.push('missing account')
  if (!row.localDate) issues.push('invalid date')
  if (!/^\d+$/.test(amount)) issues.push('invalid amount')
  if (currency !== 'EUR') issues.push(`unsupported currency ${currency || '(blank)'}`)
  if (transfer === 'true' && !toAccount) issues.push('missing transfer destination')
  if (issues.length) {
    invalidRows.push({ lineNumber: row.lineNumber, issues })
    continue
  }

  const type = transfer === 'true' ? 'transfer' : income === 'true' ? 'income' : 'expense'
  const categoryName = type === 'transfer'
    ? undefined
    : category || (type === 'income' ? 'Uncategorised income' : 'Uncategorised')
  accountNames.add(account)
  if (toAccount) accountNames.add(toAccount)
  if (categoryName) categoryNames.add(categoryName)
  importedRows.push({ ...row, account, date: row.localDate, payee, categoryName, memo, amountMinor: Number(amount), type, toAccount })
}

const [year, month] = period.split('-').map(Number)
const periodBudgets = new Map()
for (const { values } of budgetRows) {
  const [budgetYear, budgetMonth, categoryName, amount] = values
  if (Number(budgetYear) !== year || Number(budgetMonth) !== month || !categoryName) continue
  periodBudgets.set(categoryName, decimalToMinor(amount))
  categoryNames.add(categoryName)
}

// The export does not include Category.type. Keep the pilot deliberately narrow:
// only the two unambiguous income categories are classified as income. Refunds
// remain attached to their normal expense category.
const incomeCategoryNames = new Set(['Salary', 'Other income', 'Uncategorised income'])

const colors = ['#cc7048', '#738c5a', '#d49b4d', '#9b6a71', '#5d7d91', '#7f7062', '#607d68', '#8b6d8f']
const iconFor = (name, kind) => {
  const lower = name.toLowerCase()
  if (kind === 'income') return 'briefcase'
  if (lower.includes('home') || lower.includes('apartment')) return 'house'
  if (lower.includes('grocer')) return 'basket'
  if (lower.includes('car') || lower.includes('transport')) return 'car'
  if (lower.includes('going out')) return 'utensils'
  if (lower.includes('subscription') || lower.includes('utilit')) return 'receipt'
  return 'sparkles'
}

const categoryList = [...categoryNames].sort((a, b) => a.localeCompare(b))
const categories = categoryList.map((name, index) => {
  const kind = incomeCategoryNames.has(name) ? 'income' : 'expense'
  return {
    id: `ios-category-${slug(name)}-${kind}`,
    name,
    budgetMinor: periodBudgets.get(name) ?? 0,
    color: colors[index % colors.length],
    icon: iconFor(name, kind),
    kind,
  }
})
const categoryIds = new Map(categories.map((category) => [category.name, category.id]))

const accountColors = ['#234e46', '#d68853', '#777a6d', '#5d7d91', '#8b6d8f']
const sortedAccountNames = [...accountNames].sort((a, b) => a.localeCompare(b))
const accounts = sortedAccountNames.map((name, index) => ({
  id: `ios-account-${slug(name)}`,
  name,
  type: name.toLowerCase().includes('broker') ? 'Savings' : 'Checking',
  balanceMinor: 0,
  color: accountColors[index % accountColors.length],
  currency: 'EUR',
}))
const accountIds = new Map(accounts.map((account) => [account.name, account.id]))

const transactions = importedRows.map((row) => {
  const sourceRowHash = createHash('sha256').update(`${row.lineNumber}:${row.raw}`).digest('hex')
  return {
    id: `ios-${sourceRowHash.slice(0, 24)}`,
    date: row.date,
    merchant: row.type === 'transfer' ? 'Transfer' : row.payee || row.memo || 'Unknown payee',
    ...(row.memo ? { note: row.memo } : {}),
    amountMinor: row.amountMinor,
    type: row.type,
    accountId: accountIds.get(row.account),
    ...(row.categoryName ? { categoryId: categoryIds.get(row.categoryName) } : {}),
    ...(row.toAccount ? { toAccountId: accountIds.get(row.toAccount) } : {}),
    currency: 'EUR',
    payeeRaw: row.payee,
    source: 'ios_import',
    sourceRowHash,
  }
})

for (const transaction of transactions) {
  const source = accounts.find((account) => account.id === transaction.accountId)
  if (transaction.type === 'transfer') {
    const destination = accounts.find((account) => account.id === transaction.toAccountId)
    source.balanceMinor -= transaction.amountMinor
    destination.balanceMinor += transaction.amountMinor
  } else {
    source.balanceMinor += transaction.type === 'income' ? transaction.amountMinor : -transaction.amountMinor
  }
}

const categoryKinds = new Map(categories.map((category) => [category.id, category.kind]))
const sum = (type) => transactions.filter((transaction) => transaction.type === type).reduce((total, transaction) => total + transaction.amountMinor, 0)
const refundsMinor = transactions
  .filter((transaction) => transaction.type === 'income' && categoryKinds.get(transaction.categoryId) === 'expense')
  .reduce((total, transaction) => total + transaction.amountMinor, 0)
const trueIncomeMinor = sum('income') - refundsMinor
const data = { accounts, categories, transactions }
const report = {
  period,
  timeZone: importTimeZone,
  sourceRows: transactionRows.length,
  selectedRows: selectedRows.length,
  importedRows: transactions.length,
  skippedRows,
  invalidRows,
  accounts: accounts.map(({ name, balanceMinor }) => ({ name, provisionalBalanceMinor: balanceMinor })),
  categories: categories.map(({ name, kind, budgetMinor }) => ({ name, kind, budgetMinor })),
  rawTotalsMinor: { incomeFlagged: sum('income'), expenses: sum('expense'), transfers: sum('transfer') },
  reportingTotalsMinor: { income: trueIncomeMinor, refunds: refundsMinor, expensesNetOfRefunds: sum('expense') - refundsMinor },
}

await Promise.all([
  mkdir(dirname(outputPath), { recursive: true }),
  mkdir(dirname(reportPath), { recursive: true }),
])
await Promise.all([
  writeFile(outputPath, `${JSON.stringify(data, null, 2)}\n`),
  writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`),
])

console.log(JSON.stringify(report, null, 2))
