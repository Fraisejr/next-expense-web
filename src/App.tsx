import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, BadgeEuro, Banknote, BriefcaseBusiness,
  CalendarDays, CarFront, ChevronDown, ChevronLeft, ChevronRight, CircleHelp,
  CreditCard, House, LayoutDashboard, Menu, Plus, ReceiptText, Search, Settings,
  ShoppingBasket, Sparkles, Target, Utensils, WalletCards, X,
} from 'lucide-react'
import { seedData } from './data'
import type { Account, AppData, Category, Transaction } from './types'

type Page = 'overview' | 'transactions' | 'budgets' | 'accounts'
type Modal = 'transaction' | 'account' | 'category' | null
const STORAGE_KEY = 'next-expense-data-v7'

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
  { id: 'accounts', label: 'Accounts', icon: WalletCards },
]

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function inMonth(date: string, viewed: Date) {
  const d = new Date(`${date}T12:00:00`)
  return d.getMonth() === viewed.getMonth() && d.getFullYear() === viewed.getFullYear()
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
  const categoryKind = (categoryId?: string) => data.categories.find((category) => category.id === categoryId)?.kind
  const refunds = transactions
    .filter((t) => t.type === 'income' && categoryKind(t.categoryId) === 'expense')
    .reduce((sum, t) => sum + t.amountMinor, 0)
  const income = transactions
    .filter((t) => t.type === 'income' && categoryKind(t.categoryId) !== 'expense')
    .reduce((sum, t) => sum + t.amountMinor, 0)
  const expenses = transactions.filter((t) => t.type === 'expense').reduce((sum, t) => sum + t.amountMinor, 0) - refunds
  const net = income - expenses
  const totalBalance = data.accounts.reduce((sum, account) => sum + account.balanceMinor, 0)
  const categorySpending = (id: string) => transactions
    .filter((t) => t.categoryId === id && t.type !== 'transfer')
    .reduce((sum, t) => sum + (t.type === 'expense' ? t.amountMinor : -t.amountMinor), 0)
  const expenseCategories = data.categories.filter((c) => c.kind === 'expense')
  const totalBudget = expenseCategories.reduce((sum, c) => sum + c.budgetMinor, 0)
  const pageTitle = navItems.find((item) => item.id === page)?.label ?? 'Overview'
  const selectedCategory = data.categories.find((category) => category.id === selectedCategoryId)

  function moveMonth(delta: number) {
    setViewedMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1))
  }

  function addAccount(account: Omit<Account, 'id'>) {
    setData((current) => ({ ...current, accounts: [...current.accounts, { ...account, id: uid() }] }))
    setModal(null)
  }

  function addCategory(category: Omit<Category, 'id'>) {
    setData((current) => ({ ...current, categories: [...current.categories, { ...category, id: uid() }] }))
    setModal(null)
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
            totalBudget={totalBudget} categorySpending={categorySpending}
            onAllTransactions={() => setPage('transactions')} onAddAccount={() => setModal('account')}
            onAddCategory={() => setModal('category')} onSelectCategory={setSelectedCategoryId}
          />
        )}
        {page === 'transactions' && (
          <TransactionsPage transactions={transactions} accounts={data.accounts} categories={data.categories} search={search} setSearch={setSearch} />
        )}
        {page === 'budgets' && (
          <BudgetsPage categories={expenseCategories} categorySpending={categorySpending} onAdd={() => setModal('category')} onSelectCategory={setSelectedCategoryId} />
        )}
        {page === 'accounts' && (
          <AccountsPage accounts={data.accounts} totalBalance={totalBalance} onAdd={() => setModal('account')} />
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
            transactions={transactions.filter((transaction) => transaction.categoryId === selectedCategory.id)}
            categories={data.categories}
            accounts={data.accounts}
          />
        </ModalShell>
      )}
    </div>
  )
}

function Overview({ accounts, categories, transactionCategories, transactions, income, expenses, net, totalBalance, totalBudget, categorySpending, onAllTransactions, onAddAccount, onAddCategory, onSelectCategory }: {
  accounts: Account[]; categories: Category[]; transactionCategories: Category[]; transactions: Transaction[]; income: number; expenses: number; net: number; totalBalance: number; totalBudget: number
  categorySpending: (id: string) => number; onAllTransactions: () => void; onAddAccount: () => void; onAddCategory: () => void; onSelectCategory: (id: string) => void
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
            {categories.map((category) => <CategoryRow key={category.id} category={category} spent={categorySpending(category.id)} onSelect={() => onSelectCategory(category.id)} />)}
          </div>
        </div>

        <div className="side-stack">
          <div className="panel accounts-panel">
            <div className="panel-heading compact"><h2>Accounts</h2><button className="icon-button" aria-label="Add account" onClick={onAddAccount}><Plus size={18} /></button></div>
            {accounts.map((account) => (
              <div className="account-row" key={account.id}>
                <span className="account-dot" style={{ background: account.color }}><CreditCard size={17} /></span>
                <div><strong>{account.name}</strong><span>{account.type}</span></div>
                <b>{formatMoney(account.balanceMinor)}</b>
              </div>
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

function CategoryRow({ category, spent, onSelect }: { category: Category; spent: number; onSelect: () => void }) {
  const Icon = categoryIcons[category.icon as keyof typeof categoryIcons] ?? Sparkles
  const percent = category.budgetMinor ? Math.round((spent / category.budgetMinor) * 100) : 0
  return (
    <button type="button" className="category-row" onClick={onSelect} aria-label={`View ${category.name} transactions`}>
      <span className="category-icon" style={{ color: category.color, background: `${category.color}18` }}><Icon size={18} /></span>
      <div className="category-progress">
        <div><strong>{category.name}</strong><span>{formatMoney(spent)} <i>of {formatMoney(category.budgetMinor)}</i></span></div>
        <div className="progress-track"><span style={{ width: `${Math.min(percent, 100)}%`, background: percent > 100 ? '#ae4c38' : category.color }} /></div>
      </div>
      <b className={percent > 100 ? 'negative' : ''}>{percent}%</b>
    </button>
  )
}

function TransactionRow({ transaction, categories, accounts, compact = false }: { transaction: Transaction; categories: Category[]; accounts: Account[]; compact?: boolean }) {
  const category = categories.find((item) => item.id === transaction.categoryId)
  const sourceAccount = accounts.find((item) => item.id === transaction.accountId)
  const destinationAccount = accounts.find((item) => item.id === transaction.toAccountId)
  const isTransfer = transaction.type === 'transfer'
  const Icon = isTransfer ? ArrowLeftRight : category ? (categoryIcons[category.icon as keyof typeof categoryIcons] ?? Sparkles) : ReceiptText
  return (
    <div className={compact ? 'transaction-row compact' : 'transaction-row'}>
      <span className="transaction-icon" style={{ color: isTransfer ? '#587486' : category?.color, background: isTransfer ? '#e5ecef' : `${category?.color ?? '#777'}18` }}><Icon size={18} /></span>
      <div>
        <strong>{isTransfer ? `Transfer to ${destinationAccount?.name ?? 'account'}` : transaction.merchant}</strong>
        <span>{isTransfer ? `${sourceAccount?.name ?? 'Account'} → ${destinationAccount?.name ?? 'Account'}` : category?.name ?? 'Uncategorised'} · {shortDate.format(new Date(`${transaction.date}T12:00:00`))}</span>
      </div>
      <b className={transaction.type === 'income' ? 'positive' : isTransfer ? 'transfer-amount' : ''}>{transaction.type === 'income' ? '+' : transaction.type === 'expense' ? '−' : ''}{formatMoney(transaction.amountMinor)}</b>
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

function BudgetsPage({ categories, categorySpending, onAdd, onSelectCategory }: { categories: Category[]; categorySpending: (id: string) => number; onAdd: () => void; onSelectCategory: (id: string) => void }) {
  return <div className="page-content narrow-page"><div className="panel full-panel"><div className="panel-heading"><div><span className="eyebrow">Monthly plan</span><h2>Category budgets</h2></div><button className="secondary-button" onClick={onAdd}><Plus size={17} />New category</button></div><div className="category-list roomy">{categories.map(c => <CategoryRow key={c.id} category={c} spent={categorySpending(c.id)} onSelect={() => onSelectCategory(c.id)} />)}</div></div></div>
}

function AccountsPage({ accounts, totalBalance, onAdd }: { accounts: Account[]; totalBalance: number; onAdd: () => void }) {
  return <div className="page-content narrow-page"><div className="accounts-title"><div><span className="eyebrow">Provisional net worth</span><strong>{formatMoney(totalBalance)}</strong></div><button className="secondary-button" onClick={onAdd}><Plus size={17} />New account</button></div><div className="account-card-grid">{accounts.map(account => <div className="large-account-card" key={account.id}><div className="large-account-top"><span style={{ background: account.color }}><Banknote size={20} /></span><small>{account.type}</small></div><h3>{account.name}</h3><strong>{formatMoney(account.balanceMinor)}</strong><p>Provisional balance</p></div>)}</div></div>
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}><div className="modal"><div className="modal-heading"><div><span className="eyebrow">Next Expense</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>{children}</div></div>
}

function CategoryDetail({ category, spent, transactions, categories, accounts }: { category: Category; spent: number; transactions: Transaction[]; categories: Category[]; accounts: Account[] }) {
  const remaining = category.budgetMinor - spent
  return <div className="category-detail">
    <div className="category-detail-summary">
      <div><span>Net spent</span><strong>{formatMoney(spent)}</strong></div>
      <div><span>Budget</span><strong>{formatMoney(category.budgetMinor)}</strong></div>
      <div><span>Remaining</span><strong className={remaining < 0 ? 'negative' : ''}>{formatMoney(remaining)}</strong></div>
    </div>
    <div className="category-detail-heading"><span>{transactions.length} transaction{transactions.length === 1 ? '' : 's'} this month</span></div>
    <div className="category-detail-list">
      {transactions.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} categories={categories} accounts={accounts} />)}
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
  const relevant = categories.filter((c) => c.kind === type)
  const [categoryId, setCategoryId] = useState(categories.find(c => c.kind === 'expense')?.id ?? '')
  function changeType(next: Transaction['type']) {
    setType(next)
    if (next !== 'transfer') setCategoryId(categories.find(c => c.kind === next)?.id ?? '')
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
  const [name, setName] = useState(''); const [type, setType] = useState<Account['type']>('Checking'); const [balance, setBalance] = useState('')
  function submit(e: FormEvent) { e.preventDefault(); const balanceMinor = parseMoneyToMinor(balance || '0', true); if (!name || balanceMinor === null) return; onSubmit({ name, type, balanceMinor, currency: 'EUR', color: type === 'Savings' ? '#d68853' : type === 'Cash' ? '#777a6d' : '#234e46' }) }
  return <form className="form" onSubmit={submit}><label><span>Account name</span><input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Everyday checking" /></label><div className="form-grid"><label><span>Account type</span><select value={type} onChange={e => setType(e.target.value as Account['type'])}><option>Checking</option><option>Savings</option><option>Cash</option></select></label><label><span>Current balance</span><input type="number" step="0.01" value={balance} onChange={e => setBalance(e.target.value)} placeholder="0.00" /></label></div><button className="primary-button form-submit">Create account<ArrowRight size={18} /></button></form>
}

function CategoryForm({ onSubmit }: { onSubmit: (c: Omit<Category, 'id'>) => void }) {
  const [name, setName] = useState(''); const [budget, setBudget] = useState(''); const [kind, setKind] = useState<Category['kind']>('expense')
  function submit(e: FormEvent) { e.preventDefault(); const budgetMinor = parseMoneyToMinor(budget || '0'); if (!name || budgetMinor === null) return; onSubmit({ name, budgetMinor, kind, color: '#5d7d91', icon: kind === 'income' ? 'briefcase' : 'sparkles' }) }
  return <form className="form" onSubmit={submit}><label><span>Category name</span><input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Personal care" /></label><div className="form-grid"><label><span>Type</span><select value={kind} onChange={e => setKind(e.target.value as Category['kind'])}><option value="expense">Expense</option><option value="income">Income</option></select></label><label><span>Monthly budget</span><input disabled={kind === 'income'} type="number" min="0" step="1" value={budget} onChange={e => setBudget(e.target.value)} placeholder="0" /></label></div><button className="primary-button form-submit">Create category<ArrowRight size={18} /></button></form>
}

export default App
