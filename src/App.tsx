import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, BadgeEuro, Banknote, BriefcaseBusiness,
  BarChart3, BriefcaseMedical, CalendarDays, CarFront, ChevronDown, ChevronLeft, ChevronRight, CircleHelp,
  ArrowDown, ArrowUp, Check, CreditCard, Dumbbell, Eye, EyeOff, GripVertical, HeartHandshake, House, LayoutDashboard, Link2, LoaderCircle, LogOut, Menu, Plane, Plus, ReceiptText, Search, Settings,
  RefreshCw, ShieldAlert, ShoppingBag, ShoppingBasket, Sparkles, Target, Tv, UsersRound, Utensils, WalletCards, Wine, X, Zap,
} from 'lucide-react'
import { matchPath, useLocation, useNavigate } from 'react-router-dom'
import { assignPayeeMapping, createAccount, createCategory, createTransaction, ensurePayees, linkBankAccount, loadWorkspace, saveAccountOrder, saveBankSync, saveBudget, updateCategoryHidden, updateTaxRate, WorkspaceNotLinkedError, type BankSyncPayload, type LoadedWorkspace } from './database'
import { neon } from './neon'
import type { Account, AccountScope, AppData, Category, Payee, ReportGroup, Transaction } from './types'

type Page = 'overview' | 'transactions' | 'payees' | 'budgets' | 'reports' | 'accounts'
type Modal = 'transaction' | 'account' | 'category' | 'bank' | null
const BANK_LINK_STORAGE_KEY = 'next-expense-gocardless-link'
const moneyFormatters = new Map<string, Intl.NumberFormat>()
const monthName = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' })
const shortDate = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' })

function formatMoney(amountMinor: number, currency = 'EUR') {
  let formatter = moneyFormatters.get(currency)
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-IE', { style: 'currency', currency })
    moneyFormatters.set(currency, formatter)
  }
  return formatter.format(amountMinor / 100)
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
  banknote: Banknote,
  wine: Wine,
  tv: Tv,
  shield: ShieldAlert,
  'shopping-bag': ShoppingBag,
  zap: Zap,
  target: Target,
  medical: BriefcaseMedical,
  'credit-card': CreditCard,
  plane: Plane,
  dumbbell: Dumbbell,
  heart: HeartHandshake,
}

const navItems: { id: Page; label: string; icon: typeof House; path: string }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, path: '/' },
  { id: 'transactions', label: 'Transactions', icon: ReceiptText, path: '/transactions' },
  { id: 'payees', label: 'Payees', icon: UsersRound, path: '/payees' },
  { id: 'budgets', label: 'Budgets', icon: Target, path: '/budgets' },
  { id: 'reports', label: 'Performance', icon: BarChart3, path: '/performance' },
]

function uid() {
  return crypto.randomUUID()
}

function inMonth(date: string, viewed: Date) {
  const d = new Date(`${date}T12:00:00`)
  return d.getMonth() === viewed.getMonth() && d.getFullYear() === viewed.getFullYear()
}

function toMonthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function fromMonthKey(value: string | null) {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null
  const [year, month] = value.split('-').map(Number)
  return new Date(year, month - 1, 1)
}

function todayInParis() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (!error || typeof error !== 'object') return fallback

  const details = error as Record<string, unknown>
  const parts = [details.message, details.details, details.hint, details.code]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
  return parts.length > 0 ? parts.join(' · ') : fallback
}

function App() {
  if (window.location.hostname === '127.0.0.1') return <LocalhostRedirect />
  return <AuthenticatedApp />
}

function LocalhostRedirect() {
  useEffect(() => {
    const localUrl = new URL(window.location.href)
    localUrl.hostname = 'localhost'
    window.location.replace(localUrl)
  }, [])
  return <FullPageStatus message="Opening the secure local address…" />
}

function AuthenticatedApp() {
  const session = neon.auth.useSession()

  if (session.isPending) return <FullPageStatus message="Checking your secure session…" />
  if (!session.data) return <AuthScreen />

  return <WorkspaceApp userName={session.data.user.name ?? session.data.user.email ?? 'Michael'} />
}

function WorkspaceApp({ userName }: { userName: string }) {
  const [workspace, setWorkspace] = useState<LoadedWorkspace | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setWorkspace(await loadWorkspace())
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Could not load your workspace.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  if (loading) return <FullPageStatus message="Loading your imported transactions…" />
  if (error instanceof WorkspaceNotLinkedError) {
    return <FullPageStatus message="Your sign-in is ready. The imported workspace still needs to be linked to this account." actionLabel="Try again" onAction={refresh} />
  }
  if (error || !workspace) {
    return <FullPageStatus message={error?.message ?? 'Could not load your workspace.'} actionLabel="Try again" onAction={refresh} />
  }

  return <ExpenseApp key={workspace.workspaceId} workspace={workspace} userName={userName} />
}

function ExpenseApp({ workspace, userName }: { workspace: LoadedWorkspace; userName: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [data, setData] = useState<AppData>(workspace.data)
  const [syncError, setSyncError] = useState('')
  const [modal, setModal] = useState<Modal>(null)
  const [search, setSearch] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const [personalAccountsOpen, setPersonalAccountsOpen] = useState(true)
  const [companyAccountsOpen, setCompanyAccountsOpen] = useState(true)
  const [closedAccountsOpen, setClosedAccountsOpen] = useState(false)
  const [bankTarget, setBankTarget] = useState<Account | null>(null)
  const [syncingAccountId, setSyncingAccountId] = useState('')
  const [syncNotice, setSyncNotice] = useState<{ accountId: string; message: string } | null>(null)

  const accountMatch = matchPath('/accounts/:accountId', location.pathname)
  const categoryMatch = matchPath('/categories/:categoryId', location.pathname)
  const payeeMatch = matchPath('/payees/:payeeId', location.pathname)
  const page: Page = accountMatch ? 'accounts'
    : categoryMatch ? 'budgets'
      : payeeMatch ? 'payees'
      : location.pathname === '/transactions' ? 'transactions'
        : location.pathname === '/payees' ? 'payees'
        : location.pathname === '/budgets' ? 'budgets'
          : location.pathname === '/performance' ? 'reports'
            : location.pathname === '/accounts' ? 'accounts'
              : 'overview'
  const requestedMonth = fromMonthKey(new URLSearchParams(location.search).get('month'))
  const viewedMonth = requestedMonth ?? new Date()

  useEffect(() => {
    if (requestedMonth) return
    const params = new URLSearchParams(location.search)
    params.set('month', toMonthKey(viewedMonth))
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true })
  }, [location.pathname, location.search, navigate, requestedMonth, viewedMonth])

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [location.pathname])

  useEffect(() => {
    if (new URLSearchParams(location.search).get('bank_link') !== 'complete') return
    try {
      const pending = JSON.parse(sessionStorage.getItem(BANK_LINK_STORAGE_KEY) ?? '{}') as { workspaceId?: string; accountId?: string }
      const account = data.accounts.find((item) => item.id === pending.accountId)
      if (pending.workspaceId === workspace.workspaceId && account) {
        setBankTarget(account)
        setModal('bank')
      }
    } catch {
      setSyncError('The pending bank connection could not be restored.')
    }
  }, [data.accounts, location.search, workspace.workspaceId])

  const transactions = useMemo(
    () => data.transactions
      .filter((t) => inMonth(t.date, viewedMonth))
      .sort((a, b) => b.date.localeCompare(a.date)),
    [data.transactions, viewedMonth],
  )
  const selectedMonthKey = toMonthKey(viewedMonth)
  const categoryGroup = (categoryId?: string) => data.categories.find((category) => category.id === categoryId)?.reportGroup
  const income = transactions
    .filter((t) => t.currency === workspace.defaultCurrency)
    .filter((t) => categoryGroup(t.categoryId) === 'income')
    .reduce((sum, t) => sum + (t.type === 'income' ? t.amountMinor : t.type === 'expense' ? -t.amountMinor : 0), 0)
  const expenses = transactions
    .filter((t) => t.currency === workspace.defaultCurrency)
    .filter((t) => categoryGroup(t.categoryId) === 'expense')
    .reduce((sum, t) => sum + (t.type === 'expense' ? t.amountMinor : t.type === 'income' ? -t.amountMinor : 0), 0)
  const taxesPaid = transactions
    .filter((t) => t.currency === workspace.defaultCurrency)
    .filter((t) => categoryGroup(t.categoryId) === 'tax')
    .reduce((sum, t) => sum + (t.type === 'expense' ? t.amountMinor : t.type === 'income' ? -t.amountMinor : 0), 0)
  const capitalGains = transactions
    .filter((t) => t.currency === workspace.defaultCurrency)
    .filter((t) => categoryGroup(t.categoryId) === 'capital_gain')
    .reduce((sum, t) => sum + (t.type === 'income' ? t.amountMinor : t.type === 'expense' ? -t.amountMinor : 0), 0)
  const net = income - expenses - taxesPaid + capitalGains
  const activeAccounts = data.accounts.filter((account) => !account.closed)
  const closedAccounts = data.accounts.filter((account) => account.closed)
  const totalBalance = activeAccounts.filter((account) => account.currency === workspace.defaultCurrency).reduce((sum, account) => sum + account.balanceMinor, 0)
  const categorySpending = (id: string) => {
    const group = categoryGroup(id)
    return transactions
      .filter((t) => t.categoryId === id && t.type !== 'transfer' && t.currency === workspace.defaultCurrency)
      .reduce((sum, t) => {
        const direction = t.type === 'income' ? 1 : -1
        return sum + (group === 'income' || group === 'capital_gain' ? direction : -direction) * t.amountMinor
      }, 0)
  }
  const expenseCategories = data.categories.filter((c) => c.reportGroup === 'expense' && !c.hidden)
  const budgetForCategory = (categoryId: string) => data.budgets
    .filter((budget) => budget.month === selectedMonthKey && budget.categoryId === categoryId)
    .reduce((sum, budget) => sum + budget.amountMinor, 0)
  const totalBudget = expenseCategories.reduce((sum, category) => sum + budgetForCategory(category.id), 0)
  const selectedCategory = data.categories.find((category) => category.id === categoryMatch?.params.categoryId)
  const selectedAccount = data.accounts.find((account) => account.id === accountMatch?.params.accountId)
  const selectedPayee = data.payees.find((payee) => payee.id === payeeMatch?.params.payeeId)
  const pageTitle = selectedAccount?.name ?? selectedCategory?.name ?? selectedPayee?.name ?? navItems.find((item) => item.id === page)?.label ?? (page === 'accounts' ? 'Accounts' : 'Overview')
  const personalAccounts = activeAccounts.filter((account) => account.scope === 'Personal')
  const companyAccounts = activeAccounts.filter((account) => account.scope === 'Company')

  function pathWithMonth(path: string, month = viewedMonth) {
    return `${path}?month=${toMonthKey(month)}`
  }

  function goTo(path: string) {
    navigate(pathWithMonth(path))
    setMobileNav(false)
  }

  function moveMonth(delta: number) {
    navigate(pathWithMonth(location.pathname, new Date(viewedMonth.getFullYear(), viewedMonth.getMonth() + delta, 1)))
  }

  function selectMonth(month: string) {
    const selected = fromMonthKey(month)
    if (selected) navigate(pathWithMonth(location.pathname, selected))
  }

  async function addAccount(account: Omit<Account, 'id'>) {
    const nextAccount = { ...account, id: uid() }
    try {
      setSyncError('')
      await createAccount(workspace.workspaceId, nextAccount, data.accounts.length)
      setData((current) => ({ ...current, accounts: [...current.accounts, nextAccount] }))
      setModal(null)
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Could not save the account.')
    }
  }

  async function reorderAccounts(accountIds: string[]) {
    const requestedIds = new Set(accountIds)
    const reordered = [
      ...accountIds.flatMap((id) => {
        const account = data.accounts.find((item) => item.id === id)
        return account ? [account] : []
      }),
      ...data.accounts.filter((account) => !requestedIds.has(account.id)),
    ]
    try {
      setSyncError('')
      await saveAccountOrder(workspace.workspaceId, reordered.map((account) => account.id))
      setData((current) => ({ ...current, accounts: reordered }))
      return true
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Could not save the account order.')
      return false
    }
  }

  async function addCategory(category: Omit<Category, 'id'>, budgetMinor: number, scope: AccountScope) {
    const categoryId = uid()
    const nextCategory = { ...category, id: categoryId }
    const nextBudget = budgetMinor ? { id: uid(), month: selectedMonthKey, categoryId, scope, amountMinor: budgetMinor } : null
    try {
      setSyncError('')
      await createCategory(workspace.workspaceId, nextCategory)
      if (nextBudget) await saveBudget(workspace.workspaceId, nextBudget)
      setData((current) => ({
        ...current,
        categories: [...current.categories, nextCategory],
        budgets: nextBudget ? [...current.budgets, nextBudget] : current.budgets,
      }))
      setModal(null)
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Could not save the category.')
    }
  }

  async function updateBudget(categoryId: string, amountMinor: number, scope: AccountScope) {
    const existing = data.budgets.find((budget) => budget.month === selectedMonthKey && budget.categoryId === categoryId && budget.scope === scope)
    const nextBudget = existing ? { ...existing, amountMinor } : { id: uid(), month: selectedMonthKey, categoryId, scope, amountMinor }
    try {
      setSyncError('')
      await saveBudget(workspace.workspaceId, nextBudget)
      setData((current) => ({
        ...current,
        budgets: existing
          ? current.budgets.map((budget) => budget.id === existing.id ? nextBudget : budget)
          : [...current.budgets, nextBudget],
      }))
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Could not update the budget.')
    }
  }

  async function setCategoryHidden(categoryId: string, hidden: boolean) {
    try {
      setSyncError('')
      await updateCategoryHidden(workspace.workspaceId, categoryId, hidden)
      setData((current) => ({
        ...current,
        categories: current.categories.map((category) => category.id === categoryId ? { ...category, hidden } : category),
      }))
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : `Could not ${hidden ? 'hide' : 'unhide'} the category.`)
    }
  }

  async function addTransaction(transaction: Omit<Transaction, 'id'>) {
    try {
      setSyncError('')
      const resolvedPayees = transaction.type === 'transfer' ? [] : await ensurePayees(workspace.workspaceId, [transaction.payee])
      const resolvedPayee = resolvedPayees[0]
      const nextTransaction = { ...transaction, id: uid(), payeeId: resolvedPayee?.id }
      await createTransaction(workspace.workspaceId, nextTransaction)
    setData((current) => ({
      ...current,
      transactions: [...current.transactions, nextTransaction],
      payees: resolvedPayee && !current.payees.some((payee) => payee.id === resolvedPayee.id) ? [...current.payees, resolvedPayee] : current.payees,
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
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Could not save the transaction.')
    }
  }

  async function mapUnmatchedPayee(sourceName: string, payeeId: string) {
    try {
      setSyncError('')
      const transactionIds = new Set(await assignPayeeMapping(workspace.workspaceId, sourceName, payeeId))
      const payee = data.payees.find((item) => item.id === payeeId)
      setData((current) => ({
        ...current,
        transactions: current.transactions.map((transaction) => transactionIds.has(transaction.id)
          ? { ...transaction, payeeId, payee: payee?.name ?? transaction.payee }
          : transaction),
      }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not map the transaction description.'))
      throw error
    }
  }

  async function createPayeeFromUnmatched(sourceName: string, payeeName: string) {
    try {
      setSyncError('')
      const [payee] = await ensurePayees(workspace.workspaceId, [payeeName])
      const transactionIds = new Set(await assignPayeeMapping(workspace.workspaceId, sourceName, payee.id))
      setData((current) => ({
        ...current,
        payees: current.payees.some((item) => item.id === payee.id) ? current.payees : [...current.payees, payee],
        transactions: current.transactions.map((transaction) => transactionIds.has(transaction.id)
          ? { ...transaction, payeeId: payee.id, payee: payee.name }
          : transaction),
      }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not create and map the payee.'))
      throw error
    }
  }

  async function changeTaxRate(estimatedCompanyTaxRateBps: number) {
    setData((current) => ({ ...current, settings: { ...current.settings, estimatedCompanyTaxRateBps } }))
    try {
      setSyncError('')
      await updateTaxRate(workspace.workspaceId, estimatedCompanyTaxRateBps)
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Could not update the tax rate.')
    }
  }

  async function syncBank(account: Account) {
    if (!account.providerAccountId) return
    setSyncError('')
    setSyncNotice(null)
    setSyncingAccountId(account.id)
    try {
      const lastSync = account.lastSyncedAt ? new Date(account.lastSyncedAt) : null
      if (lastSync) lastSync.setUTCDate(lastSync.getUTCDate() - 14)
      const payload = await apiJson<BankSyncPayload>('/api/gocardless/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerAccountId: account.providerAccountId,
          dateFrom: lastSync?.toISOString().slice(0, 10),
        }),
      })
      const result = await saveBankSync(workspace.workspaceId, account, payload)
      const refreshed = await loadWorkspace()
      setData(refreshed.data)
      const remaining = [
        result.rateLimits.transactions?.remaining === undefined ? null : `${result.rateLimits.transactions.remaining} transaction requests left`,
        result.rateLimits.balances?.remaining === undefined ? null : `${result.rateLimits.balances.remaining} balance requests left`,
      ].filter(Boolean).join(' · ')
      const recentSyncs = `${result.syncRunsLast24Hours} sync${result.syncRunsLast24Hours === 1 ? '' : 's'} in the past 24 hours`
      setSyncNotice({
        accountId: account.id,
        message: `${formatSyncDiagnostic(result.diagnostic)}${result.balanceUpdated ? ' · Bank balance updated' : ''} · ${remaining || recentSyncs}${result.warnings.length ? ` · ${result.warnings.join(' · ')}` : ''}`,
      })
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not sync this bank account.'))
    } finally {
      setSyncingAccountId('')
    }
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
          {navItems.map(({ id, label, icon: Icon, path }) => (
            <button key={id} className={page === id ? 'nav-item active' : 'nav-item'} onClick={() => goTo(path)}>
              <Icon size={19} /><span>{label}</span>
            </button>
          ))}
        </nav>

        <nav className="sidebar-accounts" aria-label="Accounts">
          <button className={page === 'accounts' && !selectedAccount ? 'account-section-title active' : 'account-section-title'} onClick={() => goTo('/accounts')}>
            <span><WalletCards size={16} />Accounts</span><b>{formatMoney(totalBalance)}</b>
          </button>
          <SidebarAccountGroup label="Personal" accounts={personalAccounts} open={personalAccountsOpen} onToggle={() => setPersonalAccountsOpen((current) => !current)} selectedAccountId={selectedAccount?.id} onSelect={(id) => goTo(`/accounts/${id}`)} />
          {companyAccounts.length > 0 && <SidebarAccountGroup label="Company" accounts={companyAccounts} open={companyAccountsOpen} onToggle={() => setCompanyAccountsOpen((current) => !current)} selectedAccountId={selectedAccount?.id} onSelect={(id) => goTo(`/accounts/${id}`)} />}
          {closedAccounts.length > 0 && <SidebarAccountGroup label="Closed accounts" accounts={closedAccounts} open={closedAccountsOpen} onToggle={() => setClosedAccountsOpen((current) => !current)} selectedAccountId={selectedAccount?.id} onSelect={(id) => goTo(`/accounts/${id}`)} />}
          <button className="sidebar-add-account" onClick={() => setModal('account')}><Plus size={13} />Add account</button>
        </nav>

        <div className="sidebar-bottom">
          <button className="nav-item"><CircleHelp size={19} /><span>Help & feedback</span></button>
          <button className="nav-item"><Settings size={19} /><span>Settings</span></button>
          <div className="profile">
            <div className="avatar">{userName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</div>
            <div><strong>{userName}</strong><span>{workspace.workspaceName}</span></div>
            <button className="profile-sign-out" aria-label="Sign out" title="Sign out" onClick={() => void neon.auth.signOut()}><LogOut size={16} /></button>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div className="topbar-title">
            <button className="icon-button mobile-menu" aria-label="Open menu" onClick={() => setMobileNav(!mobileNav)}><Menu size={21} /></button>
            <div><span className="eyebrow">{selectedAccount ? 'Accounts' : selectedCategory ? 'Categories' : selectedPayee ? 'Payees' : page === 'payees' ? 'Directory' : 'Personal budget'}</span><h1>{pageTitle}</h1></div>
          </div>
          <div className="top-actions">
            {page !== 'payees' && <div className="month-switcher">
              <button aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft size={17} /></button>
              <label><CalendarDays size={16} /><input aria-label="Select month" type="month" value={selectedMonthKey} onInput={(event) => selectMonth((event.target as HTMLInputElement).value)} /></label>
              <button aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight size={17} /></button>
            </div>}
            <button className="primary-button" onClick={() => setModal('transaction')}><Plus size={18} />Add transaction</button>
          </div>
        </header>

        {syncError && <div className="sync-error" role="alert">{syncError}</div>}

        {page === 'overview' && (
          <Overview
            accounts={activeAccounts} categories={expenseCategories} transactionCategories={data.categories} transactions={transactions}
            income={income} expenses={expenses} net={net} totalBalance={totalBalance}
            totalBudget={totalBudget} categorySpending={categorySpending} budgetForCategory={budgetForCategory}
            onAllTransactions={() => goTo('/transactions')} onAddAccount={() => setModal('account')}
            onAddCategory={() => setModal('category')} onSelectCategory={(id) => goTo(`/categories/${id}`)} onSelectAccount={(id) => goTo(`/accounts/${id}`)}
          />
        )}
        {page === 'transactions' && (
          <TransactionsPage transactions={transactions} accounts={data.accounts} categories={data.categories} search={search} setSearch={setSearch} />
        )}
        {page === 'payees' && !selectedPayee && (
          <PayeesPage payees={data.payees} transactions={data.transactions} onSelectPayee={(id) => goTo(`/payees/${id}`)} onMapPayee={mapUnmatchedPayee} onCreatePayee={createPayeeFromUnmatched} />
        )}
        {page === 'budgets' && !selectedCategory && (
          <BudgetsPage categories={data.categories} categorySpending={categorySpending} budgetForCategory={budgetForCategory} onAdd={() => setModal('category')} onSelectCategory={(id) => goTo(`/categories/${id}`)} />
        )}
        {page === 'reports' && (
          <ReportsPage data={data} viewedMonth={viewedMonth} defaultCurrency={workspace.defaultCurrency} onUpdateTaxRate={changeTaxRate} />
        )}
        {page === 'accounts' && !selectedAccount && (
          <AccountsPage accounts={activeAccounts} totalBalance={totalBalance} onAdd={() => setModal('account')} onSelectAccount={(id) => goTo(`/accounts/${id}`)} onReorder={reorderAccounts} />
        )}
        {selectedAccount && (
          <AccountDetailPage account={selectedAccount} transactions={transactions.filter((transaction) => transaction.accountId === selectedAccount.id || transaction.toAccountId === selectedAccount.id)} categories={data.categories} accounts={data.accounts} onBack={() => goTo('/accounts')} onSelectAccount={(id) => goTo(`/accounts/${id}`)} onLinkBank={() => { setBankTarget(selectedAccount); setModal('bank') }} onSyncBank={() => syncBank(selectedAccount)} syncing={syncingAccountId === selectedAccount.id} syncNotice={syncNotice?.accountId === selectedAccount.id ? syncNotice.message : ''} />
        )}
        {selectedCategory && (
          <CategoryDetailPage category={selectedCategory} spent={categorySpending(selectedCategory.id)} budget={budgetForCategory(selectedCategory.id)} transactions={transactions.filter((transaction) => transaction.categoryId === selectedCategory.id)} categories={data.categories} accounts={data.accounts} onUpdateBudget={updateBudget} onSetHidden={setCategoryHidden} onBack={() => goTo('/budgets')} onSelectCategory={(id) => goTo(`/categories/${id}`)} />
        )}
        {selectedPayee && (
          <PayeeDetailPage payee={selectedPayee} transactions={data.transactions.filter((transaction) => transaction.payeeId === selectedPayee.id)} categories={data.categories} accounts={data.accounts} onBack={() => goTo('/payees')} />
        )}
      </main>

      {modal && (
        <ModalShell title={modal === 'transaction' ? 'Add transaction' : modal === 'account' ? 'Create account' : modal === 'category' ? 'Create category' : `Connect ${bankTarget?.name ?? 'account'}`} onClose={() => setModal(null)}>
          {modal === 'transaction' && <TransactionForm accounts={activeAccounts} categories={data.categories.filter((category) => !category.hidden)} payees={data.payees} onSubmit={addTransaction} />}
          {modal === 'account' && <AccountForm onSubmit={addAccount} />}
          {modal === 'category' && <CategoryForm onSubmit={addCategory} />}
          {modal === 'bank' && bankTarget && <BankLinkForm account={bankTarget} workspaceId={workspace.workspaceId} onComplete={() => window.location.reload()} />}
        </ModalShell>
      )}
    </div>
  )
}

function FullPageStatus({ message, actionLabel, onAction }: { message: string; actionLabel?: string; onAction?: () => void }) {
  return <main className="auth-page"><section className="auth-card status-card">
    <div className="brand auth-brand"><div className="brand-mark"><ArrowRight size={19} strokeWidth={2.4} /></div><span>Next Expense</span></div>
    {!actionLabel && <LoaderCircle className="status-spinner" size={28} />}
    <p>{message}</p>
    {actionLabel && <button className="primary-button" onClick={onAction}>{actionLabel}</button>}
  </section></main>
}

function AuthScreen() {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [name, setName] = useState('Michael')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function emailAuth(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setError('')
    try {
      const result = mode === 'sign-up'
        ? await neon.auth.signUp.email({ email, password, name })
        : await neon.auth.signIn.email({ email, password })
      if (result.error) throw result.error
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-in failed. Please try again.')
    } finally {
      setPending(false)
    }
  }

  async function googleAuth() {
    setPending(true)
    setError('')
    try {
      const result = await neon.auth.signIn.social({ provider: 'google', callbackURL: window.location.origin })
      if (result?.error) throw result.error
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Google sign-in failed. Please try again.')
      setPending(false)
    }
  }

  return <main className="auth-page">
    <section className="auth-card">
      <div className="brand auth-brand"><div className="brand-mark"><ArrowRight size={19} strokeWidth={2.4} /></div><span>Next Expense</span></div>
      <span className="eyebrow">Your private workspace</span>
      <h1>{mode === 'sign-in' ? 'Welcome back' : 'Create your sign-in'}</h1>
      <p className="auth-intro">Your imported transactions are stored in your dedicated Neon database and protected by your account.</p>
      <button className="google-button" type="button" disabled={pending} onClick={() => void googleAuth()}><span>G</span>Continue with Google</button>
      <div className="auth-divider"><span>or use email</span></div>
      <form className="form auth-form" onSubmit={emailAuth}>
        {mode === 'sign-up' && <label><span>Name</span><input required value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>}
        <label><span>Email</span><input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
        <label><span>Password</span><input required minLength={8} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} /></label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="primary-button form-submit" disabled={pending}>{pending ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}<ArrowRight size={18} /></button>
      </form>
      <button className="auth-mode" onClick={() => { setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in'); setError('') }}>{mode === 'sign-in' ? 'First time here? Create an account' : 'Already have an account? Sign in'}</button>
    </section>
  </main>
}

function SidebarAccountGroup({ label, accounts, open, onToggle, selectedAccountId, onSelect }: { label: string; accounts: Account[]; open: boolean; onToggle: () => void; selectedAccountId?: string; onSelect: (id: string) => void }) {
  const subtotal = accounts.reduce((sum, account) => sum + account.balanceMinor, 0)
  const currencies = [...new Set(accounts.map((account) => account.currency))]
  return <div className="sidebar-account-group">
    <button className="sidebar-account-group-title" onClick={onToggle} aria-expanded={open}>
      <span><ChevronDown size={12} className={open ? '' : 'collapsed'} />{label}</span><b>{currencies.length === 1 ? formatMoney(subtotal, currencies[0]) : `${accounts.length} accounts`}</b>
    </button>
    {open && <div className="sidebar-account-list">{accounts.map((account) => <button key={account.id} className={selectedAccountId === account.id ? 'sidebar-account active' : 'sidebar-account'} onClick={() => onSelect(account.id)}><span><i style={{ background: account.color }} />{account.name}</span><b className={account.balanceMinor < 0 ? 'negative' : ''}>{formatMoney(account.balanceMinor, account.currency)}</b></button>)}</div>}
  </div>
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
          <div className="balance-meta"><span>Across {accounts.filter((account) => account.currency === 'EUR').length} EUR accounts</span><span>Other currencies shown separately</span></div>
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
                <b>{formatMoney(account.balanceMinor, account.currency)}</b>
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
    <button type="button" className={category.hidden ? 'category-row hidden' : 'category-row'} onClick={onSelect} aria-label={`View ${category.name} transactions`}>
      <span className="category-icon" style={{ color: category.color, background: `${category.color}18` }}><Icon size={18} /></span>
      <div className="category-progress">
        <div><strong>{category.name}</strong><span>{formatMoney(spent)} <i>of {formatMoney(budget)}</i></span></div>
        <div className="progress-track"><span style={{ width: `${Math.min(percent, 100)}%`, background: percent > 100 ? '#ae4c38' : category.color }} /></div>
      </div>
      <b className={percent > 100 ? 'negative' : ''}>{category.hidden ? 'Hidden' : `${percent}%`}</b>
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
        <strong>{isTransfer ? `Transfer to ${destinationAccount?.name ?? 'account'}` : transaction.payee}{transaction.posted === false && <em className="pending-badge">Pending</em>}</strong>
        <span>{isTransfer ? `${sourceAccount?.name ?? 'Account'} → ${destinationAccount?.name ?? 'Account'}` : category?.name ?? 'Uncategorised'} · {shortDate.format(new Date(`${transaction.date}T12:00:00`))}</span>
      </div>
      <b className={transaction.type === 'income' || transferIsIncoming ? 'positive' : isTransfer && !focusAccountId ? 'transfer-amount' : ''}>{prefix}{formatMoney(transaction.amountMinor, transaction.currency)}</b>
    </div>
  )
}

function TransactionsPage({ transactions, accounts, categories, search, setSearch }: { transactions: Transaction[]; accounts: Account[]; categories: Category[]; search: string; setSearch: (value: string) => void }) {
  const filtered = transactions.filter((t) => `${t.payee} ${t.note ?? ''} ${categories.find(c => c.id === t.categoryId)?.name ?? ''}`.toLowerCase().includes(search.toLowerCase()))
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

type PayeeSort = 'transactions' | 'alphabetical'

function PayeesPage({ payees, transactions, onSelectPayee, onMapPayee, onCreatePayee }: {
  payees: Payee[]
  transactions: Transaction[]
  onSelectPayee: (id: string) => void
  onMapPayee: (sourceName: string, payeeId: string) => Promise<void>
  onCreatePayee: (sourceName: string, payeeName: string) => Promise<void>
}) {
  const [sort, setSort] = useState<PayeeSort>('transactions')
  const [search, setSearch] = useState('')
  const [mappingTargets, setMappingTargets] = useState<Record<string, string>>({})
  const [payeeQueries, setPayeeQueries] = useState<Record<string, string>>({})
  const [newPayeeNames, setNewPayeeNames] = useState<Record<string, string>>({})
  const [mappingErrors, setMappingErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState('')
  const unmatchedByName = new Map<string, { sourceName: string; count: number; lastTransaction: string }>()
  for (const transaction of transactions) {
    if (transaction.payeeId || transaction.type === 'transfer') continue
    const sourceName = (transaction.payeeRaw ?? transaction.payee).normalize('NFKC').trim()
    if (!sourceName) continue
    const key = sourceName.toLocaleLowerCase('en')
    const current = unmatchedByName.get(key)
    unmatchedByName.set(key, {
      sourceName: current?.sourceName ?? sourceName,
      count: (current?.count ?? 0) + 1,
      lastTransaction: !current || transaction.date > current.lastTransaction ? transaction.date : current.lastTransaction,
    })
  }
  const unmatched = [...unmatchedByName.entries()].sort((left, right) => right[1].count - left[1].count || left[1].sourceName.localeCompare(right[1].sourceName))
  const alphabeticalPayees = [...payees].sort((left, right) => left.name.localeCompare(right.name))
  const rows = payees.map((payee) => {
    const payeeTransactions = transactions.filter((transaction) => transaction.payeeId === payee.id)
    return {
      payee,
      count: payeeTransactions.length,
      lastTransaction: payeeTransactions.reduce((latest, transaction) => transaction.date > latest ? transaction.date : latest, ''),
    }
  }).filter((row) => row.payee.name.toLocaleLowerCase('en').includes(search.trim().toLocaleLowerCase('en')))
    .sort((left, right) => sort === 'alphabetical'
      ? left.payee.name.localeCompare(right.payee.name)
      : right.count - left.count || left.payee.name.localeCompare(right.payee.name))

  return <div className="page-content narrow-page">
    <div className="panel full-panel">
      <div className="panel-heading payee-heading">
        <div><span className="eyebrow">Directory</span><h2>{payees.length} payee{payees.length === 1 ? '' : 's'}</h2></div>
        <div className="payee-controls">
          <label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search payees" /></label>
          <label className="sort-box"><span>Sort by</span><select value={sort} onChange={(event) => setSort(event.target.value as PayeeSort)}><option value="transactions">Most transactions</option><option value="alphabetical">Alphabetical</option></select></label>
        </div>
      </div>
      {unmatched.length > 0 && <section className="unmatched-payees">
        <div className="unmatched-heading"><div><span className="eyebrow">Needs review</span><h3>{unmatched.length} unmatched description{unmatched.length === 1 ? '' : 's'}</h3></div><p>Map each description to a payee. The choice is remembered for future imports.</p></div>
        <div className="unmatched-list">{unmatched.map(([key, item]) => {
          const targetId = mappingTargets[key] ?? ''
          const payeeQuery = payeeQueries[key] ?? ''
          const matchingPayees = payeeQuery.trim() ? alphabeticalPayees.filter((payee) => payee.name.toLocaleLowerCase('en').includes(payeeQuery.trim().toLocaleLowerCase('en'))).slice(0, 8) : []
          const selectedPayee = alphabeticalPayees.find((payee) => payee.id === targetId)
          const hasSelectedQuery = selectedPayee?.name.localeCompare(payeeQuery, undefined, { sensitivity: 'accent' }) === 0
          const newName = newPayeeNames[key] ?? item.sourceName
          const isPending = pending === key
          const mappingError = mappingErrors[key] ?? ''
          return <div className="unmatched-row" key={key}>
            <div className="unmatched-source"><strong>{item.sourceName}</strong><span>{item.count} transaction{item.count === 1 ? '' : 's'} · latest {shortDate.format(new Date(`${item.lastTransaction}T12:00:00`))}</span></div>
            <div className="unmatched-action"><div className="payee-picker"><Search size={15} /><input aria-label={`Search existing payees for ${item.sourceName}`} placeholder="Search existing payees" value={payeeQuery} autoComplete="off" onChange={(event) => {
              const query = event.target.value
              const exactMatch = alphabeticalPayees.find((payee) => payee.name.localeCompare(query, undefined, { sensitivity: 'accent' }) === 0)
              setPayeeQueries((current) => ({ ...current, [key]: query }))
              setMappingTargets((current) => ({ ...current, [key]: exactMatch?.id ?? '' }))
            }} />
              {payeeQuery.trim() && !hasSelectedQuery && <div className="payee-suggestions" role="listbox">
                {matchingPayees.map((payee) => <button type="button" role="option" aria-selected="false" key={payee.id} onClick={() => {
                  setPayeeQueries((current) => ({ ...current, [key]: payee.name }))
                  setMappingTargets((current) => ({ ...current, [key]: payee.id }))
                }}>{payee.name}</button>)}
                {!matchingPayees.length && <span>No matching payees</span>}
              </div>}
            </div><button className="secondary-button" disabled={!targetId || isPending} onClick={async () => {
              setPending(key)
              setMappingErrors((current) => ({ ...current, [key]: '' }))
              try {
                await onMapPayee(item.sourceName, targetId)
              } catch (error) {
                setMappingErrors((current) => ({ ...current, [key]: getErrorMessage(error, 'Mapping failed. Please try again.') }))
              } finally {
                setPending('')
              }
            }}>Map</button></div>
            <span className="unmatched-or">or</span>
            <div className="unmatched-action"><input aria-label={`New payee name for ${item.sourceName}`} value={newName} onChange={(event) => setNewPayeeNames((current) => ({ ...current, [key]: event.target.value }))} /><button className="secondary-button" disabled={!newName.trim() || isPending} onClick={async () => {
              setPending(key)
              setMappingErrors((current) => ({ ...current, [key]: '' }))
              try {
                await onCreatePayee(item.sourceName, newName.trim())
              } catch (error) {
                setMappingErrors((current) => ({ ...current, [key]: getErrorMessage(error, 'Could not create and map this payee.') }))
              } finally {
                setPending('')
              }
            }}>{isPending ? 'Saving…' : 'Create new'}</button></div>
            {mappingError && <p className="unmatched-error" role="alert">{mappingError}</p>}
          </div>
        })}</div>
      </section>}
      <div className="payee-table-header"><span>Payee</span><span>Last transaction</span><span>Transactions</span></div>
      <div className="payee-list">
        {rows.map(({ payee, count, lastTransaction }) => <button type="button" className="payee-row" key={payee.id} onClick={() => onSelectPayee(payee.id)}>
          <span className="payee-avatar">{payee.name.slice(0, 1).toLocaleUpperCase('en')}</span>
          <span className="payee-name"><strong>{payee.name}</strong><small>{count ? 'View transaction history' : 'No linked transactions yet'}</small></span>
          <span className="payee-last">{lastTransaction ? shortDate.format(new Date(`${lastTransaction}T12:00:00`)) : '—'}</span>
          <span className="payee-count">{count}</span>
          <ChevronRight size={17} />
        </button>)}
        {!rows.length && <div className="empty-state"><UsersRound size={28} /><h3>No payees found</h3><p>{search ? 'Try a different search.' : 'Payees will appear when transactions are added.'}</p></div>}
      </div>
    </div>
  </div>
}

function PayeeDetailPage({ payee, transactions, categories, accounts, onBack }: { payee: Payee; transactions: Transaction[]; categories: Category[]; accounts: Account[]; onBack: () => void }) {
  const sortedTransactions = [...transactions].sort((left, right) => right.date.localeCompare(left.date))
  const expenseCount = transactions.filter((transaction) => transaction.type === 'expense').length
  const incomeCount = transactions.filter((transaction) => transaction.type === 'income').length
  return <div className="page-content narrow-page">
    <div className="entity-page-toolbar"><button className="entity-back" onClick={onBack}><ChevronLeft size={16} />All payees</button></div>
    <div className="panel entity-detail-panel">
      <div className="entity-heading payee-detail-heading">
        <span className="entity-heading-icon payee-detail-icon">{payee.name.slice(0, 1).toLocaleUpperCase('en')}</span>
        <div><span className="eyebrow">Payee</span><h2>{payee.name}</h2></div>
      </div>
      <div className="payee-summary">
        <div><span>All transactions</span><strong>{transactions.length}</strong></div>
        <div><span>Expenses</span><strong>{expenseCount}</strong></div>
        <div><span>Income</span><strong>{incomeCount}</strong></div>
      </div>
      <div className="table-header"><span>Description</span><span>Account</span><span>Amount</span></div>
      <div className="transaction-list-full">
        {sortedTransactions.map((transaction) => <div className="transaction-table-row" key={transaction.id}>
          <TransactionRow transaction={transaction} categories={categories} accounts={accounts} />
          <span className="account-name">{accounts.find((account) => account.id === transaction.accountId)?.name}</span>
        </div>)}
        {!sortedTransactions.length && <div className="empty-state"><ReceiptText size={28} /><h3>No linked transactions</h3><p>This payee is in the register but has no transaction history.</p></div>}
      </div>
    </div>
  </div>
}

function BudgetsPage({ categories, categorySpending, budgetForCategory, onAdd, onSelectCategory }: { categories: Category[]; categorySpending: (id: string) => number; budgetForCategory: (id: string) => number; onAdd: () => void; onSelectCategory: (id: string) => void }) {
  const [showHidden, setShowHidden] = useState(false)
  const visibleCategories = categories.filter((category) => !category.hidden)
  const hiddenCategories = categories.filter((category) => category.hidden)
  const incomeCategories = visibleCategories.filter((category) => category.reportGroup === 'income')
  const expenseCategories = visibleCategories.filter((category) => category.reportGroup === 'expense')
  const taxCategories = visibleCategories.filter((category) => category.reportGroup === 'tax')
  const section = (title: string, subtitle: string, rows: Category[]) => <section className="budget-section"><div className="budget-section-heading"><div><h3>{title}</h3><span>{subtitle}</span></div></div><div className="category-list roomy">{rows.map((category) => <CategoryRow key={category.id} category={category} spent={categorySpending(category.id)} budget={budgetForCategory(category.id)} onSelect={() => onSelectCategory(category.id)} />)}</div></section>
  return <div className="page-content narrow-page"><div className="panel full-panel"><div className="panel-heading"><div><span className="eyebrow">Monthly plan</span><h2>Income, expense & tax plan</h2></div><div className="budget-page-actions">{hiddenCategories.length > 0 && <button className="text-button" onClick={() => setShowHidden((current) => !current)}>{showHidden ? <EyeOff size={16} /> : <Eye size={16} />}{showHidden ? 'Hide archived' : `Show hidden (${hiddenCategories.length})`}</button>}<button className="secondary-button" onClick={onAdd}><Plus size={17} />New category</button></div></div>{section('Planned income', 'Actual income compared with this month’s plan', incomeCategories)}{section('Expense budgets', 'Net spending compared with this month’s budget', expenseCategories)}{taxCategories.length > 0 && section('Tax plan', 'Recorded tax costs compared with this month’s plan', taxCategories)}{showHidden && hiddenCategories.length > 0 && section('Hidden categories', 'Kept for transaction history, but excluded from active planning and new transactions', hiddenCategories)}</div></div>
}

type ReportScope = 'Combined' | AccountScope
type ReportPeriod = 'month' | 'year'

function ReportsPage({ data, viewedMonth, defaultCurrency, onUpdateTaxRate }: { data: AppData; viewedMonth: Date; defaultCurrency: string; onUpdateTaxRate: (rateBps: number) => void }) {
  const [scope, setScope] = useState<ReportScope>('Combined')
  const [period, setPeriod] = useState<ReportPeriod>('month')
  const monthKey = toMonthKey(viewedMonth)
  const yearKey = String(viewedMonth.getFullYear())
  const accountById = new Map(data.accounts.map((account) => [account.id, account]))
  const categoryById = new Map(data.categories.map((category) => [category.id, category]))
  const inPeriod = (date: string) => period === 'month' ? date.startsWith(monthKey) : date.startsWith(yearKey)
  const scopeMatches = (accountScope?: AccountScope) => scope === 'Combined' || accountScope === scope
  const reportTransactions = data.transactions.filter((transaction) => transaction.currency === defaultCurrency && inPeriod(transaction.date) && transaction.type !== 'transfer' && scopeMatches(accountById.get(transaction.accountId)?.scope))
  const companyTransactions = data.transactions.filter((transaction) => transaction.currency === defaultCurrency && inPeriod(transaction.date) && transaction.type !== 'transfer' && accountById.get(transaction.accountId)?.scope === 'Company')
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
    <div className="report-footnote"><CircleHelp size={16} /><p>Company tax is estimated from tagged company income minus tagged company expenses. Transfers are excluded. Reports currently use {defaultCurrency}; original currencies and historical exchange rates remain preserved for converted reporting.</p></div>
  </div>
}

function ReportColumn({ title, subtitle, income, expenses, tax, otherTax, otherTaxLabel, resultExcluding, capitalGains, resultIncluding }: { title: string; subtitle: string; income: number; expenses: number; tax: number; otherTax: number; otherTaxLabel: string; resultExcluding: number; capitalGains: number; resultIncluding: number }) {
  const row = (label: string, value: number, tone?: string) => <div className={`report-row ${tone ?? ''}`}><span>{label}</span><strong>{formatMoney(value)}</strong></div>
  return <section className="panel report-column"><div className="report-column-heading"><div><span className="eyebrow">{subtitle}</span><h3>{title}</h3></div></div>{row('Income', income, 'income-row')}{row('Expenses', -expenses)}{row('Calculated company tax', -tax)}{otherTax !== 0 && row(otherTaxLabel, -otherTax)}<div className="report-divider" />{row('Result excluding capital gains', resultExcluding, 'result-row')}{row('Capital gains / losses', capitalGains)}{row('Result including capital gains', resultIncluding, 'result-row final-result')}</section>
}

function AccountsPage({ accounts, totalBalance, onAdd, onSelectAccount, onReorder }: { accounts: Account[]; totalBalance: number; onAdd: () => void; onSelectAccount: (id: string) => void; onReorder: (accountIds: string[]) => Promise<boolean> }) {
  const [reordering, setReordering] = useState(false)
  const [orderedIds, setOrderedIds] = useState(() => accounts.map((account) => account.id))
  const [draggedId, setDraggedId] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!reordering) setOrderedIds(accounts.map((account) => account.id))
  }, [accounts, reordering])

  const orderedAccounts = orderedIds.flatMap((id) => {
    const account = accounts.find((item) => item.id === id)
    return account ? [account] : []
  })

  function moveAccount(accountId: string, offset: number) {
    setOrderedIds((current) => {
      const from = current.indexOf(accountId)
      const to = from + offset
      if (from < 0 || to < 0 || to >= current.length) return current
      const next = [...current]
      next.splice(from, 1)
      next.splice(to, 0, accountId)
      return next
    })
  }

  function dropAccount(targetId: string) {
    if (!draggedId || draggedId === targetId) return
    setOrderedIds((current) => {
      const from = current.indexOf(draggedId)
      const to = current.indexOf(targetId)
      if (from < 0 || to < 0) return current
      const next = [...current]
      next.splice(from, 1)
      next.splice(to, 0, draggedId)
      return next
    })
    setDraggedId('')
  }

  function cancelReordering() {
    setOrderedIds(accounts.map((account) => account.id))
    setDraggedId('')
    setReordering(false)
  }

  async function saveOrder() {
    setSaving(true)
    const saved = await onReorder(orderedIds)
    setSaving(false)
    if (saved) setReordering(false)
  }

  return <div className="page-content narrow-page">
    <div className="accounts-title">
      <div><span className="eyebrow">Provisional EUR net worth</span><strong>{formatMoney(totalBalance)}</strong></div>
      <div className="accounts-title-actions">
        {reordering ? <>
          <button className="secondary-button" onClick={cancelReordering} disabled={saving}>Cancel</button>
          <button className="primary-button" onClick={() => void saveOrder()} disabled={saving}><Check size={17} />{saving ? 'Saving…' : 'Save order'}</button>
        </> : <>
          {accounts.length > 1 && <button className="secondary-button" onClick={() => setReordering(true)}><GripVertical size={17} />Reorder</button>}
          <button className="secondary-button" onClick={onAdd}><Plus size={17} />New account</button>
        </>}
      </div>
    </div>
    {reordering && <p className="reorder-help">Drag accounts into place, or use the arrow buttons. This order is also used in the sidebar.</p>}
    <div className={reordering ? 'account-card-grid reordering' : 'account-card-grid'}>
      {orderedAccounts.map((account, index) => reordering ? (
        <div
          className={draggedId === account.id ? 'large-account-card reorder-account-card dragging' : 'large-account-card reorder-account-card'}
          key={account.id}
          draggable
          onDragStart={() => setDraggedId(account.id)}
          onDragEnd={() => setDraggedId('')}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => dropAccount(account.id)}
        >
          <div className="large-account-top"><span style={{ background: account.color }}><Banknote size={20} /></span><GripVertical className="reorder-card-handle" size={20} aria-hidden="true" /></div>
          <h3>{account.name}</h3><strong>{formatMoney(account.balanceMinor, account.currency)}</strong><p>{account.scope} · {account.type} · {account.currency}</p>
          <div className="reorder-card-actions">
            <button className="icon-button" onClick={() => moveAccount(account.id, -1)} disabled={index === 0} aria-label={`Move ${account.name} earlier`}><ArrowUp size={16} /></button>
            <button className="icon-button" onClick={() => moveAccount(account.id, 1)} disabled={index === orderedAccounts.length - 1} aria-label={`Move ${account.name} later`}><ArrowDown size={16} /></button>
          </div>
        </div>
      ) : (
        <button type="button" className="large-account-card" key={account.id} onClick={() => onSelectAccount(account.id)} aria-label={`View ${account.name} transactions`}><div className="large-account-top"><span style={{ background: account.color }}><Banknote size={20} /></span><small>{account.scope} · {account.type}</small></div><h3>{account.name}</h3><strong>{formatMoney(account.balanceMinor, account.currency)}</strong><p>Provisional balance · {account.currency}</p></button>
      ))}
    </div>
  </div>
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}><div className="modal"><div className="modal-heading"><div><span className="eyebrow">Next Expense</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>{children}</div></div>
}

function AccountDetailPage({ account, transactions, categories, accounts, onBack, onSelectAccount, onLinkBank, onSyncBank, syncing, syncNotice }: { account: Account; transactions: Transaction[]; categories: Category[]; accounts: Account[]; onBack: () => void; onSelectAccount: (id: string) => void; onLinkBank: () => void; onSyncBank: () => void; syncing: boolean; syncNotice: string }) {
  return <div className="page-content narrow-page entity-page">
    <div className="entity-page-toolbar">
      <button className="entity-back" onClick={onBack}><ChevronLeft size={16} />All accounts</button>
      <label><span>Account</span><select value={account.id} onChange={(event) => onSelectAccount(event.target.value)}>{accounts.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
    </div>
    <section className="panel entity-detail-panel">
      <div className="entity-heading"><div className="entity-heading-icon" style={{ background: account.color }}><CreditCard size={20} /></div><div><span className="eyebrow">{account.scope} · {account.type}{account.providerAccountId ? ' · Bank connected' : ''}</span><h2>{account.name}</h2></div><div className="entity-heading-actions">{account.providerAccountId && <button className="primary-button" disabled={syncing} onClick={onSyncBank}>{syncing ? <LoaderCircle className="spin-icon" size={16} /> : <RefreshCw size={16} />}{syncing ? 'Syncing…' : 'Sync now'}</button>}<button className="secondary-button" onClick={onLinkBank}><Link2 size={16} />{account.providerAccountId ? 'Reconnect' : 'Connect bank'}</button></div></div>
      {account.providerAccountId && <div className="bank-sync-status"><div><strong>{account.connectionStatus === 'active' ? 'Bank connection active' : 'Bank connected'}</strong><span>{account.lastSyncedAt ? `Last synced ${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(account.lastSyncedAt))}` : 'Not synced yet'}</span>{account.lastSyncDiagnostic && !syncNotice && <span>{formatSyncDiagnostic(account.lastSyncDiagnostic)}</span>}</div><span>{syncNotice || formatRateLimits(account)}</span></div>}
      <AccountDetail account={account} transactions={transactions} categories={categories} accounts={accounts} />
    </section>
  </div>
}

function formatRateLimits(account: Account) {
  const parts = [
    account.rateLimits?.transactions?.remaining === undefined ? null : `${account.rateLimits.transactions.remaining} transaction requests left`,
    account.rateLimits?.balances?.remaining === undefined ? null : `${account.rateLimits.balances.remaining} balance requests left`,
  ].filter(Boolean)
  if (parts.length) return parts.join(' · ')
  const count = account.syncRunsLast24Hours ?? 0
  return `${count} sync${count === 1 ? '' : 's'} in the past 24 hours`
}

function formatSyncDiagnostic(diagnostic: NonNullable<Account['lastSyncDiagnostic']>) {
  const returned = `${diagnostic.bookedReturned} booked + ${diagnostic.pendingReturned} pending returned`
  const results = [
    diagnostic.bookedImported ? `${diagnostic.bookedImported} booked added` : null,
    diagnostic.pendingImported ? `${diagnostic.pendingImported} pending added` : null,
    diagnostic.imported === 0 ? '0 added' : null,
    diagnostic.pendingPromoted ? `${diagnostic.pendingPromoted} pending → booked` : null,
    diagnostic.duplicates ? `${diagnostic.duplicates} duplicate${diagnostic.duplicates === 1 ? '' : 's'}` : null,
    diagnostic.cutoffIgnored ? `${diagnostic.cutoffIgnored} before migration cutoff` : null,
    diagnostic.futureIgnored ? `${diagnostic.futureIgnored} future-dated` : null,
    diagnostic.malformedIgnored ? `${diagnostic.malformedIgnored} malformed` : null,
    diagnostic.transactionError ? `Transactions error: ${diagnostic.transactionError}` : null,
    diagnostic.balanceError ? `Balance error: ${diagnostic.balanceError}` : null,
  ].filter(Boolean)
  return `${returned} · ${results.join(' · ')}`
}

function CategoryDetailPage({ category, spent, budget, transactions, categories, accounts, onUpdateBudget, onSetHidden, onBack, onSelectCategory }: { category: Category; spent: number; budget: number; transactions: Transaction[]; categories: Category[]; accounts: Account[]; onUpdateBudget: (categoryId: string, amountMinor: number, scope: AccountScope) => void; onSetHidden: (categoryId: string, hidden: boolean) => void; onBack: () => void; onSelectCategory: (id: string) => void }) {
  const Icon = categoryIcons[category.icon as keyof typeof categoryIcons] ?? Sparkles
  return <div className="page-content narrow-page entity-page">
    <div className="entity-page-toolbar">
      <button className="entity-back" onClick={onBack}><ChevronLeft size={16} />All categories</button>
      <label><span>Category</span><select value={category.id} onChange={(event) => onSelectCategory(event.target.value)}>{categories.map((option) => <option key={option.id} value={option.id}>{option.name}{option.hidden ? ' (hidden)' : ''}</option>)}</select></label>
    </div>
    <section className="panel entity-detail-panel">
      <div className="entity-heading"><div className="entity-heading-icon" style={{ color: category.color, background: `${category.color}18` }}><Icon size={20} /></div><div><span className="eyebrow">{category.reportGroup.replace('_', ' ')}{category.hidden ? ' · Hidden' : ''}</span><h2>{category.name}</h2></div><button className="secondary-button entity-heading-action" type="button" onClick={() => onSetHidden(category.id, !category.hidden)}>{category.hidden ? <Eye size={16} /> : <EyeOff size={16} />}{category.hidden ? 'Unhide category' : 'Hide category'}</button></div>
      <CategoryDetail key={`${category.id}-${budget}`} category={category} spent={spent} budget={budget} transactions={transactions} categories={categories} accounts={accounts} onUpdateBudget={onUpdateBudget} />
    </section>
  </div>
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
  const hasBankBalance = account.bankBalanceMinor !== undefined && Boolean(account.bankBalanceCurrency)
  const comparableBankBalance = hasBankBalance && account.bankBalanceCurrency === account.currency
  const balanceDifference = comparableBankBalance ? account.bankBalanceMinor! - account.balanceMinor : undefined
  return <div className="category-detail account-detail">
    <div className={hasBankBalance ? 'category-detail-summary account-balance-summary' : 'category-detail-summary'}>
      <div><span>Calculated balance</span><strong>{formatMoney(account.balanceMinor, account.currency)}</strong></div>
      {hasBankBalance && <div><span title={account.bankBalanceUpdatedAt ? `Reported ${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(account.bankBalanceUpdatedAt))}` : undefined}>Bank balance</span><strong>{formatMoney(account.bankBalanceMinor!, account.bankBalanceCurrency)}</strong></div>}
      {hasBankBalance && <div><span>Difference</span><strong className={balanceDifference === undefined || balanceDifference === 0 ? '' : balanceDifference > 0 ? 'positive' : 'negative'}>{balanceDifference === undefined ? 'Different currency' : formatMoney(balanceDifference, account.currency)}</strong></div>}
      <div><span>Money in</span><strong className="positive">{formatMoney(incoming, account.currency)}</strong></div>
      <div><span>Money out</span><strong>{formatMoney(outgoing, account.currency)}</strong></div>
    </div>
    <div className="category-detail-heading"><span>{transactions.length} transaction{transactions.length === 1 ? '' : 's'} this month</span><b>{account.scope} · {account.type}</b></div>
    <div className="category-detail-list">
      {transactions.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} categories={categories} accounts={accounts} focusAccountId={account.id} />)}
      {!transactions.length && <div className="empty-state compact-empty"><ReceiptText size={24} /><h3>No transactions yet</h3></div>}
    </div>
  </div>
}

type GoCardlessInstitution = { id: string; name: string; logo?: string; countries?: string[] }
type GoCardlessAccount = { id: string; name: string; iban: string; currency: string }
type PendingBankLink = { workspaceId: string; accountId: string; requisitionId: string; institutionId: string; country: string }

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(payload.error ?? 'The bank connection request failed.')
  return payload as T
}

function BankLinkForm({ account, workspaceId, onComplete }: { account: Account; workspaceId: string; onComplete: () => void }) {
  const [country, setCountry] = useState(account.country || 'ES')
  const [institutions, setInstitutions] = useState<GoCardlessInstitution[]>([])
  const [institutionId, setInstitutionId] = useState(account.institutionId || '')
  const [providerAccounts, setProviderAccounts] = useState<GoCardlessAccount[]>([])
  const [providerAccountId, setProviderAccountId] = useState('')
  const [pendingLink, setPendingLink] = useState<PendingBankLink | null>(() => {
    if (new URLSearchParams(window.location.search).get('bank_link') !== 'complete') return null
    try {
      const pending = JSON.parse(sessionStorage.getItem(BANK_LINK_STORAGE_KEY) ?? 'null') as PendingBankLink | null
      return pending?.accountId === account.id && pending.workspaceId === workspaceId ? pending : null
    } catch {
      return null
    }
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    if (pendingLink) {
      apiJson<{ accounts: GoCardlessAccount[]; status: string }>(`/api/gocardless/requisition?id=${encodeURIComponent(pendingLink.requisitionId)}`)
        .then((result) => {
          if (cancelled) return
          setProviderAccounts(result.accounts)
          setProviderAccountId(result.accounts[0]?.id ?? '')
          if (!result.accounts.length) setError(`The bank has not returned an account yet (status ${result.status}). You can close this window and try again.`)
        })
        .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not retrieve bank accounts.') })
        .finally(() => { if (!cancelled) setLoading(false) })
      return () => { cancelled = true }
    }

    apiJson<GoCardlessInstitution[]>(`/api/gocardless/institutions?country=${encodeURIComponent(country)}`)
      .then((items) => {
        if (cancelled) return
        const sorted = [...items].sort((left, right) => left.name.localeCompare(right.name))
        setInstitutions(sorted)
        setInstitutionId((current) => sorted.some((item) => item.id === current) ? current : '')
      })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not load banks.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [country, pendingLink])

  async function beginLink(event: FormEvent) {
    event.preventDefault()
    if (!institutionId) return
    setSaving(true)
    setError('')
    try {
      const redirect = new URL(`/accounts/${account.id}`, window.location.origin)
      redirect.searchParams.set('month', toMonthKey(new Date()))
      redirect.searchParams.set('bank_link', 'complete')
      const result = await apiJson<{ id: string; link: string }>('/api/gocardless/requisitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ institutionId, redirect: redirect.toString() }),
      })
      const pending: PendingBankLink = { workspaceId, accountId: account.id, requisitionId: result.id, institutionId, country }
      sessionStorage.setItem(BANK_LINK_STORAGE_KEY, JSON.stringify(pending))
      window.location.assign(result.link)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not begin bank authorization.')
      setSaving(false)
    }
  }

  async function finishLink(event: FormEvent) {
    event.preventDefault()
    if (!pendingLink || !providerAccountId) return
    setSaving(true)
    setError('')
    try {
      await linkBankAccount(workspaceId, account.id, { ...pendingLink, providerAccountId })
      sessionStorage.removeItem(BANK_LINK_STORAGE_KEY)
      const cleanUrl = new URL(window.location.href)
      cleanUrl.searchParams.delete('bank_link')
      window.history.replaceState({}, '', cleanUrl)
      onComplete()
    } catch (caught) {
      setError(getErrorMessage(caught, 'Could not save the bank connection.'))
      setSaving(false)
    }
  }

  if (pendingLink) return <form className="form bank-link-form" onSubmit={finishLink}>
    <p className="bank-link-intro">Choose which account returned by the bank belongs to <strong>{account.name}</strong>.</p>
    {loading ? <div className="bank-link-loading"><LoaderCircle size={19} />Retrieving accounts from the bank…</div> : providerAccounts.length > 0 && <label><span>Bank account</span><select value={providerAccountId} onChange={(event) => setProviderAccountId(event.target.value)}>{providerAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}{item.iban ? ` · ${item.iban.slice(-4)}` : ''}{item.currency ? ` · ${item.currency}` : ''}</option>)}</select></label>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    <button className="primary-button form-submit" disabled={loading || saving || !providerAccountId}>{saving ? 'Saving connection…' : 'Use this bank account'}<ArrowRight size={18} /></button>
  </form>

  return <form className="form bank-link-form" onSubmit={beginLink}>
    <p className="bank-link-intro">You’ll continue to GoCardless and your bank to authorize read-only access to balances and transactions.</p>
    <div className="form-grid"><label><span>Country</span><select value={country} onChange={(event) => setCountry(event.target.value)}><option value="ES">Spain</option><option value="FR">France</option><option value="SE">Sweden</option><option value="LT">Lithuania</option><option value="DE">Germany</option><option value="GB">United Kingdom</option></select></label><label><span>Bank</span><select required value={institutionId} disabled={loading} onChange={(event) => setInstitutionId(event.target.value)}><option value="">{loading ? 'Loading banks…' : 'Choose a bank'}</option>{institutions.map((institution) => <option key={institution.id} value={institution.id}>{institution.name}</option>)}</select></label></div>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <button className="primary-button form-submit" disabled={loading || saving || !institutionId}>{saving ? 'Opening bank…' : 'Continue to bank'}<ArrowRight size={18} /></button>
    <small className="bank-link-note">Next Expense never sees or stores your bank login. GoCardless consent normally lasts up to 90 days.</small>
  </form>
}

function TransactionForm({ accounts, categories, payees, onSubmit }: { accounts: Account[]; categories: Category[]; payees: Payee[]; onSubmit: (t: Omit<Transaction, 'id'>) => void }) {
  const [type, setType] = useState<Transaction['type']>('expense')
  const [amount, setAmount] = useState('')
  const [payee, setPayee] = useState('')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(todayInParis)
  const latestDate = todayInParis()
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
      onSubmit({ amountMinor, payee: 'Transfer', note, date, accountId, toAccountId, type, currency: accounts.find((account) => account.id === accountId)?.currency ?? 'EUR' })
      return
    }
    if (!payee.trim() || !categoryId) return
    onSubmit({ amountMinor, payee: payee.trim(), note, date, accountId, categoryId, type, currency: accounts.find((account) => account.id === accountId)?.currency ?? 'EUR' })
  }
  return <form onSubmit={submit} className="form">
    <div className="segmented three-way"><button type="button" className={type === 'expense' ? 'active' : ''} onClick={() => changeType('expense')}>Expense</button><button type="button" className={type === 'income' ? 'active income' : ''} onClick={() => changeType('income')}>Income</button><button type="button" className={type === 'transfer' ? 'active transfer' : ''} onClick={() => changeType('transfer')}>Transfer</button></div>
    <label className="amount-field"><span>Amount</span><div><b>{accounts.find((account) => account.id === accountId)?.currency ?? 'EUR'}</b><input autoFocus required min="0.01" step="0.01" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div></label>
    {type !== 'transfer' && <div className="form-grid"><label><span>Payee</span><input required list="payee-options" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="e.g. Green Market" /><datalist id="payee-options">{payees.map((item) => <option key={item.id} value={item.name} />)}</datalist></label><label><span>Date</span><input required type="date" max={latestDate} value={date} onChange={(e) => setDate(e.target.value)} /></label></div>}
    {type === 'transfer' && <label><span>Date</span><input required type="date" max={latestDate} value={date} onChange={(e) => setDate(e.target.value)} /></label>}
    <div className="form-grid">
      <label><span>{type === 'transfer' ? 'From account' : 'Account'}</span><select value={accountId} onChange={(e) => {
        const nextAccountId = e.target.value
        setAccountId(nextAccountId)
        if (type === 'transfer' && (nextAccountId === toAccountId || accounts.find(a => a.id === nextAccountId)?.currency !== accounts.find(a => a.id === toAccountId)?.currency)) setToAccountId(accounts.find(a => a.id !== nextAccountId && a.currency === accounts.find(source => source.id === nextAccountId)?.currency)?.id ?? '')
      }}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      {type === 'transfer'
        ? <label><span>To account</span><select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>{accounts.filter(a => a.id !== accountId && a.currency === accounts.find(source => source.id === accountId)?.currency).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        : <label><span>Category</span><select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{relevant.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
    </div>
    <label><span>Note <i>Optional</i></span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a little context" /></label>
    <button className="primary-button form-submit" type="submit">Save transaction<ArrowRight size={18} /></button>
  </form>
}

function AccountForm({ onSubmit }: { onSubmit: (a: Omit<Account, 'id'>) => void }) {
  const [name, setName] = useState(''); const [type, setType] = useState<Account['type']>('Checking'); const [balance, setBalance] = useState(''); const [scope, setScope] = useState<AccountScope>('Personal'); const [currency, setCurrency] = useState('EUR')
  function submit(e: FormEvent) { e.preventDefault(); const balanceMinor = parseMoneyToMinor(balance || '0', true); if (!name || balanceMinor === null) return; onSubmit({ name, type, scope, balanceMinor, currency, color: type === 'Savings' ? '#d68853' : type === 'Cash' ? '#777a6d' : '#234e46', closed: false }) }
  return <form className="form" onSubmit={submit}><label><span>Account name</span><input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Everyday checking" /></label><div className="form-grid"><label><span>Account type</span><select value={type} onChange={e => setType(e.target.value as Account['type'])}><option>Checking</option><option>Savings</option><option>Cash</option></select></label><label><span>Account tag</span><select value={scope} onChange={e => setScope(e.target.value as AccountScope)}><option>Personal</option><option>Company</option></select></label></div><div className="form-grid"><label><span>Current balance</span><input type="number" step="0.01" value={balance} onChange={e => setBalance(e.target.value)} placeholder="0.00" /></label><label><span>Currency</span><select value={currency} onChange={e => setCurrency(e.target.value)}><option>EUR</option><option>SEK</option><option>USD</option><option>GBP</option></select></label></div><button className="primary-button form-submit">Create account<ArrowRight size={18} /></button></form>
}

function CategoryForm({ onSubmit }: { onSubmit: (c: Omit<Category, 'id'>, budgetMinor: number, scope: AccountScope) => void }) {
  const [name, setName] = useState(''); const [budget, setBudget] = useState(''); const [reportGroup, setReportGroup] = useState<ReportGroup>('expense'); const [scope, setScope] = useState<AccountScope>('Personal')
  function submit(e: FormEvent) { e.preventDefault(); const budgetMinor = parseMoneyToMinor(budget || '0'); if (!name || budgetMinor === null) return; onSubmit({ name, reportGroup, color: '#5d7d91', icon: reportGroup === 'income' ? 'briefcase' : 'sparkles', hidden: false }, budgetMinor, scope) }
  return <form className="form" onSubmit={submit}><label><span>Category name</span><input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Personal care" /></label><div className="form-grid"><label><span>Report group</span><select value={reportGroup} onChange={e => setReportGroup(e.target.value as ReportGroup)}><option value="income">Income</option><option value="expense">Expense</option><option value="tax">Tax</option><option value="capital_gain">Capital gain/loss</option></select></label><label><span>Account tag</span><select value={scope} onChange={e => setScope(e.target.value as AccountScope)}><option>Personal</option><option>Company</option></select></label></div><label><span>Monthly plan</span><input type="number" min="0" step="0.01" value={budget} onChange={e => setBudget(e.target.value)} placeholder="0.00" /></label><button className="primary-button form-submit">Create category<ArrowRight size={18} /></button></form>
}

export default App
