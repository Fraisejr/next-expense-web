import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, CircleHelp, LoaderCircle, Pencil, X } from 'lucide-react'
import { formatCompactMoney, formatMoney, formatShortDate, monthName, toMonthKey } from '../../app-utils'
import { accountBalanceSheetGroup, balanceAdjustmentReasonLabels, balanceSheetGroups, isIncomeReportGroup } from '../../finance-groups'
import { convertMinor } from '../../currency'
import { todayInParis } from '../../../shared/bank-data.ts'
import type { Account, AppData, Budget, ReportGroup, Transaction } from '../../types'

export type ReportView = 'profit-loss' | 'net-worth'
type ReportPeriod = 'month' | 'year'
type ValuationGroup = 'investments' | 'real-estate' | 'other-assets'
type PnlScope = 'combined' | 'personal' | 'company'
type PnlMetric = 'income' | 'expenses' | 'taxes' | 'netIncome'
type PnlHistoryPoint = { key: string; label: string; income: number; expenses: number; taxes: number; netIncome: number }
const pnlMetricDefinitions: { id: PnlMetric; label: string }[] = [{ id: 'income', label: 'Income' }, { id: 'expenses', label: 'Expenses' }, { id: 'taxes', label: 'Taxes' }, { id: 'netIncome', label: 'Net income' }]

export function ReportsPage({ data, viewedMonth, defaultCurrency, view, historyLoading, onChangeView, onUpdateTaxRate, onEditTransaction }: { data: AppData; viewedMonth: Date; defaultCurrency: string; view: ReportView; historyLoading: boolean; onChangeView: (view: ReportView) => void; onUpdateTaxRate: (rateBps: number) => void; onEditTransaction: (transaction: Transaction) => void }) {
  const [period, setPeriod] = useState<ReportPeriod>('month')
  const [openValuationGroup, setOpenValuationGroup] = useState<ValuationGroup | null>(null)
  const [pnlScope, setPnlScope] = useState<PnlScope>('combined')
  const [pnlMetrics, setPnlMetrics] = useState<PnlMetric[]>(pnlMetricDefinitions.map((metric) => metric.id))
  const toolbar = <div className="report-toolbar">
    <span className="report-scope-label">Personal + company</span>
    <div className="segmented report-segmented" aria-label="Report view"><button className={view === 'profit-loss' ? 'active transfer' : ''} aria-pressed={view === 'profit-loss'} onClick={() => onChangeView('profit-loss')}>Profit &amp; loss</button><button className={view === 'net-worth' ? 'active transfer' : ''} aria-pressed={view === 'net-worth'} onClick={() => onChangeView('net-worth')}>Net worth</button></div>
    <div className="segmented period-segmented" aria-label="Report period"><button className={period === 'month' ? 'active transfer' : ''} aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>Monthly</button><button className={period === 'year' ? 'active transfer' : ''} aria-pressed={period === 'year'} onClick={() => setPeriod('year')}>Yearly</button></div>
  </div>

  if (view === 'net-worth') {
    return <NetWorthReport data={data} viewedMonth={viewedMonth} defaultCurrency={defaultCurrency} period={period} historyLoading={historyLoading} toolbar={toolbar} />
  }

  const monthKey = toMonthKey(viewedMonth)
  const yearKey = String(viewedMonth.getFullYear())
  const categoryById = new Map(data.categories.map((category) => [category.id, category]))
  const inPeriod = (date: string) => period === 'month' ? date.startsWith(monthKey) : date.startsWith(yearKey)
  const reportTransactions = data.transactions.filter((transaction) => inPeriod(transaction.date) && (transaction.type === 'expense' || transaction.type === 'income'))
  const reportMonths = period === 'month'
    ? [monthKey]
    : Array.from({ length: 12 }, (_, index) => `${yearKey}-${String(index + 1).padStart(2, '0')}`)
  const explicitBudgetByMonthAndCategory = new Map(data.budgets.map((budget) => [`${budget.month}:${budget.categoryId}`, budget]))
  const reportBudgets: Budget[] = reportMonths.flatMap((month) => data.categories.map((category) =>
    explicitBudgetByMonthAndCategory.get(`${month}:${category.id}`) ?? {
      id: `default-${month}-${category.id}`,
      month,
      categoryId: category.id,
      scope: 'Personal' as const,
      amountMinor: category.defaultBudgetMinor,
    }))

  const totalTransactionsForGroup = (transactions: Transaction[], group: ReportGroup) => transactions
    .filter((transaction) => categoryById.get(transaction.categoryId ?? '')?.reportGroup === group)
    .reduce((sum, transaction) => {
      const direction = transaction.type === 'income' ? 1 : -1
      const amount = convertMinor(transaction.amountMinor, transaction.currency, defaultCurrency, transaction.date, data.fxRates) ?? 0
      return sum + (isIncomeReportGroup(group) ? direction : -direction) * amount
    }, 0)
  const totalBudgetsForGroup = (budgets: AppData['budgets'], group: ReportGroup) => budgets
    .filter((budget) => categoryById.get(budget.categoryId)?.reportGroup === group)
    .reduce((sum, budget) => sum + budget.amountMinor, 0)
  const estimatedTax = (profitMinor: number) => Math.max(0, Math.round(profitMinor * data.settings.estimatedCompanyTaxRateBps / 10_000))

  const personalActualIncome = totalTransactionsForGroup(reportTransactions, 'personal_income')
  const personalActualExpenses = totalTransactionsForGroup(reportTransactions, 'personal_expense')
  const companyActualRevenue = totalTransactionsForGroup(reportTransactions, 'company_revenue')
  const companyActualExpenses = totalTransactionsForGroup(reportTransactions, 'company_expense')
  const personalRecordedTaxes = totalTransactionsForGroup(reportTransactions, 'personal_tax')
  const companyRecordedTaxes = totalTransactionsForGroup(reportTransactions, 'company_tax')
  const actualBreakdown = (group: ReportGroup) => {
    const totals = new Map<string, ReportBreakdownItem>()
    for (const transaction of reportTransactions) {
      const category = categoryById.get(transaction.categoryId ?? '')
      if (!category || category.reportGroup !== group) continue
      const direction = transaction.type === 'income' ? 1 : -1
      const amount = convertMinor(transaction.amountMinor, transaction.currency, defaultCurrency, transaction.date, data.fxRates) ?? 0
      const contribution = (isIncomeReportGroup(group) ? direction : -direction) * amount
      const current = totals.get(category.id)
      totals.set(category.id, { id: category.id, label: category.name, value: (current?.value ?? 0) + contribution, count: (current?.count ?? 0) + 1 })
    }
    return [...totals.values()].sort((left, right) => Math.abs(right.value) - Math.abs(left.value) || left.label.localeCompare(right.label))
  }
  const valuationAdjustments = data.transactions
    .filter((transaction) => inPeriod(transaction.date) && transaction.type === 'balance_adjustment' && (transaction.adjustmentReason === 'market_valuation' || transaction.adjustmentReason === 'asset_valuation'))
    .sort((left, right) => right.date.localeCompare(left.date))
  const valuationGroupFor = (transaction: Transaction): ValuationGroup => {
    const account = data.accounts.find((item) => item.id === transaction.accountId)
    if (transaction.adjustmentReason === 'market_valuation') return 'investments'
    if (account && accountBalanceSheetGroup(account) === 'Real estate') return 'real-estate'
    return 'other-assets'
  }
  const valuationGroupDefinitions: { id: ValuationGroup; label: string; description: string }[] = [
    { id: 'investments', label: 'Investment performance', description: 'Investment and pension accounts' },
    { id: 'real-estate', label: 'Real estate value changes', description: 'Homes and other property' },
    { id: 'other-assets', label: 'Other asset value changes', description: 'Vehicles and other personal or company assets' },
  ]
  const valuationGroups = valuationGroupDefinitions.map((group) => {
    const groupTransactions = valuationAdjustments.filter((transaction) => valuationGroupFor(transaction) === group.id)
    return { ...group, transactions: groupTransactions, total: groupTransactions.reduce((sum, transaction) => sum + (convertMinor(transaction.amountMinor, transaction.currency, defaultCurrency, transaction.date, data.fxRates) ?? 0), 0) }
  })
  const selectedValuationGroup = valuationGroups.find((group) => group.id === openValuationGroup)
  const companyActualProfit = companyActualRevenue - companyActualExpenses
  const companyTaxEstimate = estimatedTax(companyActualProfit)
  const personalActualNetIncome = personalActualIncome - personalActualExpenses - personalRecordedTaxes
  const companyActualNetIncome = companyActualRevenue - companyActualExpenses - companyRecordedTaxes - companyTaxEstimate

  const personalForecastIncome = totalBudgetsForGroup(reportBudgets, 'personal_income')
  const personalForecastExpenses = totalBudgetsForGroup(reportBudgets, 'personal_expense')
  const companyForecastRevenue = totalBudgetsForGroup(reportBudgets, 'company_revenue')
  const companyForecastExpenses = totalBudgetsForGroup(reportBudgets, 'company_expense')
  const personalPlannedTaxes = totalBudgetsForGroup(reportBudgets, 'personal_tax')
  const companyPlannedTaxes = totalBudgetsForGroup(reportBudgets, 'company_tax')
  const companyForecastProfit = companyForecastRevenue - companyForecastExpenses
  const forecastTax = estimatedTax(companyForecastProfit)
  const personalForecastNetIncome = personalForecastIncome - personalForecastExpenses - personalPlannedTaxes
  const companyForecastNetIncome = companyForecastRevenue - companyForecastExpenses - companyPlannedTaxes - forecastTax
  const forecastGlobalNetIncome = personalForecastNetIncome + companyForecastNetIncome
  const actualGlobalNetIncome = personalActualNetIncome + companyActualNetIncome
  const historyPeriods = period === 'month'
    ? Array.from({ length: 12 }, (_, index) => {
      const date = new Date(viewedMonth.getFullYear(), viewedMonth.getMonth() - (11 - index), 1)
      return { key: toMonthKey(date), label: new Intl.DateTimeFormat('en', { month: 'short' }).format(date) }
    })
    : (() => {
      const selectedYear = viewedMonth.getFullYear()
      const earliestYear = data.transactions.length ? Math.min(...data.transactions.map((transaction) => Number(transaction.date.slice(0, 4)))) : selectedYear
      const firstYear = Math.min(selectedYear, earliestYear)
      return Array.from({ length: selectedYear - firstYear + 1 }, (_, index) => ({ key: String(firstYear + index), label: String(firstYear + index) }))
    })()
  const pnlHistoryPoints: PnlHistoryPoint[] = historyPeriods.map(({ key, label }) => {
    const periodTransactions = data.transactions.filter((transaction) => transaction.date.startsWith(key) && (transaction.type === 'income' || transaction.type === 'expense'))
    const personalIncome = totalTransactionsForGroup(periodTransactions, 'personal_income')
    const companyRevenue = totalTransactionsForGroup(periodTransactions, 'company_revenue')
    const personalExpenses = totalTransactionsForGroup(periodTransactions, 'personal_expense')
    const companyExpenses = totalTransactionsForGroup(periodTransactions, 'company_expense')
    const personalTaxes = totalTransactionsForGroup(periodTransactions, 'personal_tax')
    const companyTaxes = totalTransactionsForGroup(periodTransactions, 'company_tax') + estimatedTax(companyRevenue - companyExpenses)
    const income = pnlScope === 'personal' ? personalIncome : pnlScope === 'company' ? companyRevenue : personalIncome + companyRevenue
    const expenses = pnlScope === 'personal' ? personalExpenses : pnlScope === 'company' ? companyExpenses : personalExpenses + companyExpenses
    const taxes = pnlScope === 'personal' ? personalTaxes : pnlScope === 'company' ? companyTaxes : personalTaxes + companyTaxes
    return { key, label, income, expenses, taxes, netIncome: income - expenses - taxes }
  })
  const pnlScopeLabel = pnlScope === 'combined' ? 'Combined' : pnlScope === 'personal' ? 'Personal' : 'Company'
  function togglePnlMetric(metric: PnlMetric) {
    setPnlMetrics((current) => current.includes(metric) ? current.length === 1 ? current : current.filter((item) => item !== metric) : [...current, metric])
  }

  return <div className="page-content narrow-page report-page">
    {toolbar}
    <section className="report-hero">
      <div><span className="eyebrow">Personal + company · {period === 'month' ? monthName.format(viewedMonth) : yearKey}</span><h2>Profit &amp; loss</h2><p>See the combined result first, followed by separate Personal and Company detail. Internal transfers are excluded.</p></div>
      <label className="tax-rate-field"><span>Company tax planning rate</span><div><input type="number" min="0" max="100" step="0.1" value={data.settings.estimatedCompanyTaxRateBps / 100} onChange={(event) => onUpdateTaxRate(Math.max(0, Math.round(Number(event.target.value) * 100)))} /><b>%</b></div><small>Planning estimate only</small></label>
    </section>
    <section className="panel pnl-history">
      <div className="net-worth-section-heading"><div><span className="eyebrow">{period === 'month' ? 'Trailing 12 months' : 'Annual history'}</span><h3>P&amp;L over time</h3><p>{pnlScopeLabel} results through {period === 'month' ? monthName.format(viewedMonth) : yearKey}. Choose a scope and any combination of measures.</p></div>{historyLoading && <span className="history-loading"><LoaderCircle size={14} />Loading full history</span>}</div>
      <div className="pnl-chart-filters">
        <div className="segmented three-way pnl-scope-selector" aria-label="P&L chart scope"><button className={pnlScope === 'combined' ? 'active transfer' : ''} aria-pressed={pnlScope === 'combined'} onClick={() => setPnlScope('combined')}>Combined</button><button className={pnlScope === 'personal' ? 'active transfer' : ''} aria-pressed={pnlScope === 'personal'} onClick={() => setPnlScope('personal')}>Personal</button><button className={pnlScope === 'company' ? 'active transfer' : ''} aria-pressed={pnlScope === 'company'} onClick={() => setPnlScope('company')}>Company</button></div>
        <div className="pnl-chart-legend" aria-label="P&L chart measures">{pnlMetricDefinitions.map((metric) => <button type="button" key={metric.id} className={pnlMetrics.includes(metric.id) ? 'selected' : ''} aria-pressed={pnlMetrics.includes(metric.id)} onClick={() => togglePnlMetric(metric.id)}><i className={metric.id === 'netIncome' ? 'net' : metric.id} />{metric.label}</button>)}</div>
      </div>
      <PnlBarChart points={pnlHistoryPoints} currency={defaultCurrency} metrics={pnlMetrics} />
    </section>
    <section className="report-scope-section combined-report-section"><div className="report-scope-heading"><span className="eyebrow">At a glance</span><h3>Combined P&amp;L</h3></div><div className="report-comparison">
      <CombinedReportColumn title="Forecast" subtitle="From monthly budgets" currency={defaultCurrency} personalIncome={personalForecastIncome} personalExpenses={personalForecastExpenses} personalTax={personalPlannedTaxes} companyRevenue={companyForecastRevenue} companyExpenses={companyForecastExpenses} companyTax={companyPlannedTaxes + forecastTax} globalNetIncome={forecastGlobalNetIncome} />
      <CombinedReportColumn title="Actual" subtitle="From recorded activity" currency={defaultCurrency} personalIncome={personalActualIncome} personalExpenses={personalActualExpenses} personalTax={personalRecordedTaxes} companyRevenue={companyActualRevenue} companyExpenses={companyActualExpenses} companyTax={companyRecordedTaxes + companyTaxEstimate} globalNetIncome={actualGlobalNetIncome} />
    </div></section>
    <section className="report-scope-section"><div className="report-scope-heading"><span className="eyebrow">Personal</span><h3>Personal P&amp;L</h3></div><div className="report-comparison">
      <ReportColumn title="Forecast" subtitle="From monthly budgets" currency={defaultCurrency} income={personalForecastIncome} expenses={personalForecastExpenses} otherTax={personalPlannedTaxes} otherTaxLabel="Planned taxes" netIncome={personalForecastNetIncome} />
      <ReportColumn title="Actual" subtitle="From recorded activity" currency={defaultCurrency} income={personalActualIncome} expenses={personalActualExpenses} otherTax={personalRecordedTaxes} otherTaxLabel="Recorded taxes" netIncome={personalActualNetIncome} breakdowns={{ income: actualBreakdown('personal_income'), expenses: actualBreakdown('personal_expense') }} />
    </div></section>
    <section className="report-scope-section"><div className="report-scope-heading"><span className="eyebrow">Company</span><h3>Company P&amp;L</h3></div><div className="report-comparison">
      <ReportColumn title="Forecast" subtitle="From monthly budgets" currency={defaultCurrency} incomeLabel="Revenue" income={companyForecastRevenue} expenses={companyForecastExpenses} tax={forecastTax} otherTax={companyPlannedTaxes} otherTaxLabel="Other planned taxes" netIncome={companyForecastNetIncome} />
      <ReportColumn title="Actual" subtitle="From recorded activity" currency={defaultCurrency} incomeLabel="Revenue" income={companyActualRevenue} expenses={companyActualExpenses} tax={companyTaxEstimate} otherTax={companyRecordedTaxes} otherTaxLabel="Other recorded taxes" netIncome={companyActualNetIncome} breakdowns={{ income: actualBreakdown('company_revenue'), expenses: actualBreakdown('company_expense') }} />
    </div></section>
    <section className="panel valuation-summary">
      <div className="valuation-summary-heading"><div><span className="eyebrow">Excluded from P&amp;L</span><h3>Balance-sheet performance</h3><p>Value changes are separated by asset type so they do not distort net income.</p></div></div>
      <div className="valuation-summary-grid">{valuationGroups.map((group) => <button type="button" key={group.id} className={openValuationGroup === group.id ? 'valuation-summary-card selected' : 'valuation-summary-card'} aria-expanded={openValuationGroup === group.id} aria-controls="valuation-drilldown" onClick={() => setOpenValuationGroup((current) => current === group.id ? null : group.id)}><span><strong>{group.label}</strong><small>{group.description} · {group.transactions.length} adjustment{group.transactions.length === 1 ? '' : 's'}</small></span><span><strong className={group.total < 0 ? 'negative' : group.total > 0 ? 'positive' : ''}>{formatMoney(group.total, defaultCurrency)}</strong><ChevronDown className={openValuationGroup === group.id ? 'expanded' : ''} size={15} /></span></button>)}</div>
    </section>
    {selectedValuationGroup && <section className="panel valuation-drilldown" id="valuation-drilldown">
      <div className="valuation-drilldown-heading"><div><span className="eyebrow">Actual · {period === 'month' ? monthName.format(viewedMonth) : yearKey}</span><h3>{selectedValuationGroup.label}</h3><p>{selectedValuationGroup.transactions.length} adjustment{selectedValuationGroup.transactions.length === 1 ? '' : 's'} contributing {formatMoney(selectedValuationGroup.total, defaultCurrency)}.</p></div><button type="button" className="icon-button" aria-label="Close value-change details" onClick={() => setOpenValuationGroup(null)}><X size={17} /></button></div>
      {selectedValuationGroup.transactions.length ? <div className="valuation-drilldown-list">{selectedValuationGroup.transactions.map((transaction) => {
        const account = data.accounts.find((item) => item.id === transaction.accountId)
        const convertedAmount = convertMinor(transaction.amountMinor, transaction.currency, defaultCurrency, transaction.date, data.fxRates) ?? 0
        return <button type="button" className="valuation-drilldown-row" key={transaction.id} onClick={() => onEditTransaction(transaction)}>
          <span><strong>{account?.name ?? 'Unknown account'}</strong><small>{formatShortDate(transaction.date)} · {transaction.adjustmentReason ? balanceAdjustmentReasonLabels[transaction.adjustmentReason] : 'Valuation adjustment'}{transaction.note ? ` · ${transaction.note}` : ''}</small></span>
          <span className="valuation-drilldown-amount"><strong className={convertedAmount < 0 ? 'negative' : 'positive'}>{formatMoney(convertedAmount, defaultCurrency)}</strong>{transaction.currency !== defaultCurrency && <small>{formatMoney(transaction.amountMinor, transaction.currency)}</small>}</span>
          <Pencil size={14} />
        </button>
      })}</div> : <div className="valuation-drilldown-empty">No market or asset valuation adjustments in this period.</div>}
    </section>}
    <div className="report-footnote"><CircleHelp size={16} /><p>Company tax is estimated from tagged company income minus tagged company expenses. Transfers and all balance-sheet valuation changes are excluded from P&amp;L. Foreign-currency activity is converted to {defaultCurrency} using the latest saved rate from that month or earlier.</p></div>
  </div>
}

type NetWorthPoint = { key: string; label: string; cutoff: string; value: number }

function accountBalanceAt(account: Account, transactions: Transaction[], cutoff: string) {
  return transactions.reduce((balance, transaction) => {
    if (transaction.date > cutoff) return balance
    if (transaction.accountId === account.id) {
      if (transaction.type === 'income' || transaction.type === 'opening_balance' || transaction.type === 'balance_adjustment') balance += transaction.amountMinor
      if (transaction.type === 'expense' || transaction.type === 'transfer') balance -= transaction.amountMinor
    }
    if (transaction.type === 'transfer' && transaction.toAccountId === account.id) {
      balance += transaction.destinationAmountMinor || transaction.amountMinor
    }
    return balance
  }, 0)
}

function endOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10)
}

function netWorthHistory(data: AppData, viewedMonth: Date, defaultCurrency: string, period: ReportPeriod): NetWorthPoint[] {
  const accounts = data.accounts.filter((account) => !account.closed)
  const pointValue = (cutoff: string) => accounts.reduce((total, account) => {
    const balance = accountBalanceAt(account, data.transactions, cutoff)
    return total + (convertMinor(balance, account.currency, defaultCurrency, cutoff, data.fxRates) ?? 0)
  }, 0)

  if (period === 'month') {
    return Array.from({ length: 12 }, (_, index) => {
      const date = new Date(viewedMonth.getFullYear(), viewedMonth.getMonth() - (11 - index), 1)
      const cutoff = endOfMonth(date.getFullYear(), date.getMonth())
      return {
        key: toMonthKey(date),
        label: new Intl.DateTimeFormat('en', { month: 'short' }).format(date),
        cutoff,
        value: pointValue(cutoff),
      }
    })
  }

  const selectedYear = viewedMonth.getFullYear()
  const earliestYear = data.transactions.length
    ? Math.min(...data.transactions.map((transaction) => Number(transaction.date.slice(0, 4))))
    : selectedYear
  const firstYear = Math.min(selectedYear, earliestYear)
  return Array.from({ length: selectedYear - firstYear + 1 }, (_, index) => {
    const year = firstYear + index
    const cutoff = `${year}-12-31`
    return { key: String(year), label: String(year), cutoff, value: pointValue(cutoff) }
  })
}

function NetWorthReport({ data, viewedMonth, defaultCurrency, period, historyLoading, toolbar }: { data: AppData; viewedMonth: Date; defaultCurrency: string; period: ReportPeriod; historyLoading: boolean; toolbar: ReactNode }) {
  const accounts = data.accounts.filter((account) => !account.closed)
  const currentDate = todayInParis()
  const currentBalance = (account: Account) => convertMinor(account.balanceMinor, account.currency, defaultCurrency, currentDate, data.fxRates) ?? 0
  const totalBalance = accounts.reduce((sum, account) => sum + currentBalance(account), 0)
  const groups = balanceSheetGroups.map((group) => {
    const groupAccounts = accounts.filter((account) => accountBalanceSheetGroup(account) === group)
    return { group, accounts: groupAccounts, total: groupAccounts.reduce((sum, account) => sum + currentBalance(account), 0) }
  }).filter((group) => group.accounts.length > 0)
  const points = netWorthHistory(data, viewedMonth, defaultCurrency, period)
  const previousValue = points.at(-2)?.value
  const periodChange = previousValue === undefined ? 0 : (points.at(-1)?.value ?? 0) - previousValue

  return <div className="page-content narrow-page report-page net-worth-report">
    {toolbar}
    <section className="net-worth-hero">
      <div><span className="eyebrow">Current balance sheet</span><h2>Net worth</h2><p>Everything you own across personal, company, property, and pension accounts, less any negative balances.</p></div>
      <div className="net-worth-total"><span>Current net worth</span><strong>{formatMoney(totalBalance, defaultCurrency)}</strong><small className={periodChange < 0 ? 'negative' : periodChange > 0 ? 'positive' : ''}>{previousValue === undefined ? 'No previous period' : `Latest period ${periodChange >= 0 ? '+' : ''}${formatMoney(periodChange, defaultCurrency)}`}</small></div>
    </section>

    <section className="panel net-worth-history">
      <div className="net-worth-section-heading"><div><span className="eyebrow">{period === 'month' ? 'Trailing 12 months' : 'Annual history'}</span><h3>Net worth over time</h3><p>{period === 'month' ? `Month-end balances through ${monthName.format(viewedMonth)}.` : `Year-end balances through ${viewedMonth.getFullYear()}.`} Transfers are counted once on each side and balance checkpoints are applied on their recorded dates.</p></div>{historyLoading && <span className="history-loading"><LoaderCircle size={14} />Loading full history</span>}</div>
      <NetWorthBarChart points={points} currency={defaultCurrency} />
    </section>

    <section className="panel net-worth-breakdown">
      <div className="net-worth-section-heading"><div><span className="eyebrow">Today</span><h3>Current net worth breakdown</h3><p>{accounts.length} active account{accounts.length === 1 ? '' : 's'}, converted to {defaultCurrency} at the latest saved exchange rates.</p></div></div>
      <div className="net-worth-breakdown-grid">{groups.map((group) => <div className="net-worth-group" key={group.group}>
        <div className="net-worth-group-heading"><span>{group.group}</span><strong className={group.total < 0 ? 'negative' : ''}>{formatMoney(group.total, defaultCurrency)}</strong></div>
        <div className="net-worth-account-list">{group.accounts.map((account) => <div key={account.id}><span><i style={{ background: account.color }} />{account.name}</span><strong className={currentBalance(account) < 0 ? 'negative' : ''}>{formatMoney(currentBalance(account), defaultCurrency)}</strong></div>)}</div>
      </div>)}</div>
    </section>
    <div className="report-footnote"><CircleHelp size={16} /><p>Historical balances are reconstructed from recorded transactions and dated valuation checkpoints. Foreign-currency balances use the latest exchange rate saved for each chart date.</p></div>
  </div>
}

function NetWorthBarChart({ points, currency }: { points: NetWorthPoint[]; currency: string }) {
  const values = points.map((point) => point.value)
  const minimum = Math.min(0, ...values)
  const maximum = Math.max(0, ...values)
  const range = Math.max(1, maximum - minimum)
  const zeroPosition = (-minimum / range) * 100

  return <div className="net-worth-chart-scroll">
    <div className="net-worth-chart" style={{ minWidth: `${Math.max(680, points.length * 72)}px` }} role="img" aria-label={`Net worth ${points.map((point) => `${point.label}: ${formatMoney(point.value, currency)}`).join(', ')}`}>
      {points.map((point) => {
        const height = Math.abs(point.value) / range * 100
        const bottom = (Math.min(0, point.value) - minimum) / range * 100
        return <div className="net-worth-chart-column" key={point.key} title={`${point.label}: ${formatMoney(point.value, currency)}`}>
          <strong className={point.value < 0 ? 'negative' : ''}>{formatCompactMoney(point.value, currency)}</strong>
          <div className="net-worth-bar-track"><span className="net-worth-zero-axis" style={{ bottom: `${zeroPosition}%` }} /><i className={point.value < 0 ? 'negative' : ''} style={{ bottom: `${bottom}%`, height: `${Math.max(point.value === 0 ? 0 : 1.5, height)}%` }} /></div>
          <span>{point.label}</span>
        </div>
      })}
    </div>
  </div>
}

function PnlBarChart({ points, currency, metrics }: { points: PnlHistoryPoint[]; currency: string; metrics: PnlMetric[] }) {
  const signedValue = (point: PnlHistoryPoint, metric: PnlMetric) => metric === 'expenses' ? -point.expenses : metric === 'taxes' ? -point.taxes : point[metric]
  const signedValues = points.flatMap((point) => metrics.map((metric) => signedValue(point, metric)))
  const minimum = Math.min(0, ...signedValues)
  const maximum = Math.max(0, ...signedValues)
  const range = Math.max(1, maximum - minimum)
  const zeroPosition = (-minimum / range) * 100
  const styleFor = (value: number) => ({ bottom: `${(Math.min(0, value) - minimum) / range * 100}%`, height: `${Math.max(value === 0 ? 0 : 1.5, Math.abs(value) / range * 100)}%` })
  const metricLabel = (metric: PnlMetric) => pnlMetricDefinitions.find((item) => item.id === metric)?.label ?? metric
  const barSlot = 100 / metrics.length
  const barWidth = Math.min(24, barSlot * .66)

  return <div className="net-worth-chart-scroll pnl-chart-scroll">
      <div className="net-worth-chart pnl-chart" style={{ minWidth: `${Math.max(680, points.length * 72)}px` }} role="img" aria-label={`Profit and loss history: ${points.map((point) => `${point.label}, ${metrics.map((metric) => `${metricLabel(metric)} ${formatMoney(signedValue(point, metric), currency)}`).join(', ')}`).join('; ')}`}>
        {points.map((point) => {
          const headlineMetric = metrics.includes('netIncome') ? 'netIncome' : metrics[0]
          const headlineValue = signedValue(point, headlineMetric)
          const title = `${point.label} · ${metrics.map((metric) => `${metricLabel(metric)} ${formatMoney(signedValue(point, metric), currency)}`).join(' · ')}`
          return <div className="net-worth-chart-column pnl-chart-column" key={point.key} title={title}>
          <strong className={headlineValue < 0 ? 'negative' : ''}>{formatCompactMoney(headlineValue, currency)}</strong>
          <div className="net-worth-bar-track pnl-bar-track"><span className="net-worth-zero-axis" style={{ bottom: `${zeroPosition}%` }} />{metrics.map((metric, index) => {
            const value = signedValue(point, metric)
            return <i key={metric} className={`${metric === 'netIncome' ? 'net' : metric} ${metric === 'netIncome' && value < 0 ? 'negative' : ''}`} style={{ ...styleFor(value), left: `${index * barSlot + (barSlot - barWidth) / 2}%`, width: `${barWidth}%` }} />
          })}</div>
          <span>{point.label}</span>
        </div>})}
      </div>
    </div>
}

type ReportBreakdownItem = { id: string; label: string; value: number; count: number }

function CombinedReportColumn({ title, subtitle, currency, personalIncome, personalExpenses, personalTax, companyRevenue, companyExpenses, companyTax, globalNetIncome }: { title: string; subtitle: string; currency: string; personalIncome: number; personalExpenses: number; personalTax: number; companyRevenue: number; companyExpenses: number; companyTax: number; globalNetIncome: number }) {
  const row = (label: string, value: number, tone = '') => <div className={`report-row ${tone}`}><span>{label}</span><strong>{formatMoney(value, currency)}</strong></div>
  return <section className="panel report-column combined-report-column">
    <div className="report-column-heading"><div><span className="eyebrow">{subtitle}</span><h3>{title}</h3></div></div>
    <div className="combined-report-group"><span className="combined-report-group-label">Income</span>{row('Personal', personalIncome, 'combined-report-split-row income-row')}{row('Company', companyRevenue, 'combined-report-split-row income-row')}{row('Total income', personalIncome + companyRevenue, 'result-row subtotal-result')}</div>
    <div className="combined-report-group"><span className="combined-report-group-label">Expenses</span>{row('Personal', -personalExpenses, 'combined-report-split-row')}{row('Company', -companyExpenses, 'combined-report-split-row')}{row('Total expenses', -(personalExpenses + companyExpenses), 'result-row subtotal-result')}</div>
    <div className="combined-report-group"><span className="combined-report-group-label">Taxes</span>{row('Personal', -personalTax, 'combined-report-split-row')}{row('Company', -companyTax, 'combined-report-split-row')}{row('Total taxes', -(personalTax + companyTax), 'result-row subtotal-result')}</div>
    <div className="report-divider" />
    {row('Global net income', globalNetIncome, 'result-row final-result')}
  </section>
}

function ReportColumn({ title, subtitle, currency, incomeLabel = 'Income', income, expenses, tax, otherTax, otherTaxLabel, netIncome, breakdowns }: { title: string; subtitle: string; currency: string; incomeLabel?: string; income: number; expenses: number; tax?: number; otherTax: number; otherTaxLabel: string; netIncome: number; breakdowns?: { income: ReportBreakdownItem[]; expenses: ReportBreakdownItem[] } }) {
  const [expanded, setExpanded] = useState<'income' | 'expenses' | null>(null)
  const row = (label: string, value: number, tone?: string) => <div className={`report-row ${tone ?? ''}`}><span>{label}</span><strong>{formatMoney(value, currency)}</strong></div>
  const expandableRow = (id: 'income' | 'expenses', label: string, value: number, tone?: string) => {
    const items = breakdowns?.[id] ?? []
    const open = expanded === id
    return <div className={`report-expandable ${open ? 'open' : ''}`}>
      <button type="button" className={`report-row report-row-button ${tone ?? ''}`} aria-expanded={open} disabled={!items.length} onClick={() => setExpanded((current) => current === id ? null : id)}><span><ChevronRight className={open ? 'expanded' : ''} size={14} />{label}</span><strong>{formatMoney(value, currency)}</strong></button>
      {open && <div className="report-breakdown-list">{items.map((item) => <div className="report-breakdown-row" key={item.id}><span><strong>{item.label}</strong><small>{item.count} transaction{item.count === 1 ? '' : 's'}</small></span><b>{formatMoney(id === 'expenses' ? -item.value : item.value, currency)}</b></div>)}</div>}
    </div>
  }
  return <section className="panel report-column"><div className="report-column-heading"><div><span className="eyebrow">{subtitle}</span><h3>{title}</h3></div></div>{breakdowns ? expandableRow('income', incomeLabel, income, 'income-row') : row(incomeLabel, income, 'income-row')}{breakdowns ? expandableRow('expenses', 'Expenses', -expenses) : row('Expenses', -expenses)}{tax !== undefined && row('Calculated company tax', -tax)}{otherTax !== 0 && row(otherTaxLabel, -otherTax)}<div className="report-divider" />{row('Net income', netIncome, 'result-row final-result')}</section>
}
