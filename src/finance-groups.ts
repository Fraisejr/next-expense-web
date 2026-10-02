import type { Account, BalanceAdjustmentReason, BalanceSheetGroup, ReportGroup } from './types'

export const balanceSheetGroups: BalanceSheetGroup[] = ['Personal', 'Company', 'Real estate', 'Pension']
export const incomeReportGroups: ReportGroup[] = ['personal_income', 'company_revenue']
export const expenseReportGroups: ReportGroup[] = ['personal_expense', 'company_expense']
export const taxReportGroups: ReportGroup[] = ['personal_tax', 'company_tax']

export function isIncomeReportGroup(group?: ReportGroup) {
  return Boolean(group && incomeReportGroups.includes(group))
}

export function isExpenseReportGroup(group?: ReportGroup) {
  return Boolean(group && expenseReportGroups.includes(group))
}

export function isTaxReportGroup(group?: ReportGroup) {
  return Boolean(group && taxReportGroups.includes(group))
}

export function accountBalanceSheetGroup(account: Account): BalanceSheetGroup {
  return account.balanceSheetGroup ?? (account.scope === 'Company' ? 'Company' : 'Personal')
}

export const balanceAdjustmentReasonLabels: Record<BalanceAdjustmentReason, string> = {
  market_valuation: 'Market valuation',
  asset_valuation: 'Asset valuation',
  liability_adjustment: 'Liability adjustment',
  reconciliation: 'Reconciliation correction',
  other: 'Other adjustment',
}
