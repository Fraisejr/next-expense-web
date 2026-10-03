import { convertMinor } from './currency.ts'
import { isExpenseReportGroup, isIncomeReportGroup, isTaxReportGroup } from './finance-groups.ts'
import type { AppData, SpendingGoalScope, Transaction } from './types'

export type AnnualSpendingMetric = { year: number; income: number; expenses: number; taxes: number }
export type AnnualSpendingSummary = Record<SpendingGoalScope, AnnualSpendingMetric[]>

export function calculateAnnualSpending(transactions: Transaction[], data: Pick<AppData, 'categories' | 'fxRates'>, currency: string, throughDate: string): AnnualSpendingSummary {
  const categories = new Map(data.categories.map((category) => [category.id, category.reportGroup]))
  const buckets = { Personal: new Map<number, AnnualSpendingMetric>(), Company: new Map<number, AnnualSpendingMetric>(), Combined: new Map<number, AnnualSpendingMetric>() }
  for (const transaction of transactions) {
    if (transaction.date > throughDate || (transaction.type !== 'income' && transaction.type !== 'expense')) continue
    const group = categories.get(transaction.categoryId ?? '')
    const scope = group?.startsWith('personal_') ? 'Personal' : group?.startsWith('company_') ? 'Company' : null
    if (!scope || !group) continue
    const year = Number(transaction.date.slice(0, 4))
    const amount = convertMinor(transaction.amountMinor, transaction.currency, currency, transaction.date, data.fxRates) ?? 0
    const direction = transaction.type === 'income' ? 1 : -1
    for (const target of [scope, 'Combined'] as const) {
      const metric = buckets[target].get(year) ?? { year, income: 0, expenses: 0, taxes: 0 }
      if (isIncomeReportGroup(group)) metric.income += direction * amount
      if (isExpenseReportGroup(group)) metric.expenses -= direction * amount
      if (isTaxReportGroup(group)) metric.taxes -= direction * amount
      buckets[target].set(year, metric)
    }
  }
  return Object.fromEntries(Object.entries(buckets).map(([scope, years]) => [scope, [...years.values()].sort((a, b) => a.year - b.year)])) as AnnualSpendingSummary
}

export function annualSummaryKey(workspaceId: string, currency: string, throughDate: string, data: Pick<AppData, 'categories' | 'fxRates'>) {
  return JSON.stringify([1, workspaceId, currency, throughDate,
    data.categories.map(({ id, reportGroup }) => [id, reportGroup]).sort((a, b) => a[0].localeCompare(b[0])),
    data.fxRates.map(({ id, date, baseCurrency, quoteCurrency, rateHundredths }) => [id, date, baseCurrency, quoteCurrency, rateHundredths]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ])
}
