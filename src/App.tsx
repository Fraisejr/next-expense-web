import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, BadgeEuro, Banknote, BriefcaseBusiness,
  BarChart3, CalendarDays, CarFront, ChevronDown, ChevronLeft, ChevronRight, CircleHelp,
  CreditCard, House, LayoutDashboard, Menu, Plus, ReceiptText, Search, Settings,
  ShoppingBasket, Sparkles, Target, Utensils, WalletCards, X,
} from 'lucide-react'
import { seedData } from './data'
import type { Account, AccountScope, AppData, Category, ReportGroup, Transaction } from './types'

type Page = 'overview' | 'transactions' | 'budgets' | 'reports' | 'accounts'
type Modal = 'transaction' | 'account' | 'category' | null
const STORAGE_KEY = 'next-expense-data-v9'

const money = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' })
const monthName = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' })
const shortDate = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' })

function formatMoney(amountMinor: number) {
  return money.format(amountMinor / 100)
}

function parseMoneyToMinor(value: string, allowNegative = false) {
  const normalized = value.trim().replace(',', '.')
  const negative = normalized.startsWith('-')
  const unsigned = negative ? normalized.slice(1) : normalized
  if (!/^\d+(\.\d{0,2})?$/.test(unsigned) || (negative && !allowNegative)) return null
  const [whole, fraction = ''] = unsigned.split('.')
  const amountMinor = (Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) * (negative ? -1 : 1)
  return Number.isSafeInteger(amountMinor) ? amountMinor : null
}

const categoryIcons = {
  house: House,
  basket: ShoppingBasket,
  car: CarFront,
  utensils: Utensils,
  sparkles: Sparkles,
  receipt: ReceiptText,
  briefcase: BriefcaseBusiness,
}

const navItems: { id: Page; label: string; icon: typeof House }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'transactions', label: 'Transactions', icon: ReceiptText },
  { id: 'budgets', label: 'Budgets', icon: Target },
  { id: 'reports', label: 'Performance', icon: BarChart3 },
  { id: 'accounts', label: 'Accounts', icon: WalletCards },
]

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function inMonth(date: string, viewed: Date) {
  const d = new Date(`${date}T12:00:00`)
  return d.getMonth() === viewed.getMonth() && d.getFullYear() === viewed.getFullYear()
}

function toMonthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function loadData(): AppData {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? JSON.parse(saved) : structuredClone(seedData)
  } catch {
    return structuredClone(seedData)
  }
}

function App() {
  const [data, setData] = useState<AppData>(loadData)
  const [shouldLoadLocalImport] = useState(() => !localStorage.getItem(STORAGE_KEY))
  const [page, setPage] = useState<Page>('overview')
  const [modal, setModal] = useState<Modal>(null)
  const [viewedMonth, setViewedMonth] = useState(() => new Date())
  const [search, setSearch] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)

  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(data)), [data])

  useEffect(() => {
    if (!shouldLoadLocalImport) return
    fetch('/imported-data.local.json')
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((imported: AppData) => setData(imported))
      .catch(() => undefined)
  }, [shouldLoadLocalImport])

  const transactions = useMemo(
    () => data.transactions
      .filter((t) => inMonth(t.date, viewedMonth))
      .sort((a, b) => b.date.localeCompare(a.date)),
    [data.transactions, viewedMonth],
  )
  const selectedMonthKey = toMonthKey(viewedMonth)
  const categoryGroup = (categoryId?: string) => data.categories.find((category) => category.id === categoryId)?.reportGroup
  const income = transactions
    .filter((t) => categoryGroup(t.categoryId) === 'income')
    .reduce((sum, t) => sum + (t.type === 'income' ? t.amountMinor : t.type === 'expense' ? -t.amountMinor : 0), 0)
  const expenses = transactions
    .filter((t) => categoryGroup(t.categoryId) === 'expense')
    .reduce((sum, t) => sum + (t.type === 'expense' ? t.amountMinor : t.type === 'income' ? -t.amountMinor : 0), 0)
  const taxesPaid = transactions
    .filter((t) => categoryGroup(t.categoryId) === 'tax')
    .reduce((sum, t) => sum + (t.type === 'expense' ? t.amountMinor : t.type === 'income' ? -t.amountMinor : 0), 0)
  const capitalGains = transactions
    .filter((t) => categoryGroup(t.categoryId) === 'capital_gain')
    .reduce((sum, t) => sum + (t.type === 'income' ? t.amountMinor : t.type === 'expense' ? -t.amountMinor : 0), 0)
  const net = income - expenses - taxesPaid + capitalGains
  const totalBalance = data.accounts.reduce((sum, account) => sum + account.balanceMinor, 0)
  const categorySpending = (id: string) => {
    const group = categoryGroup(id)
    return transactions
      .filter((t) => t.categoryId === id && t.type !== 'transfer')
      .reduce((sum, t) => {
        const direction = t.type === 'income' ? 1 : -1
        return sum + (group === 'income' || group === 'capital_gain' ? direction : -direction) * t.amountMinor
      }, 0)
  }
  const expenseCategories = data.categories.filter((c) => c.reportGroup === 'expense')
  const budgetForCategory = (categoryId: string) => data.budgets
    .filter((budget) => budget.month === selectedMonthKey && budget.categoryId === categoryId)
    .reduce((sum, budget) => sum + budget.amountMinor, 0)
  const totalBudget = expenseCategories.reduce((sum, category) => sum + budgetForCategory(category.id), 0)
  const pageTitle = navItems.find((item) => item.id === page)?.label ?? 'Overview'
  const selectedCategory = data.categories.find((category) => category.id === selectedCategoryId)
  const selectedAccount = data.accounts.find((account) => account.id === selectedAccountId)

  function moveMonth(delta: number) {
    setViewedMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1))
  }

  function addAccount(account: Omit<Account, 'id'>) {
    setData((current) => ({ ...current, accounts: [...current.accounts, { ...account, id: uid() }] }))
    setModal(null)
  }

  function addCategory(category: Omit<Category, 'id'>, budgetMinor: number, scope: AccountScope) {
    const categoryId = uid()
    setData((current) => ({
      ...current,
      categories: [...current.categories, { ...category, id: categoryId }],
      budgets: budgetMinor ? [...current.budgets, { id: uid(), month: selectedMonthKey, categoryId, scope, amountMinor: budgetMinor }] : current.budgets,
    }))
    setModal(null)
  }

  function updateBudget(categoryId: string, amountMinor: number, scope: AccountScope) {
    setData((current) => {
      const existing = current.budgets.find((budget) => budget.month === selectedMonthKey && budget.categoryId === categoryId && budget.scope === scope)
      return {
        ...current,
        budgets: existing
          ? current.budgets.map((budget) => budget.id === existing.id ? { ...budget, amountMinor } : budget)
          : [...current.budgets, { id: uid(), month: selectedMonthKey, categoryId, scope, amountMinor }],
      }
    })
  }

  function addTransaction(transaction: Omit<Transaction, 'id'>) {
    setData((current) => ({
      ...current,
      transactions: [...current.transactions, { ...transaction, id: uid() }],
      accounts: current.accounts.map((account) => {
        if (transaction.type === 'transfer') {
          if (account.id === transaction.accountId) return { ...account, balanceMinor: account.balanceMinor - transaction.amountMinor }
          if (account.id === transaction.toAccountId) return { ...account, balanceMinor: account.balanceMinor + transaction.amountMinor }
          return account
        }
        const signedAmount = transaction.type === 'income' ? transaction.amountMinor : -transaction.amountMinor
        return account.id === transaction.accountId ? { ...account, balanceMinor: account.balanceMinor + signedAmount } : account
      }),
    }))
    setModal(null)
  }

  return (
    <div className="app-shell">
      <aside className={mobileNav ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <div className="brand-mark"><ArrowRight size={19} strokeWidth={2.4} /></div>
          <span>Next Expense</span>
        </div>

        <nav className="nav-list">
          <p className="nav-label">Workspace</p>
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={page === id ? 'nav-item active' : 'nav-item'} onClick={() => { setPage(id); setMobileNav(false) }}>
              <Icon size={19} /><span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <button className="nav-item"><CircleHelp size={19} /><span>Help & feedback</span></button>
          <button className="nav-item"><Settings size={19} /><span>Settings</span></button>
          <div className="profile">
            <div className="avatar">MF</div>
            <div><strong>Michael</strong><span>Personal budget</span></div>
            <ChevronDown size={16} />
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="topbar-title">
            <button className="icon-button mobile-menu" aria-label="Open menu" onClick={() => setMobileNav(!mobileNav)}><Menu size={21} /></button>
            <div><span className="eyebrow">Personal budget</span><h1>{pageTitle}</h1></div>
          </div>
          <div className="top-actions">
            <div className="month-switcher">
              <button aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft size={17} /></button>
              <span><CalendarDays size={16} />{monthName.format(viewedMonth)}</span>
              <button aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight size={17} /></button>
            </div>
            <button className="primary-button" onClick={() => setModal('transaction')}><Plus size={18} />Add transaction</button>
          </div>
        </header>

        {page === 'overview' && (
          <Overview
            accounts={data.accounts} categories={expenseCategories} transactionCategories={data.categories} transactions={transactions}
            income={income} expenses={expenses} net={net} totalBalance={totalBalance}
            totalBudget={totalBudget} categorySpending={categorySpending} budgetForCategory={budgetForCategory}
            onAllTransactions={() => setPage('transactions')} onAddAccount={() => setModal('account')}
            onAddCategory={() => setModal('category')} onSelectCategory={setSelectedCategoryId} onSelectAccount={setSelectedAccountId}
          />
        )}
        {page === 'transactions' && (
          <TransactionsPage transactions={transactions} accounts={data.accounts} categories={data.categories} search={search} setSearch={setSearch} />
        )}
        {page === 'budgets' && (
          <BudgetsPage categories={data.categories} categorySpending={categorySpending} budgetForCategory={budgetForCategory} onAdd={() => setModal('category')} onSelectCategory={setSelectedCategoryId} />
        )}
        {page === 'reports' && (
          <ReportsPage data={data} viewedMonth={viewedMonth} onUpdateTaxRate={(estimatedCompanyTaxRateBps) => setData((current) => ({ ...current, settings: { ...current.settings, estimatedCompanyTaxRateBps } }))} />
        )}
        {page === 'accounts' && (
          <AccountsPage accounts={data.accounts} totalBalance={totalBalance} onAdd={() => setModal('account')} onSelectAccount={setSelectedAccountId} />
        )}
      </main>

      {modal && (
        <ModalShell title={modal === 'transaction' ? 'Add transaction' : modal === 'account' ? 'Create account' : 'Create category'} onClose={() => setModal(null)}>
          {modal === 'transaction' && <TransactionForm accounts={data.accounts} categories={data.categories} onSubmit={addTransaction} />}
          {modal === 'account' && <AccountForm onSubmit={addAccount} />}
          {modal === 'category' && <CategoryForm onSubmit={addCategory} />}
        </ModalShell>
      )}
      {selectedCategory && (
        <ModalShell title={selectedCategory.name} onClose={() => setSelectedCategoryId(null)}>
          <CategoryDetail
            category={selectedCategory}
            spent={categorySpending(selectedCategory.id)}
            budget={budgetForCategory(selectedCategory.id)}
            transactions={transactions.filter((transaction) => transaction.categoryId === selectedCategory.id)}
            categories={data.categories}
            accounts={data.accounts}
            onUpdateBudget={updateBudget}
          />
        </ModalShell>
      )}
      {selectedAccount && (
        <ModalShell title={selectedAccount.name} onClose={() => setSelectedAccountId(null)}>
          <AccountDetail
            account={selectedAccount}
            transactions={transactions.filter((transaction) => transaction.accountId === selectedAccount.id || transaction.toAccountId === selectedAccount.id)}
            categories={data.categories}
            accounts={data.accounts}
          />
        </ModalShell>
      )}
    </div>
  )
}

function Overview({ accounts, categories, transactionCategories, transactions, income, expenses, net, totalBalance, totalBudget, categorySpending, budgetForCategory, onAllTransactions, onAddAccount, onAddCategory, onSelectCategory, onSelectAccount }: {
  accounts: Account[]; categories: Category[]; transactionCategories: Category[]; transactions: Transaction[]; income: number; expenses: number; net: number; totalBalance: number; totalBudget: number
  categorySpending: (id: string) => number; budgetForCategory: (id: string) => number; onAllTransactions: () => void; onAddAccount: () => void; onAddCategory: () => void; onSelectCategory: (id: string) => void; onSelectAccount: (id: string) => void
}) {
  const budgetUsed = totalBudget ? Math.round((expenses / totalBudget) * 100) : 0
  return (
    <div className="page-content">
      <section className="hero-grid">
        <div className="balance-card">
          <div className="card-heading"><span>Provisional balance</span><BadgeEuro size={20} /></div>
          <strong>{formatMoney(totalBalance)}</strong>
          <div className="balance-meta"><span>Across {accounts.length} accounts</span><span>Opening balances pending</span></div>
          <div className="balance-orbit orbit-one" /><div className="balance-orbit orbit-two" />
        </div>
        <MetricCard label="Income" value={income} icon={<ArrowDownLeft size={19} />} tone="green" detail="This month" />
        <MetricCard label="Expenses" value={expenses} icon={<ArrowUpRight size={19} />} tone="rust" detail={`${budgetUsed}% of budget`} />
        <MetricCard label="Net cash flow" value={net} icon={<ArrowRight size={19} />} tone="blue" detail={net >= 0 ? 'You kept more than you spent' : 'Spending exceeds income'} />
      </section>

      <section className="content-grid">
        <div className="panel spending-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">Monthly plan</span><h2>Spending by category</h2></div>
            <button className="text-button" onClick={onAddCategory}><Plus size={16} />New category</button>
          </div>
          <div className="budget-summary">
            <div><span>Spent</span><strong>{formatMoney(expenses)}</strong></div>
            <div className="summary-rule" />
            <div><span>Budgeted</span><strong>{formatMoney(totalBudget)}</strong></div>
            <div className="summary-rule" />
            <div><span>Available</span><strong className={totalBudget - expenses < 0 ? 'negative' : ''}>{formatMoney(totalBudget - expenses)}</strong></div>
          </div>
          <div className="category-list">
            {categories.map((category) => <CategoryRow key={category.id} category={category} spent={categorySpending(category.id)} budget={budgetForCategory(category.id)} onSelect={() => onSelectCategory(category.id)} />)}
          </div>
        </div>

        <div className="side-stack">
          <div className="panel accounts-panel">
            <div className="panel-heading compact"><h2>Accounts</h2><button className="icon-button" aria-label="Add account" onClick={onAddAccount}><Plus size={18} /></button></div>
            {accounts.map((account) => (
              <button type="button" className="account-row" key={account.id} onClick={() => onSelectAccount(account.id)} aria-label={`View ${account.name} transactions`}>
                <span className="account-dot" style={{ background: account.color }}><CreditCard size={17} /></span>
                <div><strong>{account.name}</strong><span>{account.scope} · {account.type}</span></div>
                <b>{formatMoney(account.balanceMinor)}</b>
              </button>
            ))}
          </div>

          <div className="panel recent-panel">
            <div className="panel-heading compact"><h2>Recent activity</h2><button className="text-button" onClick={onAllTransactions}>View all</button></div>
            {transactions.slice(0, 5).map((transaction) => (
              <TransactionRow key={transaction.id} transaction={transaction} categories={transactionCategories} accounts={accounts} compact />
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

function MetricCard({ label, value, icon, tone, detail }: { label: string; value: number; icon: React.ReactNode; tone: string; detail: string }) {
  return <div className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><span>{label}</span><strong>{formatMoney(value)}</strong><small>{detail}</small></div>
}

function CategoryRow({ category, spent, budget, onSelect }: { category: Category; spent: number; budget: number; onSelect: () => void }) {
  const Icon = categoryIcons[category.icon as keyof typeof categoryIcons] ?? Sparkles
  const percent = budget ? Math.round((spent / budget) * 100) : 0
  return (
    <button type="button" className="category-row" onClick={onSelect} aria-label={`View ${category.name} transactions`}>
      <span className="category-icon" style={{ color: category.color, background: `${category.color}18` }}><Icon size={18} /></span>
      <div className="category-progress">
        <div><strong>{category.name}</strong><span>{formatMoney(spent)} <i>of {formatMoney(budget)}</i></span></div>
        <div className="progress-track"><span style={{ width: `${Math.min(percent, 100)}%`, background: percent > 100 ? '#ae4c38' : category.color }} /></div>
      </div>
      <b className={percent > 100 ? 'negative' : ''}>{percent}%</b>
    </button>
  )
}

function TransactionRow({ transaction, categories, accounts, compact = false, focusAccountId }: { transaction: Transaction; categories: Category[]; accounts: Account[]; compact?: boolean; focusAccountId?: string }) {
  const category = categories.find((item) => item.id === transaction.categoryId)
  const sourceAccount = accounts.find((item) => item.id === transaction.accountId)
  const destinationAccount = accounts.find((item) => item.id === transaction.toAccountId)
  const isTransfer = transaction.type === 'transfer'
  const transferIsIncoming = isTransfer && transaction.toAccountId === focusAccountId
  const prefix = transaction.type === 'income' || transferIsIncoming ? '+' : transaction.type === 'expense' || (isTransfer && focusAccountId) ? '−' : ''
  const Icon = isTransfer ? ArrowLeftRight : category ? (categoryIcons[category.icon as keyof typeof categoryIcons] ?? Sparkles) : ReceiptText
  return (
    <div className={compact ? 'transaction-row compact' : 'transaction-row'}>
      <span className="transaction-icon" style={{ color: isTransfer ? '#587486' : category?.color, background: isTransfer ? '#e5ecef' : `${category?.color ?? '#777'}18` }}><Icon size={18} /></span>
      <div>
        <strong>{isTransfer ? `Transfer to ${destinationAccount?.name ?? 'account'}` : transaction.merchant}</strong>
        <span>{isTransfer ? `${sourceAccount?.name ?? 'Account'} → ${destinationAccount?.name ?? 'Account'}` : category?.name ?? 'Uncategorised'} · {shortDate.format(new Date(`${transaction.date}T12:00:00`))}</span>
      </div>
      <b className={transaction.type === 'income' || transferIsIncoming ? 'positive' : isTransfer && !focusAccountId ? 'transfer-amount' : ''}>{prefix}{formatMoney(transaction.amountMinor)}</b>
    </div>
  )
}

function TransactionsPage({ transactions, accounts, categories, search, setSearch }: { transactions: Transaction[]; accounts: Account[]; categories: Category[]; search: string; setSearch: (value: string) => void }) {
  const filtered = transactions.filter((t) => `${t.merchant} ${t.note ?? ''} ${categories.find(c => c.id === t.categoryId)?.name ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  return (
    <div className="page-content narrow-page">
      <div className="panel full-panel">
        <div className="panel-heading transaction-heading"><div><span className="eyebrow">Ledger</span><h2>All transactions</h2></div><label className="search-box"><Search size={17} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search transactions" /></label></div>
        <div className="table-header"><span>Description</span><span>Account</span><span>Amount</span></div>
        <div className="transaction-list-full">
          {filtered.map((transaction) => (
            <div className="transaction-table-row" key={transaction.id}>
              <TransactionRow transaction={transaction} categories={categories} accounts={accounts} />
              <span className="account-name">{accounts.find((a) => a.id === transaction.accountId)?.name}{transaction.type === 'transfer' ? ` → ${accounts.find((a) => a.id === transaction.toAccountId)?.name ?? ''}` : ''}</span>
            </div>
          ))}
          {!filtered.length && <div className="empty-state"><ReceiptText size={28} /><h3>No transactions found</h3><p>Try a different search or add a new transaction.</p></div>}
        </div>
      </div>
    </div>
  )
}

function BudgetsPage({ categories, categorySpending, budgetForCategory, onAdd, onSelectCategory }: { categories: Category[]; categorySpending: (id: string) => number; budgetForCategory: (id: string) => number; onAdd: () => void; onSelectCategory: (id: string) => void }) {
  const incomeCategories = categories.filter((category) => category.reportGroup === 'income')
  const expenseCategories = categories.filter((category) => category.reportGroup === 'expense')
  const taxCategories = categories.filter((category) => category.reportGroup === 'tax')
  const section = (title: string, subtitle: string, rows: Category[]) => <section className="budget-section"><div className="budget-section-heading"><div><h3>{title}</h3><span>{subtitle}</span></div></div><div className="category-list roomy">{rows.map((category) => <CategoryRow key={category.id} category={category} spent={categorySpending(category.id)} budget={budgetForCategory(category.id)} onSelect={() => onSelectCategory(category.id)} />)}</div></section>
  return <div className="page-content narrow-page"><div className="panel full-panel"><div className="panel-heading"><div><span className="eyebrow">Monthly plan</span><h2>Income, expense & tax plan</h2></div><button className="secondary-button" onClick={onAdd}><Plus size={17} />New category</button></div>{section('Planned income', 'Actual income compared with this month’s plan', incomeCategories)}{section('Expense budgets', 'Net spending compared with this month’s budget', expenseCategories)}{taxCategories.length > 0 && section('Tax plan', 'Recorded tax costs compared with this month’s plan', taxCategories)}</div></div>
}

type ReportScope = 'Combined' | AccountScope
type ReportPeriod = 'month' | 'year'

function ReportsPage({ data, viewedMonth, onUpdateTaxRate }: { data: AppData; viewedMonth: Date; onUpdateTaxRate: (rateBps: number) => void }) {
  const [scope, setScope] = useState<ReportScope>('Combined')
  const [period, setPeriod] = useState<ReportPeriod>('month')
  const monthKey = toMonthKey(viewedMonth)
  const yearKey = String(viewedMonth.getFullYear())
  const accountById = new Map(data.accounts.map((account) => [account.id, account]))
  const categoryById = new Map(data.categories.map((category) => [category.id, category]))
  const inPeriod = (date: string) => period === 'month' ? date.startsWith(monthKey) : date.startsWith(yearKey)
  const scopeMatches = (accountScope?: AccountScope) => scope === 'Combined' || accountScope === scope
  const reportTransactions = data.transactions.filter((transaction) => inPeriod(transaction.date) && transaction.type !== 'transfer' && scopeMatches(accountById.get(transaction.accountId)?.scope))
  const companyTransactions = data.transactions.filter((transaction) => inPeriod(transaction.date) && transaction.type !== 'transfer' && accountById.get(transaction.accountId)?.scope === 'Company')
  const budgetInPeriod = (month: string) => period === 'month' ? month === monthKey : month.startsWith(yearKey)
  const reportBudgets = data.budgets.filter((budget) => budgetInPeriod(budget.month) && (scope === 'Combined' || budget.scope === scope))
  const companyBudgets = data.budgets.filter((budget) => budgetInPeriod(budget.month) && budget.scope === 'Company')

  const totalTransactionsForGroup = (transactions: Transaction[], group: ReportGroup) => transactions
    .filter((transaction) => categoryById.get(transaction.categoryId ?? '')?.reportGroup === group)
    .reduce((sum, transaction) => {
      const direction = transaction.type === 'income' ? 1 : -1
      return sum + (group === 'income' || group === 'capital_gain' ? direction : -direction) * transaction.amountMinor
    }, 0)
  const totalBudgetsForGroup = (budgets: AppData['budgets'], group: ReportGroup) => budgets
    .filter((budget) => categoryById.get(budget.categoryId)?.reportGroup === group)
    .reduce((sum, budget) => sum + budget.amountMinor, 0)
  const estimatedTax = (profitMinor: number) => Math.max(0, Math.round(profitMinor * data.settings.estimatedCompanyTaxRateBps / 10_000))

  const actualIncome = totalTransactionsForGroup(reportTransactions, 'income')
  const actualExpenses = totalTransactionsForGroup(reportTransactions, 'expense')
  const recordedTaxes = totalTransactionsForGroup(reportTransactions, 'tax')
  const capitalGains = totalTransactionsForGroup(reportTransactions, 'capital_gain')
  const companyActualProfit = totalTransactionsForGroup(companyTransactions, 'income') - totalTransactionsForGroup(companyTransactions, 'expense')
  const companyTaxEstimate = scope === 'Personal' ? 0 : estimatedTax(companyActualProfit)
  const actualExcludingGains = actualIncome - actualExpenses - recordedTaxes - companyTaxEstimate
  const actualIncludingGains = actualExcludingGains + capitalGains

  const forecastIncome = totalBudgetsForGroup(reportBudgets, 'income')
  const forecastExpenses = totalBudgetsForGroup(reportBudgets, 'expense')
  const plannedTaxes = totalBudgetsForGroup(reportBudgets, 'tax')
  const companyForecastProfit = totalBudgetsForGroup(companyBudgets, 'income') - totalBudgetsForGroup(companyBudgets, 'expense')
  const forecastTax = scope === 'Personal' ? 0 : estimatedTax(companyForecastProfit)
  const forecastExcludingGains = forecastIncome - forecastExpenses - plannedTaxes - forecastTax

  const scopeOptions: ReportScope[] = ['Combined', 'Personal', 'Company']
  return <div className="page-content narrow-page report-page">
    <div className="report-toolbar">
      <div className="segmented report-segmented">{scopeOptions.map((option) => <button key={option} className={scope === option ? 'active transfer' : ''} onClick={() => setScope(option)}>{option}</button>)}</div>
      <div className="segmented"><button className={period === 'month' ? 'active transfer' : ''} onClick={() => setPeriod('month')}>Month</button><button className={period === 'year' ? 'active transfer' : ''} onClick={() => setPeriod('year')}>Year</button></div>
    </div>
    <section className="report-hero">
      <div><span className="eyebrow">{scope} performance · {period === 'month' ? monthName.format(viewedMonth) : yearKey}</span><h2>Economic result</h2><p>Income, expenses and estimated company tax across the accounts you selected.</p></div>
      <label className="tax-rate-field"><span>Company tax planning rate</span><div><input type="number" min="0" max="100" step="0.1" value={data.settings.estimatedCompanyTaxRateBps / 100} onChange={(event) => onUpdateTaxRate(Math.max(0, Math.round(Number(event.target.value) * 100)))} /><b>%</b></div><small>Planning estimate only</small></label>
    </section>
    <div className="report-comparison">
      <ReportColumn title="Forecast" subtitle="From monthly budgets" income={forecastIncome} expenses={forecastExpenses} tax={forecastTax} otherTax={plannedTaxes} otherTaxLabel="Other planned taxes" resultExcluding={forecastExcludingGains} capitalGains={0} resultIncluding={forecastExcludingGains} />
      <ReportColumn title="Actual" subtitle="From recorded activity" income={actualIncome} expenses={actualExpenses} tax={companyTaxEstimate} otherTax={recordedTaxes} otherTaxLabel="Other recorded taxes" resultExcluding={actualExcludingGains} capitalGains={capitalGains} resultIncluding={actualIncludingGains} />
    </div>
    <div className="report-footnote"><CircleHelp size={16} /><p>Company tax is estimated from tagged company income minus tagged company expenses. Transfers are excluded. Capital gains remain separate so you can compare performance with and without them.</p></div>
  </div>
}

function ReportColumn({ title, subtitle, income, expenses, tax, otherTax, otherTaxLabel, resultExcluding, capitalGains, resultIncluding }: { title: string; subtitle: string; income: number; expenses: number; tax: number; otherTax: number; otherTaxLabel: string; resultExcluding: number; capitalGains: number; resultIncluding: number }) {
  const row = (label: string, value: number, tone?: string) => <div className={`report-row ${tone ?? ''}`}><span>{label}</span><strong>{formatMoney(value)}</strong></div>
  return <section className="panel report-column"><div className="report-column-heading"><div><span className="eyebrow">{subtitle}</span><h3>{title}</h3></div></div>{row('Income', income, 'income-row')}{row('Expenses', -expenses)}{row('Calculated company tax', -tax)}{otherTax !== 0 && row(otherTaxLabel, -otherTax)}<div className="report-divider" />{row('Result excluding capital gains', resultExcluding, 'result-row')}{row('Capital gains / losses', capitalGains)}{row('Result including capital gains', resultIncluding, 'result-row final-result')}</section>
}

function AccountsPage({ accounts, totalBalance, onAdd, onSelectAccount }: { accounts: Account[]; totalBalance: number; onAdd: () => void; onSelectAccount: (id: string) => void }) {
  return <div className="page-content narrow-page"><div className="accounts-title"><div><span className="eyebrow">Provisional net worth</span><strong>{formatMoney(totalBalance)}</strong></div><button className="secondary-button" onClick={onAdd}><Plus size={17} />New account</button></div><div className="account-card-grid">{accounts.map(account => <button type="button" className="large-account-card" key={account.id} onClick={() => onSelectAccount(account.id)} aria-label={`View ${account.name} transactions`}><div className="large-account-top"><span style={{ background: account.color }}><Banknote size={20} /></span><small>{account.scope} · {account.type}</small></div><h3>{account.name}</h3><strong>{formatMoney(account.balanceMinor)}</strong><p>Provisional balance</p></button>)}</div></div>
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}><div className="modal"><div className="modal-heading"><div><span className="eyebrow">Next Expense</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>{children}</div></div>
}

function CategoryDetail({ category, spent, budget, transactions, categories, accounts, onUpdateBudget }: { category: Category; spent: number; budget: number; transactions: Transaction[]; categories: Category[]; accounts: Account[]; onUpdateBudget: (categoryId: string, amountMinor: number, scope: AccountScope) => void }) {
  const [budgetInput, setBudgetInput] = useState((budget / 100).toFixed(2))
  const [budgetScope, setBudgetScope] = useState<AccountScope>('Personal')
  const remaining = budget - spent
  const saveBudget = () => {
    const amountMinor = parseMoneyToMinor(budgetInput)
    if (amountMinor === null) return
    onUpdateBudget(category.id, amountMinor, budgetScope)
  }
  return <div className="category-detail">
    <div className="category-detail-summary">
      <div><span>Net spent</span><strong>{formatMoney(spent)}</strong></div>
      <div><span>Budget</span><strong>{formatMoney(budget)}</strong></div>
      <div><span>Remaining</span><strong className={remaining < 0 ? 'negative' : ''}>{formatMoney(remaining)}</strong></div>
    </div>
    <div className="budget-editor">
      <label><span>Monthly plan</span><input type="number" min="0" step="0.01" value={budgetInput} onChange={(event) => setBudgetInput(event.target.value)} /></label>
      <label><span>Account tag</span><select value={budgetScope} onChange={(event) => setBudgetScope(event.target.value as AccountScope)}><option>Personal</option><option>Company</option></select></label>
      <button className="secondary-button" type="button" onClick={saveBudget}>Update budget</button>
    </div>
    <div className="category-detail-heading"><span>{transactions.length} transaction{transactions.length === 1 ? '' : 's'} this month</span></div>
    <div className="category-detail-list">
      {transactions.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} categories={categories} accounts={accounts} />)}
      {!transactions.length && <div className="empty-state compact-empty"><ReceiptText size={24} /><h3>No transactions yet</h3></div>}
    </div>
  </div>
}

function AccountDetail({ account, transactions, categories, accounts }: { account: Account; transactions: Transaction[]; categories: Category[]; accounts: Account[] }) {
  const incoming = transactions.reduce((sum, transaction) => sum + (transaction.type === 'income' || transaction.toAccountId === account.id ? transaction.amountMinor : 0), 0)
  const outgoing = transactions.reduce((sum, transaction) => sum + (transaction.type === 'expense' || (transaction.type === 'transfer' && transaction.accountId === account.id) ? transaction.amountMinor : 0), 0)
  return <div className="category-detail account-detail">
    <div className="category-detail-summary">
      <div><span>Current balance</span><strong>{formatMoney(account.balanceMinor)}</strong></div>
      <div><span>Money in</span><strong className="positive">{formatMoney(incoming)}</strong></div>
      <div><span>Money out</span><strong>{formatMoney(outgoing)}</strong></div>
    </div>
    <div className="category-detail-heading"><span>{transactions.length} transaction{transactions.length === 1 ? '' : 's'} this month</span><b>{account.scope} · {account.type}</b></div>
    <div className="category-detail-list">
      {transactions.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} categories={categories} accounts={accounts} focusAccountId={account.id} />)}
      {!transactions.length && <div className="empty-state compact-empty"><ReceiptText size={24} /><h3>No transactions yet</h3></div>}
    </div>
  </div>
}

function TransactionForm({ accounts, categories, onSubmit }: { accounts: Account[]; categories: Category[]; onSubmit: (t: Omit<Transaction, 'id'>) => void }) {
  const [type, setType] = useState<Transaction['type']>('expense')
  const [amount, setAmount] = useState('')
  const [merchant, setMerchant] = useState('')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [toAccountId, setToAccountId] = useState(accounts[1]?.id ?? '')
  const relevant = categories.filter((category) => type === 'income'
    ? ['income', 'capital_gain', 'expense'].includes(category.reportGroup)
    : ['expense', 'tax', 'capital_gain'].includes(category.reportGroup))
  const [categoryId, setCategoryId] = useState(categories.find(c => c.reportGroup === 'expense')?.id ?? '')
  function changeType(next: Transaction['type']) {
    setType(next)
    if (next !== 'transfer') setCategoryId(categories.find(c => c.reportGroup === next)?.id ?? categories[0]?.id ?? '')
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    const amountMinor = parseMoneyToMinor(amount)
    if (!amountMinor || !accountId) return
    if (type === 'transfer') {
      if (!toAccountId || toAccountId === accountId) return
      onSubmit({ amountMinor, merchant: 'Transfer', note, date, accountId, toAccountId, type, currency: 'EUR' })
      return
    }
    if (!merchant || !categoryId) return
    onSubmit({ amountMinor, merchant, note, date, accountId, categoryId, type, currency: 'EUR' })
  }
  return <form onSubmit={submit} className="form">
    <div className="segmented three-way"><button type="button" className={type === 'expense' ? 'active' : ''} onClick={() => changeType('expense')}>Expense</button><button type="button" className={type === 'income' ? 'active income' : ''} onClick={() => changeType('income')}>Income</button><button type="button" className={type === 'transfer' ? 'active transfer' : ''} onClick={() => changeType('transfer')}>Transfer</button></div>
    <label className="amount-field"><span>Amount</span><div><b>€</b><input autoFocus required min="0.01" step="0.01" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div></label>
    {type !== 'transfer' && <div className="form-grid"><label><span>Merchant or source</span><input required value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Green Market" /></label><label><span>Date</span><input required type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label></div>}
    {type === 'transfer' && <label><span>Date</span><input required type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>}
    <div className="form-grid">
      <label><span>{type === 'transfer' ? 'From account' : 'Account'}</span><select value={accountId} onChange={(e) => {
        const nextAccountId = e.target.value
        setAccountId(nextAccountId)
        if (type === 'transfer' && nextAccountId === toAccountId) setToAccountId(accounts.find(a => a.id !== nextAccountId)?.id ?? '')
      }}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      {type === 'transfer'
        ? <label><span>To account</span><select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>{accounts.filter(a => a.id !== accountId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        : <label><span>Category</span><select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{relevant.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
    </div>
    <label><span>Note <i>Optional</i></span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a little context" /></label>
    <button className="primary-button form-submit" type="submit">Save transaction<ArrowRight size={18} /></button>
  </form>
}

function AccountForm({ onSubmit }: { onSubmit: (a: Omit<Account, 'id'>) => void }) {
  const [name, setName] = useState(''); const [type, setType] = useState<Account['type']>('Checking'); const [balance, setBalance] = useState(''); const [scope, setScope] = useState<AccountScope>('Personal')
  function submit(e: FormEvent) { e.preventDefault(); const balanceMinor = parseMoneyToMinor(balance || '0', true); if (!name || balanceMinor === null) return; onSubmit({ name, type, scope, balanceMinor, currency: 'EUR', color: type === 'Savings' ? '#d68853' : type === 'Cash' ? '#777a6d' : '#234e46' }) }
  return <form className="form" onSubmit={submit}><label><span>Account name</span><input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Everyday checking" /></label><div className="form-grid"><label><span>Account type</span><select value={type} onChange={e => setType(e.target.value as Account['type'])}><option>Checking</option><option>Savings</option><option>Cash</option></select></label><label><span>Account tag</span><select value={scope} onChange={e => setScope(e.target.value as AccountScope)}><option>Personal</option><option>Company</option></select></label></div><label><span>Current balance</span><input type="number" step="0.01" value={balance} onChange={e => setBalance(e.target.value)} placeholder="0.00" /></label><button className="primary-button form-submit">Create account<ArrowRight size={18} /></button></form>
}

function CategoryForm({ onSubmit }: { onSubmit: (c: Omit<Category, 'id'>, budgetMinor: number, scope: AccountScope) => void }) {
  const [name, setName] = useState(''); const [budget, setBudget] = useState(''); const [reportGroup, setReportGroup] = useState<ReportGroup>('expense'); const [scope, setScope] = useState<AccountScope>('Personal')
  function submit(e: FormEvent) { e.preventDefault(); const budgetMinor = parseMoneyToMinor(budget || '0'); if (!name || budgetMinor === null) return; onSubmit({ name, reportGroup, color: '#5d7d91', icon: reportGroup === 'income' ? 'briefcase' : 'sparkles' }, budgetMinor, scope) }
  return <form className="form" onSubmit={submit}><label><span>Category name</span><input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Personal care" /></label><div className="form-grid"><label><span>Report group</span><select value={reportGroup} onChange={e => setReportGroup(e.target.value as ReportGroup)}><option value="income">Income</option><option value="expense">Expense</option><option value="tax">Tax</option><option value="capital_gain">Capital gain/loss</option></select></label><label><span>Account tag</span><select value={scope} onChange={e => setScope(e.target.value as AccountScope)}><option>Personal</option><option>Company</option></select></label></div><label><span>Monthly plan</span><input type="number" min="0" step="0.01" value={budget} onChange={e => setBudget(e.target.value)} placeholder="0.00" /></label><button className="primary-button form-submit">Create category<ArrowRight size={18} /></button></form>
}

export default App
