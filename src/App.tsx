import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowLeftRight, ArrowRight, Banknote, BriefcaseBusiness,
  BarChart3, BriefcaseMedical, CalendarDays, CarFront, ChevronDown, ChevronLeft, ChevronRight, CircleHelp,
  ArrowDown, ArrowUp, Check, CircleAlert, CircleCheck, CreditCard, Download, Dumbbell, Eye, EyeOff, FileCheck2, GripVertical, HeartHandshake, House, LayoutDashboard, Link2, LoaderCircle, LogOut, Menu, Pencil, Plane, Plus, ReceiptText, Search, Settings, Trash2, Upload,
  RefreshCw, ShieldAlert, ShoppingBag, ShoppingBasket, Sparkles, Target, Tv, UsersRound, Utensils, WalletCards, Wine, X, Zap,
} from 'lucide-react'
import { matchPath, useLocation, useNavigate } from 'react-router-dom'
import { approveBankImportCandidate, approveBankImportCandidateAsTransfer, assignPayeeMapping, clearTransactionCache, createAccount, createBalanceAdjustment, createCategory, createCategoryGroup, createPayee, createPayeeMapping, createTransaction, deleteAllUnusedPayees, deleteCategoryGroup, deleteFxRate, deletePayeeMapping, deleteUnusedCategory, deleteUnusedPayee, ensurePayees, exportWorkspaceBackup, isWorkspaceBackup, linkBankAccount, loadCachedAllTransactions, loadTransactionPage, loadWorkspace, normalizedPayeeName, prefixMappingMatches, rejectBankImportCandidate, rematchPendingBankImportPayees, restoreWorkspaceBackup, saveAccountOrder, saveBankSync, saveBudget, saveCategoryGroupOrder, saveCategoryOrder, saveFxRate, saveYearlyFinancialPlans, updateAccountDetails, updateBalanceAdjustment, updateBankImportCandidatePayee, updateBankImportMode, updateCategoryDetails, updateCategoryGroupAssignment, updateCategoryGroupName, updateCategoryHidden, updateOpeningBalance, updatePayeeDefaultCategory, updatePayeeDefaults, updatePayeeMapping, updatePayeeName, updateTaxRate, updateTransactionCategories, updateTransactionDetails, updateTransferDetails, WorkspaceNotLinkedError, type BankSyncPayload, type LoadedWorkspace, type WorkspaceBackup } from './database'
import { neon } from './neon'
import { convertMinor } from './currency'
import type { Account, AccountScope, AppData, BalanceAdjustmentReason, BalanceSheetGroup, BankImportCandidate, Category, CategoryGroup, FxRate, Payee, PayeeMapping, ReportGroup, SpendingGoalScope, Transaction, YearlyFinancialPlan } from './types'

type Page = 'overview' | 'transactions' | 'payees' | 'reports' | 'accounts' | 'settings'
type ReportView = 'profit-loss' | 'net-worth'
type Modal = 'transaction' | 'account' | 'edit-account' | 'balance-adjustment' | 'category' | 'edit-category' | 'category-groups' | 'bank' | null
const BANK_LINK_STORAGE_KEY = 'next-expense-gocardless-link'
const moneyFormatters = new Map<string, Intl.NumberFormat>()
const monthName = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' })
const shortDate = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' })
const shortDateWithYear = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' })

function formatShortDate(value: string) {
  const date = new Date(`${value}T12:00:00`)
  return (date.getFullYear() === new Date().getFullYear() ? shortDate : shortDateWithYear).format(date)
}

function formatMoney(amountMinor: number, currency = 'EUR') {
  let formatter = moneyFormatters.get(currency)
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-IE', { style: 'currency', currency })
    moneyFormatters.set(currency, formatter)
  }
  return formatter.format(amountMinor / 100)
}

function formatWholeMoney(amountMinor: number, currency = 'EUR') {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(amountMinor / 100)
}

function roundToWholeEuroMinor(amountMinor: number) {
  return Math.round(amountMinor / 100) * 100
}

function formatCompactMoney(amountMinor: number, currency = 'EUR') {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1,
  }).format(amountMinor / 100)
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

function parsePercentageToBps(value: string) {
  const normalized = value.trim().replace(',', '.')
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return null
  const rateBps = Math.round(Number(normalized) * 100)
  return Number.isSafeInteger(rateBps) && rateBps >= 0 && rateBps <= 10_000 ? rateBps : null
}

function parseOptionalMoneyToMinor(value: string) {
  return value.trim() === '' ? 0 : parseMoneyToMinor(value)
}

function parseOptionalPercentageToBps(value: string) {
  return value.trim() === '' ? 0 : parsePercentageToBps(value)
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
  { id: 'accounts', label: 'Accounts', icon: WalletCards, path: '/accounts' },
  { id: 'reports', label: 'Reports', icon: BarChart3, path: '/reports' },
  { id: 'payees', label: 'Payees', icon: UsersRound, path: '/payees' },
]
const balanceSheetGroups: BalanceSheetGroup[] = ['Personal', 'Company', 'Real estate', 'Pension']
const incomeReportGroups: ReportGroup[] = ['personal_income', 'company_revenue']
const expenseReportGroups: ReportGroup[] = ['personal_expense', 'company_expense']
const taxReportGroups: ReportGroup[] = ['personal_tax', 'company_tax']

function isIncomeReportGroup(group?: ReportGroup) {
  return Boolean(group && incomeReportGroups.includes(group))
}

function isExpenseReportGroup(group?: ReportGroup) {
  return Boolean(group && expenseReportGroups.includes(group))
}

function isTaxReportGroup(group?: ReportGroup) {
  return Boolean(group && taxReportGroups.includes(group))
}

function accountBalanceSheetGroup(account: Account): BalanceSheetGroup {
  return account.balanceSheetGroup ?? (account.scope === 'Company' ? 'Company' : 'Personal')
}

const balanceAdjustmentReasonLabels: Record<BalanceAdjustmentReason, string> = {
  market_valuation: 'Market valuation',
  asset_valuation: 'Asset valuation',
  liability_adjustment: 'Liability adjustment',
  reconciliation: 'Reconciliation correction',
  other: 'Other adjustment',
}

function inferredBalanceAdjustmentReason(account: Account): BalanceAdjustmentReason {
  if (account.investment || account.pension || account.balanceSheetGroup === 'Pension') return 'market_valuation'
  if (account.balanceSheetGroup === 'Real estate') return /mortgage|loan|bolån/i.test(account.name) ? 'liability_adjustment' : 'asset_valuation'
  if (/tesla|car|vehicle|auto|voiture|coche/i.test(account.name)) return 'asset_valuation'
  if (/mortgage|loan|bolån/i.test(account.name)) return 'liability_adjustment'
  if (account.type === 'Savings') return 'market_valuation'
  return 'reconciliation'
}

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

function MonthPicker({ value, onChange }: { value: string; onChange: (month: string) => void }) {
  const selectedDate = useMemo(() => fromMonthKey(value) ?? new Date(), [value])
  const [open, setOpen] = useState(false)
  const [viewingYear, setViewingYear] = useState(selectedDate.getFullYear())
  const pickerRef = useRef<HTMLDivElement>(null)
  const currentMonth = toMonthKey(new Date())
  const months = Array.from({ length: 12 }, (_, index) => new Intl.DateTimeFormat('en', { month: 'short' }).format(new Date(2020, index, 1)))

  useEffect(() => setViewingYear(selectedDate.getFullYear()), [selectedDate])
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeWithEscape)
    }
  }, [open])

  const chooseMonth = (monthIndex: number) => {
    onChange(`${viewingYear}-${String(monthIndex + 1).padStart(2, '0')}`)
    setOpen(false)
  }

  return <div className="month-picker" ref={pickerRef}>
    <button type="button" className="month-picker-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <CalendarDays size={17} /><span>{monthName.format(selectedDate)}</span><ChevronDown size={14} />
    </button>
    {open && <div className="month-picker-popover" role="dialog" aria-label="Choose month">
      <div className="month-picker-year">
        <button type="button" aria-label="Previous year" onClick={() => setViewingYear((year) => year - 1)}><ChevronLeft size={17} /></button>
        <strong>{viewingYear}</strong>
        <button type="button" aria-label="Next year" onClick={() => setViewingYear((year) => year + 1)}><ChevronRight size={17} /></button>
      </div>
      <div className="month-picker-grid">{months.map((month, index) => {
        const monthKey = `${viewingYear}-${String(index + 1).padStart(2, '0')}`
        return <button type="button" key={month} className={`${monthKey === value ? 'selected' : ''}${monthKey === currentMonth ? ' current' : ''}`} aria-pressed={monthKey === value} onClick={() => chooseMonth(index)}>{month}</button>
      })}</div>
      <button type="button" className="month-picker-today" onClick={() => { onChange(currentMonth); setOpen(false) }}>Go to current month</button>
    </div>}
  </div>
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

function handleClientNavigation(event: React.MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigate()
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
      setWorkspace(await loadWorkspace(new URLSearchParams(window.location.search).get('month') ?? undefined))
    } catch (caught) {
      setError(new Error(getErrorMessage(caught, 'Could not load your workspace.')))
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
  const [openAccountGroups, setOpenAccountGroups] = useState<Record<BalanceSheetGroup, boolean>>({ Personal: true, Company: true, 'Real estate': true, Pension: true })
  const [closedAccountsOpen, setClosedAccountsOpen] = useState(false)
  const [bankTarget, setBankTarget] = useState<Account | null>(null)
  const [accountTarget, setAccountTarget] = useState<Account | null>(null)
  const [categoryTarget, setCategoryTarget] = useState<Transaction | null>(null)
  const [syncingAccountId, setSyncingAccountId] = useState('')
  const [reviewingCandidateId, setReviewingCandidateId] = useState('')
  const [rematchingAccountId, setRematchingAccountId] = useState('')
  const [syncNotice, setSyncNotice] = useState<{ accountId: string; message: string } | null>(null)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const historyLoadedRef = useRef(false)
  const historyRequest = useRef<Promise<void> | null>(null)
  const monthCache = useRef(new Map<string, Transaction[]>())

  const accountMatch = matchPath('/accounts/:accountId', location.pathname)
  const categoryMatch = matchPath('/categories/:categoryId', location.pathname)
  const payeeMatch = matchPath('/payees/:payeeId', location.pathname)
  const page: Page = accountMatch ? 'accounts'
    : categoryMatch ? 'overview'
      : payeeMatch ? 'payees'
      : location.pathname === '/transactions' ? 'transactions'
        : location.pathname === '/payees' ? 'payees'
        : location.pathname === '/budgets' ? 'overview'
          : location.pathname === '/reports' || location.pathname === '/reports/net-worth' || location.pathname === '/performance' ? 'reports'
            : location.pathname === '/accounts' ? 'accounts'
              : location.pathname === '/settings' ? 'settings'
              : 'overview'
  const requestedMonthKey = new URLSearchParams(location.search).get('month')
  const requestedMonth = fromMonthKey(requestedMonthKey)
  const viewedMonth = useMemo(() => fromMonthKey(requestedMonthKey) ?? new Date(), [requestedMonthKey])
  const selectedMonthKey = toMonthKey(viewedMonth)
  const reportView: ReportView = location.pathname === '/reports/net-worth' ? 'net-worth' : 'profit-loss'

  if (!monthCache.current.size) monthCache.current.set(selectedMonthKey, workspace.data.transactions)

  const ensureFullHistory = useCallback(async (revalidate = false) => {
    if (historyLoadedRef.current && !revalidate) return
    if (historyRequest.current) return historyRequest.current
    setHistoryLoading(true)
    const request = loadCachedAllTransactions(workspace.workspaceId, data.transactions, revalidate)
      .then((allTransactions) => {
        historyLoadedRef.current = true
        setData((current) => ({ ...current, transactions: allTransactions }))
        setHistoryLoaded(true)
      })
      .catch((cause) => setSyncError(getErrorMessage(cause, 'Could not load transaction history.')))
      .finally(() => { setHistoryLoading(false); historyRequest.current = null })
    historyRequest.current = request
    return request
  }, [data.transactions, workspace.workspaceId])

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
    if (historyLoaded) return
    const cached = monthCache.current.get(selectedMonthKey)
    if (cached) {
      setData((current) => ({ ...current, transactions: cached }))
    }
    let cancelled = false
    const fetchMonth = async (monthKey: string, activate: boolean) => {
      if (monthCache.current.has(monthKey)) return
      const monthStart = `${monthKey}-01`
      const nextMonth = new Date(`${monthStart}T12:00:00Z`)
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
      const { transactions: monthTransactions } = await loadTransactionPage(workspace.workspaceId, { startDate: monthStart, endDate: nextMonth.toISOString().slice(0, 10) })
      if (cancelled || historyLoadedRef.current) return
      monthCache.current.set(monthKey, monthTransactions)
      if (activate) setData((current) => ({ ...current, transactions: monthTransactions }))
    }
    if (!cached) void fetchMonth(selectedMonthKey, true).catch((cause) => { if (!cancelled) setSyncError(getErrorMessage(cause, 'Could not load this month.')) })
    const selectedDate = new Date(`${selectedMonthKey}-01T12:00:00Z`)
    for (const offset of [-1, 1]) {
      const adjacent = new Date(selectedDate)
      adjacent.setUTCMonth(adjacent.getUTCMonth() + offset)
      void fetchMonth(adjacent.toISOString().slice(0, 7), false).catch(() => undefined)
    }
    return () => { cancelled = true }
  }, [historyLoaded, selectedMonthKey, workspace.workspaceId])

  useEffect(() => {
    if (page === 'overview' || page === 'payees' || page === 'reports' || Boolean(payeeMatch || categoryTarget)) void ensureFullHistory()
  }, [categoryTarget, ensureFullHistory, page, payeeMatch])

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
  const categoryGroup = (categoryId?: string) => data.categories.find((category) => category.id === categoryId)?.reportGroup
  const convertedTransactionAmount = (transaction: Transaction) => convertMinor(transaction.amountMinor, transaction.currency, workspace.defaultCurrency, transaction.date, data.fxRates) ?? 0
  const convertCurrentBalance = (account: Account) => convertMinor(account.balanceMinor, account.currency, workspace.defaultCurrency, todayInParis(), data.fxRates) ?? 0
  const totalForReportGroup = (group: ReportGroup) => transactions
    .filter((t) => categoryGroup(t.categoryId) === group)
    .reduce((sum, t) => sum + (t.type === 'income' ? convertedTransactionAmount(t) : t.type === 'expense' ? -convertedTransactionAmount(t) : 0), 0)
  const totalExpenseForReportGroup = (group: ReportGroup) => transactions
    .filter((t) => categoryGroup(t.categoryId) === group)
    .reduce((sum, t) => sum + (t.type === 'expense' ? convertedTransactionAmount(t) : t.type === 'income' ? -convertedTransactionAmount(t) : 0), 0)
  const personalIncome = totalForReportGroup('personal_income')
  const personalExpenses = totalExpenseForReportGroup('personal_expense')
  const companyRevenue = totalForReportGroup('company_revenue')
  const companyExpenses = totalExpenseForReportGroup('company_expense')
  const activeAccounts = data.accounts.filter((account) => !account.closed)
  const closedAccounts = data.accounts.filter((account) => account.closed)
  const pendingImportCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const candidate of data.bankImportCandidates) counts.set(candidate.accountId, (counts.get(candidate.accountId) ?? 0) + 1)
    return counts
  }, [data.bankImportCandidates])
  const totalBalance = activeAccounts.reduce((sum, account) => sum + convertCurrentBalance(account), 0)
  const categorySpending = (id: string) => {
    const group = categoryGroup(id)
    return transactions
      .filter((t) => t.categoryId === id && t.type !== 'transfer')
      .reduce((sum, t) => {
        const direction = t.type === 'income' ? 1 : -1
        return sum + (isIncomeReportGroup(group) ? direction : -direction) * convertedTransactionAmount(t)
      }, 0)
  }
  const budgetForCategory = (categoryId: string) => data.budgets
    .filter((budget) => budget.month === selectedMonthKey && budget.categoryId === categoryId)
    .reduce((sum, budget) => sum + budget.amountMinor, 0)
  const personalTaxesPaid = totalExpenseForReportGroup('personal_tax')
  const companyTaxesPaid = totalExpenseForReportGroup('company_tax')
  const estimatedCompanyTax = Math.max(0, Math.round((companyRevenue - companyExpenses) * data.settings.estimatedCompanyTaxRateBps / 10_000))
  const selectedCategory = data.categories.find((category) => category.id === categoryMatch?.params.categoryId)
  const selectedAccount = data.accounts.find((account) => account.id === accountMatch?.params.accountId)
  const selectedPayee = data.payees.find((payee) => payee.id === payeeMatch?.params.payeeId)
  const pageTitle = selectedAccount?.name ?? selectedCategory?.name ?? selectedPayee?.name ?? (page === 'settings' ? 'Settings' : page === 'reports' && reportView === 'net-worth' ? 'Net worth' : navItems.find((item) => item.id === page)?.label) ?? 'Overview'
  const accountsByBalanceSheetGroup = balanceSheetGroups.map((group) => ({ group, accounts: activeAccounts.filter((account) => accountBalanceSheetGroup(account) === group) }))

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

  async function reloadWorkspaceSnapshot() {
    await clearTransactionCache(workspace.workspaceId)
    const refreshed = await loadWorkspace(selectedMonthKey)
    monthCache.current.set(selectedMonthKey, refreshed.data.transactions)
    historyLoadedRef.current = false
    setHistoryLoaded(false)
    return refreshed
  }

  async function saveExchangeRate(rate: FxRate) {
    const saved = await saveFxRate(workspace.workspaceId, rate)
    setData((current) => ({
      ...current,
      fxRates: [...current.fxRates.filter((item) => item.id !== saved.id), saved]
        .sort((left, right) => left.date.localeCompare(right.date)),
    }))
  }

  async function removeExchangeRate(rateId: string) {
    await deleteFxRate(workspace.workspaceId, rateId)
    setData((current) => ({ ...current, fxRates: current.fxRates.filter((rate) => rate.id !== rateId) }))
  }

  function selectMonth(month: string) {
    const selected = fromMonthKey(month)
    if (selected) navigate(pathWithMonth(location.pathname, selected))
  }

  async function addAccount(account: Omit<Account, 'id'>, openingBalanceDate?: string) {
    const nextAccount = { ...account, id: uid() }
    const openingBalance: Transaction | undefined = account.balanceMinor === 0 ? undefined : {
      id: uid(),
      date: openingBalanceDate ?? todayInParis(),
      payee: 'Opening balance',
      amountMinor: account.balanceMinor,
      type: 'opening_balance',
      accountId: nextAccount.id,
      currency: account.currency,
      source: 'manual',
      posted: true,
    }
    try {
      setSyncError('')
      await createAccount(workspace.workspaceId, nextAccount, data.accounts.length, openingBalance)
      setData((current) => ({
        ...current,
        accounts: [...current.accounts, nextAccount],
        transactions: openingBalance ? [...current.transactions, openingBalance] : current.transactions,
      }))
      setModal(null)
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Could not save the account.')
    }
  }

  async function editAccount(account: Account) {
    const nextAccount = { ...account, scope: account.balanceSheetGroup === 'Company' ? 'Company' as const : 'Personal' as const }
    try {
      setSyncError('')
      await updateAccountDetails(workspace.workspaceId, nextAccount)
      setData((current) => ({ ...current, accounts: current.accounts.map((item) => item.id === nextAccount.id ? nextAccount : item) }))
      setAccountTarget(null)
      setModal(null)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not update the account.'))
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

  async function addCategory(category: Omit<Category, 'id'>, budgetMinor: number) {
    const categoryId = uid()
    const nextCategory = {
      ...category,
      id: categoryId,
      sortOrder: Math.max(-10, ...data.categories.filter((item) => item.categoryGroupId === category.categoryGroupId).map((item) => item.sortOrder ?? 0)) + 10,
    }
    const nextBudget = budgetMinor ? { id: uid(), month: selectedMonthKey, categoryId, scope: 'Personal' as const, amountMinor: budgetMinor } : null
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

  async function updateBudget(categoryId: string, amountMinor: number) {
    const existing = data.budgets.find((budget) => budget.month === selectedMonthKey && budget.categoryId === categoryId)
    const nextBudget = existing ? { ...existing, scope: 'Personal' as const, amountMinor } : { id: uid(), month: selectedMonthKey, categoryId, scope: 'Personal' as const, amountMinor }
    try {
      setSyncError('')
      await saveBudget(workspace.workspaceId, nextBudget)
      setData((current) => ({
        ...current,
        budgets: [
          ...current.budgets.filter((budget) => budget.month !== selectedMonthKey || budget.categoryId !== categoryId),
          nextBudget,
        ],
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

  async function removeUnusedCategory(categoryId: string) {
    try {
      setSyncError('')
      await deleteUnusedCategory(workspace.workspaceId, categoryId)
      setData((current) => ({
        ...current,
        categories: current.categories.filter((category) => category.id !== categoryId),
        budgets: current.budgets.filter((budget) => budget.categoryId !== categoryId),
        payees: current.payees.map((payee) => payee.defaultCategoryId === categoryId ? { ...payee, defaultCategoryId: undefined } : payee),
        bankImportCandidates: current.bankImportCandidates.map((candidate) => candidate.categoryId === categoryId ? { ...candidate, categoryId: undefined } : candidate),
      }))
      goTo('/')
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not delete the category.'))
      throw error
    }
  }

  async function editCategory(categoryId: string, changes: Pick<Category, 'name' | 'reportGroup' | 'icon' | 'color'>) {
    const normalizedName = changes.name.normalize('NFKC').trim()
    try {
      setSyncError('')
      if (!normalizedName) throw new Error('Enter a category name.')
      if (data.categories.some((category) => category.id !== categoryId && category.name.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0)) {
        throw new Error(`A category named “${normalizedName}” already exists.`)
      }
      const normalizedChanges = { ...changes, name: normalizedName }
      await updateCategoryDetails(workspace.workspaceId, categoryId, normalizedChanges)
      setData((current) => ({
        ...current,
        categories: current.categories.map((category) => category.id === categoryId ? { ...category, ...normalizedChanges } : category),
      }))
      setModal(null)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not update the category.'))
      throw error
    }
  }

  async function changeCategoryGroup(categoryId: string, categoryGroupId: string) {
    const normalizedGroupId = categoryGroupId || undefined
    const sortOrder = Math.max(-10, ...data.categories.filter((category) => category.id !== categoryId && category.categoryGroupId === normalizedGroupId).map((category) => category.sortOrder ?? 0)) + 10
    try {
      setSyncError('')
      await updateCategoryGroupAssignment(workspace.workspaceId, categoryId, categoryGroupId || null, sortOrder)
      setData((current) => ({
        ...current,
        categories: current.categories.map((category) => category.id === categoryId ? { ...category, categoryGroupId: normalizedGroupId, sortOrder } : category),
      }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not change the category group.'))
      throw error
    }
  }

  async function reorderCategories(categoryGroupId: string, categoryIds: string[]) {
    const groupCategoryIds = data.categories.filter((category) => category.categoryGroupId === categoryGroupId).map((category) => category.id)
    if (categoryIds.length !== groupCategoryIds.length || categoryIds.some((id) => !groupCategoryIds.includes(id))) throw new Error('The category order no longer matches this group. Refresh and try again.')
    try {
      setSyncError('')
      await saveCategoryOrder(workspace.workspaceId, categoryIds)
      const order = new Map(categoryIds.map((id, index) => [id, index * 10]))
      setData((current) => ({
        ...current,
        categories: current.categories.map((category) => order.has(category.id) ? { ...category, sortOrder: order.get(category.id) } : category),
      }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not reorder the categories.'))
      throw error
    }
  }

  async function addCategoryGroup(name: string) {
    const normalizedName = name.normalize('NFKC').trim()
    if (!normalizedName) throw new Error('Enter a category group name.')
    if (data.categoryGroups.some((group) => group.name.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0)) throw new Error(`A category group named “${normalizedName}” already exists.`)
    const group: CategoryGroup = {
      id: uid(),
      name: normalizedName,
      sortOrder: Math.max(-10, ...data.categoryGroups.map((item) => item.sortOrder)) + 10,
      showCategories: true,
    }
    try {
      setSyncError('')
      await createCategoryGroup(workspace.workspaceId, group)
      setData((current) => ({ ...current, categoryGroups: [...current.categoryGroups, group] }))
      return group
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not create the category group.'))
      throw error
    }
  }

  async function renameCategoryGroup(categoryGroupId: string, name: string) {
    const normalizedName = name.normalize('NFKC').trim()
    if (!normalizedName) throw new Error('Enter a category group name.')
    if (data.categoryGroups.some((group) => group.id !== categoryGroupId && group.name.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0)) throw new Error(`A category group named “${normalizedName}” already exists.`)
    try {
      setSyncError('')
      await updateCategoryGroupName(workspace.workspaceId, categoryGroupId, normalizedName)
      setData((current) => ({ ...current, categoryGroups: current.categoryGroups.map((group) => group.id === categoryGroupId ? { ...group, name: normalizedName } : group) }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not rename the category group.'))
      throw error
    }
  }

  async function reorderCategoryGroups(categoryGroupIds: string[]) {
    try {
      setSyncError('')
      await saveCategoryGroupOrder(workspace.workspaceId, categoryGroupIds)
      setData((current) => ({
        ...current,
        categoryGroups: categoryGroupIds.flatMap((id, index) => {
          const group = current.categoryGroups.find((item) => item.id === id)
          return group ? [{ ...group, sortOrder: index * 10 }] : []
        }),
      }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not reorder the category groups.'))
      throw error
    }
  }

  async function removeCategoryGroup(categoryGroupId: string) {
    if (data.categories.some((category) => category.categoryGroupId === categoryGroupId)) throw new Error('Reassign the categories in this group before removing it.')
    try {
      setSyncError('')
      await deleteCategoryGroup(workspace.workspaceId, categoryGroupId)
      setData((current) => ({ ...current, categoryGroups: current.categoryGroups.filter((group) => group.id !== categoryGroupId) }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not remove the category group.'))
      throw error
    }
  }

  async function addTransaction(transaction: Omit<Transaction, 'id'>) {
    try {
      setSyncError('')
      const resolvedPayees = transaction.type === 'transfer' || transaction.type === 'opening_balance' ? [] : await ensurePayees(workspace.workspaceId, [transaction.payee])
      const resolvedPayee = resolvedPayees[0]
      const createdPayee = resolvedPayee && !data.payees.some((payee) => payee.id === resolvedPayee.id)
      if (createdPayee && transaction.categoryId) await updatePayeeDefaults(workspace.workspaceId, resolvedPayee.id, transaction.categoryId, transaction.accountId)
      const payeeWithDefaults = createdPayee && resolvedPayee ? { ...resolvedPayee, defaultCategoryId: transaction.categoryId, defaultAccountId: transaction.accountId } : resolvedPayee
      const nextTransaction = { ...transaction, id: uid(), payeeId: resolvedPayee?.id }
      await createTransaction(workspace.workspaceId, nextTransaction)
      void clearTransactionCache(workspace.workspaceId)
    setData((current) => ({
      ...current,
      transactions: [...current.transactions, nextTransaction],
      payees: payeeWithDefaults && !current.payees.some((payee) => payee.id === payeeWithDefaults.id) ? [...current.payees, payeeWithDefaults] : current.payees,
      accounts: current.accounts.map((account) => {
        if (transaction.type === 'transfer') {
          if (account.id === transaction.accountId) return { ...account, balanceMinor: account.balanceMinor - transaction.amountMinor }
          if (account.id === transaction.toAccountId) return { ...account, balanceMinor: account.balanceMinor + transaction.amountMinor }
          return account
        }
        const signedAmount = transaction.type === 'income' || transaction.type === 'opening_balance' ? transaction.amountMinor : -transaction.amountMinor
        return account.id === transaction.accountId ? { ...account, balanceMinor: account.balanceMinor + signedAmount } : account
      }),
    }))
    setModal(null)
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Could not save the transaction.')
    }
  }

  async function changeTransactionDetails(transactionId: string, date: string, payeeName: string, payeeId: string | undefined, categoryId: string, memo: string, rememberDefault: boolean, rememberMapping: boolean, mappingSource: string, matchingTransactionIds: string[]) {
    try {
      setSyncError('')
      const selectedPayee = payeeId ? data.payees.find((payee) => payee.id === payeeId) : undefined
      const [payee] = selectedPayee ? [selectedPayee] : await ensurePayees(workspace.workspaceId, [payeeName])
      const createdPayee = !data.payees.some((item) => item.id === payee.id)
      const transaction = data.transactions.find((item) => item.id === transactionId)
      await updateTransactionDetails(workspace.workspaceId, transactionId, date, payee.id, categoryId, memo)
      await updateTransactionCategories(workspace.workspaceId, matchingTransactionIds, categoryId)
      void clearTransactionCache(workspace.workspaceId)
      if (transaction) {
        monthCache.current.delete(transaction.date.slice(0, 7))
        monthCache.current.delete(date.slice(0, 7))
      }
      if (createdPayee && transaction) await updatePayeeDefaults(workspace.workspaceId, payee.id, categoryId, transaction.accountId)
      else if (rememberDefault) await updatePayeeDefaultCategory(workspace.workspaceId, payee.id, categoryId)
      if (rememberMapping && mappingSource.trim()) {
        try {
          const normalizedSource = normalizedPayeeName(mappingSource)
          const existingMapping = data.payeeMappings.find((mapping) => normalizedPayeeName(mapping.sourceName) === normalizedSource)
          if (existingMapping && existingMapping.payeeId !== payee.id) await updatePayeeMapping(workspace.workspaceId, existingMapping.id, mappingSource, payee.id, existingMapping.matchType)
          else if (!existingMapping) await createPayeeMapping(workspace.workspaceId, mappingSource, payee.id)
        } catch (mappingError) {
          const refreshed = await reloadWorkspaceSnapshot()
          setData(refreshed.data)
          setCategoryTarget(null)
          setSyncError(`Transaction updated, but its bank memo could not be saved as a mapping: ${getErrorMessage(mappingError, 'Unknown error')}`)
          return
        }
      }
      const payeeWithDefaults = createdPayee && transaction ? { ...payee, defaultCategoryId: categoryId, defaultAccountId: transaction.accountId } : rememberDefault ? { ...payee, defaultCategoryId: categoryId } : payee
      setData((current) => ({
        ...current,
        payees: current.payees.some((item) => item.id === payee.id)
          ? current.payees.map((item) => item.id === payee.id ? payeeWithDefaults : item)
          : [...current.payees, payeeWithDefaults],
        transactions: current.transactions.map((transaction) => transaction.id === transactionId ? { ...transaction, date, payeeId: payee.id, payee: payee.name, categoryId, note: memo.normalize('NFKC').trim() || undefined } : matchingTransactionIds.includes(transaction.id) ? { ...transaction, categoryId } : transaction),
      }))
      setCategoryTarget(null)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not update the transaction.'))
    }
  }

  async function changeTransferDetails(transactionId: string, date: string, destinationAccountId: string, memo: string) {
    const transaction = data.transactions.find((item) => item.id === transactionId && item.type === 'transfer')
    if (!transaction) return
    try {
      setSyncError('')
      await updateTransferDetails(workspace.workspaceId, transactionId, date, destinationAccountId, memo)
      void clearTransactionCache(workspace.workspaceId)
      monthCache.current.delete(transaction.date.slice(0, 7))
      monthCache.current.delete(date.slice(0, 7))
      const refreshed = await reloadWorkspaceSnapshot()
      setData(refreshed.data)
      setCategoryTarget(null)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not update the transfer.'))
      throw error
    }
  }

  async function changeOpeningBalance(transactionId: string, date: string, amountMinor: number) {
    const transaction = data.transactions.find((item) => item.id === transactionId && item.type === 'opening_balance')
    if (!transaction) return
    try {
      setSyncError('')
      await updateOpeningBalance(workspace.workspaceId, transactionId, date, amountMinor)
      void clearTransactionCache(workspace.workspaceId)
      const difference = amountMinor - transaction.amountMinor
      setData((current) => ({
        ...current,
        transactions: current.transactions.map((item) => item.id === transactionId ? { ...item, date, amountMinor } : item),
        accounts: current.accounts.map((account) => account.id === transaction.accountId ? { ...account, balanceMinor: account.balanceMinor + difference } : account),
      }))
      setCategoryTarget(null)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not update the opening balance.'))
      throw error
    }
  }

  async function saveBalanceAdjustment(account: Account, date: string, observedBalanceMinor: number, reason: BalanceAdjustmentReason, memo: string, transactionId?: string) {
    try {
      setSyncError('')
      if (transactionId) await updateBalanceAdjustment(workspace.workspaceId, transactionId, date, observedBalanceMinor, reason, memo)
      else await createBalanceAdjustment(workspace.workspaceId, {
        id: uid(), date, payee: balanceAdjustmentReasonLabels[reason], note: memo || undefined,
        amountMinor: 0, type: 'balance_adjustment', accountId: account.id, currency: account.currency,
        balanceCheckpointMinor: observedBalanceMinor, adjustmentReason: reason, posted: true, source: 'manual',
      })
      const refreshed = await reloadWorkspaceSnapshot()
      setData(refreshed.data)
      setModal(null)
      setAccountTarget(null)
      setCategoryTarget(null)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not save the balance adjustment.'))
      throw error
    }
  }

  async function mapUnmatchedPayee(sourceName: string, payeeId: string) {
    try {
      setSyncError('')
      await assignPayeeMapping(workspace.workspaceId, sourceName, payeeId)
      const refreshed = await reloadWorkspaceSnapshot()
      setData(refreshed.data)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not map the transaction description.'))
      throw error
    }
  }

  async function createPayeeFromUnmatched(sourceName: string, payeeName: string, categoryId: string, accountId: string) {
    try {
      setSyncError('')
      const [payee] = await ensurePayees(workspace.workspaceId, [payeeName])
      if (!payee) throw new Error('The payee could not be created.')
      await updatePayeeDefaults(workspace.workspaceId, payee.id, categoryId || null, accountId || null)
      await assignPayeeMapping(workspace.workspaceId, sourceName, payee.id)
      const refreshed = await reloadWorkspaceSnapshot()
      setData(refreshed.data)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not create and map the payee.'))
      throw error
    }
  }

  async function createPayeeForReview(payeeName: string, categoryId: string, accountId: string) {
    try {
      setSyncError('')
      const payeeWithDefaults: Payee = { id: uid(), name: payeeName.normalize('NFKC').trim(), defaultCategoryId: categoryId || undefined, defaultAccountId: accountId || undefined }
      await createPayee(workspace.workspaceId, payeeWithDefaults, data.payees.length)
      setData((current) => ({
        ...current,
        payees: [...current.payees, payeeWithDefaults],
      }))
      return payeeWithDefaults
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not create the payee.'))
      throw error
    }
  }

  async function changePayeeDefaults(payeeId: string, categoryId: string, accountId: string) {
    try {
      setSyncError('')
      await updatePayeeDefaults(workspace.workspaceId, payeeId, categoryId || null, accountId || null)
      setData((current) => ({
        ...current,
        payees: current.payees.map((payee) => payee.id === payeeId ? { ...payee, defaultCategoryId: categoryId || undefined, defaultAccountId: accountId || undefined } : payee),
      }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not update the payee defaults.'))
      throw error
    }
  }

  async function changePayeeDefaultCategoryOnly(payeeId: string, categoryId: string) {
    try {
      setSyncError('')
      await updatePayeeDefaultCategory(workspace.workspaceId, payeeId, categoryId || null)
      setData((current) => ({
        ...current,
        payees: current.payees.map((payee) => payee.id === payeeId ? { ...payee, defaultCategoryId: categoryId || undefined } : payee),
      }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not update the payee default category.'))
      throw error
    }
  }

  async function renamePayee(payeeId: string, name: string) {
    const normalizedName = name.normalize('NFKC').trim()
    if (!normalizedName) throw new Error('A payee name is required.')
    if (data.payees.some((payee) => payee.id !== payeeId && payee.name.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0)) {
      throw new Error(`A payee named “${normalizedName}” already exists.`)
    }
    try {
      setSyncError('')
      await updatePayeeName(workspace.workspaceId, payeeId, normalizedName)
      setData((current) => ({
        ...current,
        payees: current.payees.map((payee) => payee.id === payeeId ? { ...payee, name: normalizedName } : payee),
        transactions: current.transactions.map((transaction) => transaction.payeeId === payeeId ? { ...transaction, payee: normalizedName } : transaction),
      }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not rename the payee.'))
      throw error
    }
  }

  async function removeUnusedPayee(payeeId: string) {
    try {
      setSyncError('')
      await deleteUnusedPayee(workspace.workspaceId, payeeId)
      setData((current) => ({
        ...current,
        payees: current.payees.filter((payee) => payee.id !== payeeId),
        unusedPayeeIds: current.unusedPayeeIds.filter((id) => id !== payeeId),
        payeeMappings: current.payeeMappings.filter((mapping) => mapping.payeeId !== payeeId),
        bankImportCandidates: current.bankImportCandidates.map((candidate) => candidate.payeeId === payeeId ? { ...candidate, payeeId: undefined } : candidate),
      }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not delete the payee.'))
      throw error
    }
  }

  async function removeAllUnusedPayees() {
    try {
      setSyncError('')
      const deletedIds = await deleteAllUnusedPayees(workspace.workspaceId, data.unusedPayeeIds)
      const refreshed = await reloadWorkspaceSnapshot()
      setData(refreshed.data)
      return deletedIds.length
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not delete the unused payees.'))
      throw error
    }
  }

  async function addPayeeMapping(payeeId: string, sourceName: string) {
    try {
      setSyncError('')
      await createPayeeMapping(workspace.workspaceId, sourceName, payeeId)
      const refreshed = await reloadWorkspaceSnapshot()
      setData(refreshed.data)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not add the mapping.'))
      throw error
    }
  }

  async function changePayeeMapping(mappingId: string, sourceName: string, payeeId: string, matchType: PayeeMapping['matchType']) {
    try {
      setSyncError('')
      await updatePayeeMapping(workspace.workspaceId, mappingId, sourceName, payeeId, matchType)
      setData((current) => ({
        ...current,
        payeeMappings: current.payeeMappings.map((mapping) => mapping.id === mappingId ? { ...mapping, sourceName: sourceName.normalize('NFKC').trim(), payeeId, matchType } : mapping),
      }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not update the mapping.'))
      throw error
    }
  }

  async function promotePayeeMapping(mappingId: string) {
    const mapping = data.payeeMappings.find((item) => item.id === mappingId)
    if (!mapping) throw new Error('The suggested mapping no longer exists.')
    await changePayeeMapping(mapping.id, mapping.sourceName, mapping.payeeId, 'starts_with')
  }

  async function addPayeeAlternativeForReview(sourceName: string, payeeId: string, accountId: string) {
    try {
      setSyncError('')
      await createPayeeMapping(workspace.workspaceId, sourceName, payeeId)
      await rematchPendingBankImportPayees(workspace.workspaceId, accountId)
      const refreshed = await reloadWorkspaceSnapshot()
      setData(refreshed.data)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not add the alternative payee name.'))
      throw error
    }
  }

  async function removePayeeMapping(mappingId: string) {
    try {
      setSyncError('')
      await deletePayeeMapping(workspace.workspaceId, mappingId)
      setData((current) => ({ ...current, payeeMappings: current.payeeMappings.filter((mapping) => mapping.id !== mappingId) }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not remove the mapping.'))
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

  async function changeYearlyFinancialPlan(plan: YearlyFinancialPlan) {
    const nextPlans = [...data.yearlyFinancialPlans.filter((item) => item.year !== plan.year), plan]
    await saveYearlyFinancialPlans(workspace.workspaceId, nextPlans)
    setData((current) => ({ ...current, yearlyFinancialPlans: nextPlans }))
  }

  async function changeBankImportMode(accountId: string, mode: 'review' | 'automatic') {
    try {
      setSyncError('')
      await updateBankImportMode(workspace.workspaceId, accountId, mode)
      setData((current) => ({
        ...current,
        accounts: current.accounts.map((account) => account.id === accountId ? { ...account, bankImportMode: mode } : account),
      }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not update the bank import mode.'))
    }
  }

  async function decideBankImportCandidate(candidateId: string, decision: 'approve' | 'reject', categoryId?: string, rememberCategory = false, payeeId?: string | null, rememberMapping = false, bankDescription = '', createdPayee = false, defaultAccountId = '') {
    try {
      setSyncError('')
      setReviewingCandidateId(candidateId)
      if (decision === 'approve') {
        if (!categoryId) throw new Error('Choose a category before approving this transaction.')
        let resolvedPayeeId = payeeId ?? null
        let payeeCreatedDuringApproval = false
        if (!resolvedPayeeId) {
          const [createdPayee] = await ensurePayees(workspace.workspaceId, [bankDescription])
          resolvedPayeeId = createdPayee.id
          payeeCreatedDuringApproval = true
        }
        await updateBankImportCandidatePayee(workspace.workspaceId, candidateId, resolvedPayeeId)
        await approveBankImportCandidate(workspace.workspaceId, candidateId, categoryId, rememberCategory)
        if ((createdPayee || payeeCreatedDuringApproval) && defaultAccountId) {
          try {
            await updatePayeeDefaults(workspace.workspaceId, resolvedPayeeId, categoryId, defaultAccountId)
          } catch (defaultsError) {
            const refreshed = await reloadWorkspaceSnapshot()
            setData(refreshed.data)
            setSyncError(`Transaction approved, but the new payee defaults could not be saved: ${getErrorMessage(defaultsError, 'Unknown error')}`)
            return
          }
        }
        if (rememberMapping && resolvedPayeeId && bankDescription.trim()) {
          try {
            const normalizedDescription = bankDescription.normalize('NFKC').trim().toLocaleLowerCase('en')
            const existingMapping = data.payeeMappings.find((mapping) => mapping.sourceName.normalize('NFKC').trim().toLocaleLowerCase('en') === normalizedDescription)
            if (existingMapping && existingMapping.payeeId !== resolvedPayeeId) await updatePayeeMapping(workspace.workspaceId, existingMapping.id, bankDescription, resolvedPayeeId, existingMapping.matchType)
            else if (!existingMapping) await createPayeeMapping(workspace.workspaceId, bankDescription, resolvedPayeeId)
            if (defaultAccountId) await rematchPendingBankImportPayees(workspace.workspaceId, defaultAccountId)
          } catch (mappingError) {
            const refreshed = await reloadWorkspaceSnapshot()
            setData(refreshed.data)
            setSyncError(`Transaction approved, but its bank description could not be saved as a mapping: ${getErrorMessage(mappingError, 'Unknown error')}`)
            return
          }
        }
      }
      else await rejectBankImportCandidate(workspace.workspaceId, candidateId)
      const refreshed = await reloadWorkspaceSnapshot()
      setData(refreshed.data)
    } catch (error) {
      setSyncError(getErrorMessage(error, `Could not ${decision} the bank transaction.`))
    } finally {
      setReviewingCandidateId('')
    }
  }

  async function rematchBankImportPayees(accountId: string) {
    try {
      setSyncError('')
      setRematchingAccountId(accountId)
      const matched = await rematchPendingBankImportPayees(workspace.workspaceId, accountId)
      const refreshed = await reloadWorkspaceSnapshot()
      setData(refreshed.data)
      setSyncNotice({ accountId, message: matched ? `${matched} pending ${matched === 1 ? 'transaction now has' : 'transactions now have'} a matched payee.` : 'No additional payees matched.' })
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not recheck pending payees.'))
    } finally {
      setRematchingAccountId('')
    }
  }

  async function postBankImportAsTransfer(candidateId: string, counterpartyAccountId: string) {
    try {
      setSyncError('')
      setReviewingCandidateId(candidateId)
      await approveBankImportCandidateAsTransfer(workspace.workspaceId, candidateId, counterpartyAccountId)
      void clearTransactionCache(workspace.workspaceId)
      const refreshed = await reloadWorkspaceSnapshot()
      setData(refreshed.data)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not post the bank transaction as a transfer.'))
      throw error
    } finally {
      setReviewingCandidateId('')
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
      const refreshed = await reloadWorkspaceSnapshot()
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
            <a key={id} href={pathWithMonth(path)} className={page === id ? 'nav-item active' : 'nav-item'} onClick={(event) => handleClientNavigation(event, () => goTo(path))}>
              <Icon size={19} /><span>{label}</span>
            </a>
          ))}
        </nav>

        <nav className="sidebar-accounts" aria-label="Accounts">
          <a href={pathWithMonth('/accounts')} className={page === 'accounts' && !selectedAccount ? 'account-section-title active' : 'account-section-title'} onClick={(event) => handleClientNavigation(event, () => goTo('/accounts'))}>
            <span><WalletCards size={16} />Accounts</span><b>{formatMoney(totalBalance, workspace.defaultCurrency)}</b>
          </a>
          {accountsByBalanceSheetGroup.map(({ group, accounts }) => accounts.length > 0 && <SidebarAccountGroup key={group} label={group} accounts={accounts} pendingImportCounts={pendingImportCounts} open={openAccountGroups[group]} onToggle={() => setOpenAccountGroups((current) => ({ ...current, [group]: !current[group] }))} selectedAccountId={selectedAccount?.id} accountHref={(id) => pathWithMonth(`/accounts/${id}`)} onSelect={(id) => goTo(`/accounts/${id}`)} />)}
          {closedAccounts.length > 0 && <SidebarAccountGroup label="Closed accounts" accounts={closedAccounts} pendingImportCounts={pendingImportCounts} open={closedAccountsOpen} onToggle={() => setClosedAccountsOpen((current) => !current)} selectedAccountId={selectedAccount?.id} accountHref={(id) => pathWithMonth(`/accounts/${id}`)} onSelect={(id) => goTo(`/accounts/${id}`)} />}
          <button className="sidebar-add-account" onClick={() => setModal('account')}><Plus size={13} />Add account</button>
        </nav>

        <div className="sidebar-bottom">
          <button className="nav-item"><CircleHelp size={19} /><span>Help & feedback</span></button>
          <a href={pathWithMonth('/settings')} className={page === 'settings' ? 'nav-item active' : 'nav-item'} onClick={(event) => handleClientNavigation(event, () => goTo('/settings'))}><Settings size={19} /><span>Settings</span></a>
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
            <div><span className="eyebrow">{selectedAccount ? 'Accounts' : selectedCategory ? 'Categories' : selectedPayee ? 'Payees' : page === 'payees' ? 'Directory' : page === 'settings' ? workspace.workspaceName : page === 'overview' ? 'At a glance' : 'Personal budget'}</span><h1>{pageTitle}</h1></div>
          </div>
          <div className="top-actions">
            {page !== 'payees' && page !== 'settings' && <div className="month-switcher">
              <button aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft size={17} /></button>
              <MonthPicker value={selectedMonthKey} onChange={selectMonth} />
              <button aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight size={17} /></button>
            </div>}
            {page !== 'settings' && <button className="primary-button" onClick={() => setModal('transaction')}><Plus size={18} />Add transaction</button>}
          </div>
        </header>

        {syncError && <div className="sync-error" role="alert">{syncError}</div>}

        {page === 'transactions' && (
          <TransactionsPage transactions={transactions} allTransactions={data.transactions} accounts={data.accounts} categories={data.categories} search={search} setSearch={setSearch} historyLoaded={historyLoaded} historyLoading={historyLoading} onRequestHistory={() => ensureFullHistory(true)} onEditCategory={setCategoryTarget} />
        )}
        {page === 'payees' && !selectedPayee && (
          <PayeesPage payees={data.payees} unusedPayeeIds={data.unusedPayeeIds} mappings={data.payeeMappings} transactions={data.transactions} categories={data.categories} accounts={data.accounts} onSelectPayee={(id) => goTo(`/payees/${id}`)} onMapPayee={mapUnmatchedPayee} onCreatePayee={createPayeeFromUnmatched} onChangeDefaultCategory={changePayeeDefaultCategoryOnly} onDeleteUnusedPayee={removeUnusedPayee} onDeleteAllUnusedPayees={removeAllUnusedPayees} />
        )}
        {page === 'overview' && !selectedCategory && (
          <div className="page-content narrow-page overview-page">
            <YearlySpendingPlan data={data} defaultCurrency={workspace.defaultCurrency} historyLoading={historyLoading} onSavePlan={changeYearlyFinancialPlan} />
            <OverviewPage accounts={activeAccounts} defaultCurrency={workspace.defaultCurrency} totalBalance={totalBalance} convertBalance={convertCurrentBalance} personal={{ income: personalIncome, expenses: personalExpenses, tax: personalTaxesPaid, net: personalIncome - personalExpenses - personalTaxesPaid }} company={{ income: companyRevenue, expenses: companyExpenses, tax: companyTaxesPaid + estimatedCompanyTax, net: companyRevenue - companyExpenses - companyTaxesPaid - estimatedCompanyTax }} month={viewedMonth} onOpenNetWorth={() => goTo('/reports/net-worth')} onOpenProfitAndLoss={() => goTo('/reports')} />
            <BudgetsPage categories={data.categories} categoryGroups={data.categoryGroups} categorySpending={categorySpending} budgetForCategory={budgetForCategory} showHiddenActivityAlert={selectedMonthKey === toMonthKey(new Date())} onAdd={() => setModal('category')} onManageGroups={() => setModal('category-groups')} onSelectCategory={(id) => goTo(`/categories/${id}`)} onUnhideCategory={(id) => setCategoryHidden(id, false)} />
          </div>
        )}
        {page === 'reports' && (
          <ReportsPage data={data} viewedMonth={viewedMonth} defaultCurrency={workspace.defaultCurrency} view={reportView} historyLoading={historyLoading} onChangeView={(nextView) => goTo(nextView === 'net-worth' ? '/reports/net-worth' : '/reports')} onUpdateTaxRate={changeTaxRate} onEditTransaction={setCategoryTarget} />
        )}
        {page === 'accounts' && !selectedAccount && (
          <AccountsPage accounts={activeAccounts} pendingImportCounts={pendingImportCounts} totalBalance={totalBalance} defaultCurrency={workspace.defaultCurrency} convertBalance={convertCurrentBalance} onAdd={() => setModal('account')} onSelectAccount={(id) => goTo(`/accounts/${id}`)} onReorder={reorderAccounts} />
        )}
        {page === 'settings' && (
          <SettingsPage workspaceId={workspace.workspaceId} workspaceName={workspace.workspaceName} defaultCurrency={workspace.defaultCurrency} accounts={data.accounts} fxRates={data.fxRates} onSaveFxRate={saveExchangeRate} onDeleteFxRate={removeExchangeRate} />
        )}
        {selectedAccount && (
          <AccountDetailPage account={selectedAccount} transactions={transactions.filter((transaction) => transaction.accountId === selectedAccount.id || transaction.toAccountId === selectedAccount.id)} allTransactions={data.transactions.filter((transaction) => transaction.accountId === selectedAccount.id || transaction.toAccountId === selectedAccount.id)} candidates={data.bankImportCandidates.filter((candidate) => candidate.accountId === selectedAccount.id)} categories={data.categories} payees={data.payees} mappings={data.payeeMappings} accounts={data.accounts} historyLoaded={historyLoaded} historyLoading={historyLoading} onRequestHistory={() => ensureFullHistory(true)} onBack={() => goTo('/accounts')} onSelectAccount={(id) => goTo(`/accounts/${id}`)} onEditAccount={() => { setAccountTarget(selectedAccount); setModal('edit-account') }} onAdjustBalance={() => { setAccountTarget(selectedAccount); setModal('balance-adjustment') }} onLinkBank={() => { setBankTarget(selectedAccount); setModal('bank') }} onSyncBank={() => syncBank(selectedAccount)} onImportModeChange={(mode) => changeBankImportMode(selectedAccount.id, mode)} onReviewCandidate={decideBankImportCandidate} onPostTransfer={postBankImportAsTransfer} onRematchPayees={() => rematchBankImportPayees(selectedAccount.id)} onCreatePayee={createPayeeForReview} onPromoteMapping={promotePayeeMapping} onAddAlternativeName={(sourceName, payeeId) => addPayeeAlternativeForReview(sourceName, payeeId, selectedAccount.id)} onUnhideCategory={(categoryId) => setCategoryHidden(categoryId, false)} onEditTransaction={setCategoryTarget} reviewingCandidateId={reviewingCandidateId} rematchingPayees={rematchingAccountId === selectedAccount.id} syncing={syncingAccountId === selectedAccount.id} syncNotice={syncNotice?.accountId === selectedAccount.id ? syncNotice.message : ''} />
        )}
        {selectedCategory && (
          <CategoryDetailPage category={selectedCategory} spent={categorySpending(selectedCategory.id)} budget={budgetForCategory(selectedCategory.id)} transactions={transactions.filter((transaction) => transaction.categoryId === selectedCategory.id)} allTransactions={data.transactions.filter((transaction) => transaction.categoryId === selectedCategory.id)} categories={data.categories} categoryGroups={data.categoryGroups} accounts={data.accounts} historyLoaded={historyLoaded} historyLoading={historyLoading} onRequestHistory={() => ensureFullHistory(true)} onUpdateBudget={updateBudget} onUpdateGroup={changeCategoryGroup} onEdit={() => setModal('edit-category')} onDelete={removeUnusedCategory} onSetHidden={setCategoryHidden} onBack={() => goTo('/')} onSelectCategory={(id) => goTo(`/categories/${id}`)} onEditTransaction={setCategoryTarget} />
        )}
        {selectedPayee && (
          <PayeeDetailPage key={selectedPayee.id} payee={selectedPayee} payees={data.payees} mappings={data.payeeMappings.filter((mapping) => mapping.payeeId === selectedPayee.id)} transactions={data.transactions.filter((transaction) => transaction.payeeId === selectedPayee.id)} categories={data.categories} accounts={data.accounts} onBack={() => goTo('/payees')} onEditTransaction={setCategoryTarget} onRename={renamePayee} onUpdateDefaults={changePayeeDefaults} onAddMapping={addPayeeMapping} onUpdateMapping={changePayeeMapping} onRemoveMapping={removePayeeMapping} />
        )}
      </main>

      {modal && (
        <ModalShell title={modal === 'transaction' ? 'Add transaction' : modal === 'account' ? 'Create account' : modal === 'edit-account' ? 'Edit account' : modal === 'balance-adjustment' ? 'Adjust balance' : modal === 'category' ? 'Create category' : modal === 'edit-category' ? 'Edit category' : modal === 'category-groups' ? 'Manage category groups' : `Connect ${bankTarget?.name ?? 'account'}`} onClose={() => { setModal(null); setAccountTarget(null) }}>
          {modal === 'transaction' && <TransactionForm accounts={activeAccounts} categories={data.categories.filter((category) => !category.hidden)} payees={data.payees} onSubmit={addTransaction} />}
          {modal === 'account' && <AccountForm onSubmit={addAccount} />}
          {modal === 'edit-account' && accountTarget && <AccountForm account={accountTarget} onSubmit={(changes) => editAccount({ ...accountTarget, ...changes })} />}
          {modal === 'balance-adjustment' && accountTarget && <BalanceAdjustmentForm account={accountTarget} onSubmit={(date, balance, reason, memo) => saveBalanceAdjustment(accountTarget, date, balance, reason, memo)} />}
          {modal === 'category' && <CategoryForm categoryGroups={data.categoryGroups} onSubmit={addCategory} />}
          {modal === 'edit-category' && selectedCategory && <CategoryDetailsForm category={selectedCategory} categories={data.categories} onSubmit={editCategory} />}
          {modal === 'category-groups' && <CategoryGroupsForm groups={data.categoryGroups} categories={data.categories} onAdd={addCategoryGroup} onRename={renameCategoryGroup} onReorder={reorderCategoryGroups} onReorderCategories={reorderCategories} onRemove={removeCategoryGroup} />}
          {modal === 'bank' && bankTarget && <BankLinkForm account={bankTarget} workspaceId={workspace.workspaceId} onComplete={() => window.location.reload()} />}
        </ModalShell>
      )}
      {categoryTarget && <ModalShell title={categoryTarget.type === 'opening_balance' ? 'Edit opening balance' : categoryTarget.type === 'balance_adjustment' ? 'Edit balance adjustment' : categoryTarget.type === 'transfer' ? 'Edit transfer' : 'Edit transaction'} onClose={() => setCategoryTarget(null)}>
        {categoryTarget.type === 'opening_balance'
          ? <OpeningBalanceForm transaction={categoryTarget} onSubmit={(date, amountMinor) => changeOpeningBalance(categoryTarget.id, date, amountMinor)} />
          : categoryTarget.type === 'balance_adjustment'
            ? <BalanceAdjustmentForm account={data.accounts.find((account) => account.id === categoryTarget.accountId)!} transaction={categoryTarget} onSubmit={(date, balance, reason, memo) => saveBalanceAdjustment(data.accounts.find((account) => account.id === categoryTarget.accountId)!, date, balance, reason, memo, categoryTarget.id)} />
            : categoryTarget.type === 'transfer'
              ? <TransferDetailsForm transaction={categoryTarget} accounts={data.accounts} onSubmit={(date, destinationAccountId, memo) => changeTransferDetails(categoryTarget.id, date, destinationAccountId, memo)} />
              : <TransactionDetailsForm transaction={categoryTarget} transactions={data.transactions} categories={data.categories} payees={data.payees} mappings={data.payeeMappings} accounts={data.accounts} onSubmit={(date, payeeName, payeeId, categoryId, memo, rememberDefault, rememberMapping, mappingSource, matchingTransactionIds) => changeTransactionDetails(categoryTarget.id, date, payeeName, payeeId, categoryId, memo, rememberDefault, rememberMapping, mappingSource, matchingTransactionIds)} />}
      </ModalShell>}
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

function BankImportConnectedIcon({ pendingCount = 0 }: { pendingCount?: number }) {
  const awaitingApproval = pendingCount > 0
  const label = awaitingApproval ? `${pendingCount} imported ${pendingCount === 1 ? 'transaction' : 'transactions'} awaiting approval` : 'Connected for bank import'
  return <span className={`bank-import-connected-icon${awaitingApproval ? ' awaiting-approval' : ''}`} role="img" aria-label={label} title={label}>{awaitingApproval ? <CircleAlert size={12} strokeWidth={2.4} /> : <Link2 size={11} strokeWidth={2.4} />}</span>
}

function accountIsReconciled(account: Account) {
  return Boolean(account.providerAccountId
    && account.bankBalanceMinor !== undefined
    && account.bankBalanceCurrency === account.currency
    && account.bankBalanceMinor === account.balanceMinor)
}

function AccountReconciledIndicator({ label = false }: { label?: boolean }) {
  return <span className={`account-reconciled-indicator${label ? ' labelled' : ''}`} role="status" aria-label="Reconciled" title="Calculated balance matches the latest bank balance"><CircleCheck size={label ? 14 : 13} strokeWidth={2.4} />{label && <span>Reconciled</span>}</span>
}

function SidebarAccountGroup({ label, accounts, pendingImportCounts, open, onToggle, selectedAccountId, accountHref, onSelect }: { label: string; accounts: Account[]; pendingImportCounts: Map<string, number>; open: boolean; onToggle: () => void; selectedAccountId?: string; accountHref: (id: string) => string; onSelect: (id: string) => void }) {
  const subtotal = accounts.reduce((sum, account) => sum + account.balanceMinor, 0)
  const currencies = [...new Set(accounts.map((account) => account.currency))]
  return <div className="sidebar-account-group">
    <button className="sidebar-account-group-title" onClick={onToggle} aria-expanded={open}>
      <span><ChevronDown size={12} className={open ? '' : 'collapsed'} />{label}</span><b>{currencies.length === 1 ? formatMoney(subtotal, currencies[0]) : `${accounts.length} accounts`}</b>
    </button>
    {open && <div className="sidebar-account-list">{accounts.map((account) => <a key={account.id} href={accountHref(account.id)} className={selectedAccountId === account.id ? 'sidebar-account active' : 'sidebar-account'} onClick={(event) => handleClientNavigation(event, () => onSelect(account.id))}><span><i style={{ background: account.color }} /><span className="sidebar-account-name">{account.name}</span>{account.providerAccountId && <BankImportConnectedIcon pendingCount={pendingImportCounts.get(account.id)} />}{accountIsReconciled(account) && <AccountReconciledIndicator />}</span><b className={account.balanceMinor < 0 ? 'negative' : ''}>{formatMoney(account.balanceMinor, account.currency)}</b></a>)}</div>}
  </div>
}

function HiddenCategoryActivityAlert({ categories, categorySpending, onSelectCategory, prominent }: { categories: Category[]; categorySpending: (id: string) => number; onSelectCategory: (id: string) => void; prominent: boolean }) {
  const affectedCategories = categories
    .map((category) => ({ category, balance: categorySpending(category.id) }))
    .filter(({ category, balance }) => category.hidden && balance !== 0)
    .sort((left, right) => Math.abs(right.balance) - Math.abs(left.balance))

  if (!affectedCategories.length) return null

  return <div className={`hidden-category-activity-alert${prominent ? '' : ' subtle'}`} role={prominent ? 'alert' : 'status'}>
    <ShieldAlert size={19} />
    <div>
      <strong>{prominent ? `Hidden ${affectedCategories.length === 1 ? 'category has' : 'categories have'} a balance this month` : `Hidden ${affectedCategories.length === 1 ? 'category had' : 'categories had'} activity in this period`}</strong>
      <p>{prominent ? `Review ${affectedCategories.length === 1 ? 'it' : 'them'} so activity does not stay out of sight.` : 'Historical activity remains included in the totals.'}</p>
      <div className="hidden-category-activity-items">
        {affectedCategories.map(({ category, balance }) => <button type="button" key={category.id} onClick={() => onSelectCategory(category.id)}>{category.name}<b>{formatMoney(balance)}</b></button>)}
      </div>
    </div>
  </div>
}

function backupFilename(backup: WorkspaceBackup, prefix = 'next-expense-backup') {
  const createdAt = new Date(backup.createdAt)
  const timestamp = Number.isNaN(createdAt.getTime())
    ? new Date().toISOString()
    : createdAt.toISOString()
  return `${prefix}-${timestamp.slice(0, 16).replace('T', '-').replace(':', '')}.json`
}

function downloadWorkspaceBackup(backup: WorkspaceBackup, prefix?: string) {
  const file = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = backupFilename(backup, prefix)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function SettingsPage({ workspaceId, workspaceName, defaultCurrency, accounts, fxRates, onSaveFxRate, onDeleteFxRate }: {
  workspaceId: string
  workspaceName: string
  defaultCurrency: string
  accounts: Account[]
  fxRates: FxRate[]
  onSaveFxRate: (rate: FxRate) => Promise<void>
  onDeleteFxRate: (rateId: string) => Promise<void>
}) {
  const [exporting, setExporting] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [backup, setBackup] = useState<WorkspaceBackup | null>(null)
  const [backupFileName, setBackupFileName] = useState('')
  const [backupFileSize, setBackupFileSize] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [rateMonth, setRateMonth] = useState(toMonthKey(new Date()))
  const availableCurrencies = [...new Set([
    ...accounts.map((account) => account.currency),
    ...fxRates.flatMap((rate) => [rate.baseCurrency, rate.quoteCurrency]),
  ])].filter((currency) => currency !== defaultCurrency).sort()
  const [rateCurrency, setRateCurrency] = useState(availableCurrencies[0] ?? 'USD')
  const [rateValue, setRateValue] = useState('')
  const [savingRateId, setSavingRateId] = useState('')
  const [confirmingDeleteRateId, setConfirmingDeleteRateId] = useState('')

  async function saveRate(rate: FxRate) {
    setSavingRateId(rate.id)
    setError('')
    setNotice('')
    try {
      await onSaveFxRate(rate)
      setNotice('Exchange rate saved. Combined balances and reports have been updated.')
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not save the exchange rate.'))
      throw cause
    } finally {
      setSavingRateId('')
    }
  }

  async function addRate(event: FormEvent) {
    event.preventDefault()
    const parsed = Number(rateValue.trim().replace(',', '.'))
    const rateHundredths = Math.round(parsed * 100)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(rateMonth) || !Number.isFinite(parsed) || rateHundredths <= 0) {
      setError('Choose a month and enter a positive exchange rate.')
      return
    }
    try {
      await saveRate({ id: uid(), baseCurrency: defaultCurrency, quoteCurrency: rateCurrency, rateHundredths, date: `${rateMonth}-01` })
      setRateValue('')
    } catch {
      // saveRate has already exposed the database error.
    }
  }

  async function removeRate(rateId: string) {
    setSavingRateId(rateId)
    setError('')
    setNotice('')
    try {
      await onDeleteFxRate(rateId)
      setConfirmingDeleteRateId('')
      setNotice('Exchange rate deleted.')
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not delete the exchange rate.'))
    } finally {
      setSavingRateId('')
    }
  }

  async function exportBackup() {
    setExporting(true)
    setError('')
    setNotice('')
    try {
      const exported = await exportWorkspaceBackup(workspaceId)
      downloadWorkspaceBackup(exported)
      setNotice('Backup downloaded. Keep it somewhere you can find again.')
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not create the backup.'))
    } finally {
      setExporting(false)
    }
  }

  async function chooseBackup(file?: File) {
    setBackup(null)
    setBackupFileName('')
    setBackupFileSize(0)
    setConfirmed(false)
    setNotice('')
    setError('')
    if (!file) return
    if (file.size > 100 * 1024 * 1024) {
      setError('This backup is larger than 100 MB and cannot be restored here.')
      return
    }
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!isWorkspaceBackup(parsed)) throw new Error('This is not a complete Next Expense backup.')
      setBackup(parsed)
      setBackupFileName(file.name)
      setBackupFileSize(file.size)
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not read this backup file.'))
    }
  }

  async function restoreBackup() {
    if (!backup || !confirmed) return
    setRestoring(true)
    setError('')
    setNotice('')
    try {
      const safetyBackup = await exportWorkspaceBackup(workspaceId)
      downloadWorkspaceBackup(safetyBackup, 'next-expense-before-restore')
      await restoreWorkspaceBackup(workspaceId, backup)
      window.location.reload()
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not restore the backup. Your existing workspace was left unchanged.'))
      setRestoring(false)
    }
  }

  const keyCounts = backup ? [
    ['Accounts', backup.tables.accounts.length],
    ['Transactions', backup.tables.transactions.length],
    ['Categories', backup.tables.categories.length],
    ['Budgets', backup.tables.budgets.length],
    ['Payees', backup.tables.payees.length],
  ] as const : []
  const createdAt = backup ? new Date(backup.createdAt) : null

  return <div className="page-content narrow-page settings-page">
    <section className="panel settings-intro">
      <span className="eyebrow">Your data</span>
      <h2>Backup and restore</h2>
      <p>Save a complete copy of {workspaceName} to this computer. The file contains your financial data, so keep it somewhere private.</p>
    </section>

    <section className="panel fx-settings">
      <div className="fx-settings-heading">
        <div className="settings-card-icon"><ArrowLeftRight size={21} /></div>
        <div><span className="eyebrow">Reporting currency · {defaultCurrency}</span><h2>Exchange rates</h2><p>A saved rate remains in effect until a newer one is entered. Rates use the format “1 {defaultCurrency} equals foreign currency”.</p></div>
      </div>

      <form className="fx-rate-add" onSubmit={(event) => void addRate(event)}>
        <label><span>Month</span><input required type="month" value={rateMonth} onChange={(event) => setRateMonth(event.target.value)} /></label>
        <label><span>Currency</span><select value={rateCurrency} onChange={(event) => setRateCurrency(event.target.value)}>{availableCurrencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label>
        <label><span>1 {defaultCurrency} equals</span><div className="fx-rate-value"><input required min="0.01" step="0.01" inputMode="decimal" type="number" value={rateValue} onChange={(event) => setRateValue(event.target.value)} placeholder="0.00" /><b>{rateCurrency}</b></div></label>
        <button className="primary-button" disabled={Boolean(savingRateId)}><Plus size={17} />Add rate</button>
      </form>

      <div className="fx-rate-table">
        <div className="fx-rate-table-header"><span>Month</span><span>Pair</span><span>Rate</span><span /></div>
        {[...fxRates].sort((left, right) => right.date.localeCompare(left.date) || left.quoteCurrency.localeCompare(right.quoteCurrency)).map((rate) => (
          <ExchangeRateRow
            key={rate.id}
            rate={rate}
            saving={savingRateId === rate.id}
            confirmingDelete={confirmingDeleteRateId === rate.id}
            onSave={async (nextRate) => { try { await saveRate(nextRate) } catch { /* Error is displayed by SettingsPage. */ } }}
            onAskDelete={() => setConfirmingDeleteRateId(rate.id)}
            onCancelDelete={() => setConfirmingDeleteRateId('')}
            onDelete={() => void removeRate(rate.id)}
          />
        ))}
      </div>
      {fxRates.length === 0 && <p className="fx-rate-empty">No exchange rates have been saved yet.</p>}
    </section>

    <div className="settings-backup-grid">
      <section className="panel settings-card">
        <div className="settings-card-icon"><Download size={21} /></div>
        <div>
          <h2>Create a backup</h2>
          <p>Downloads accounts, transactions, budgets, categories, payees, exchange rates, and bank import history. Login details and bank credentials are not included.</p>
        </div>
        <button type="button" className="primary-button settings-action" disabled={exporting || restoring} onClick={() => void exportBackup()}>{exporting ? <LoaderCircle className="spin-icon" size={17} /> : <Download size={17} />}{exporting ? 'Preparing backup…' : 'Download backup'}</button>
      </section>

      <section className="panel settings-card restore-card">
        <div className="settings-card-icon rust"><Upload size={21} /></div>
        <div>
          <h2>Restore from a backup</h2>
          <p>Choose a Next Expense backup file. You can review its date and contents before anything changes.</p>
        </div>
        <label className="secondary-button settings-file-button">
          <Upload size={17} />Choose backup file
          <input type="file" accept=".json,application/json" disabled={restoring} onChange={(event) => { void chooseBackup(event.target.files?.[0]); event.currentTarget.value = '' }} />
        </label>

        {backup && <div className="backup-preview">
          <div className="backup-preview-heading">
            <FileCheck2 size={20} />
            <div><strong>{backup.workspace.name}</strong><span>{Number.isNaN(createdAt?.getTime() ?? NaN) ? 'Date unavailable' : createdAt?.toLocaleString()} · {(backupFileSize / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB</span><small>{backupFileName}</small></div>
          </div>
          <div className="backup-counts">{keyCounts.map(([label, count]) => <div key={label}><strong>{count.toLocaleString()}</strong><span>{label}</span></div>)}</div>
          <label className="restore-confirmation"><input type="checkbox" checked={confirmed} disabled={restoring} onChange={(event) => setConfirmed(event.target.checked)} /><span>I understand this will replace all data in the current workspace.</span></label>
          <button type="button" className="danger-button settings-action" disabled={!confirmed || restoring} onClick={() => void restoreBackup()}>{restoring ? <LoaderCircle className="spin-icon" size={17} /> : <Upload size={17} />}{restoring ? 'Restoring…' : 'Restore this backup'}</button>
          <p className="restore-safety-note">A fresh backup of the current workspace will download automatically before the restore starts.</p>
        </div>}
      </section>
    </div>

    {notice && <div className="settings-notice" role="status">{notice}</div>}
    {error && <div className="settings-error" role="alert">{error}</div>}
  </div>
}

function ExchangeRateRow({ rate, saving, confirmingDelete, onSave, onAskDelete, onCancelDelete, onDelete }: {
  rate: FxRate
  saving: boolean
  confirmingDelete: boolean
  onSave: (rate: FxRate) => Promise<void>
  onAskDelete: () => void
  onCancelDelete: () => void
  onDelete: () => void
}) {
  const [month, setMonth] = useState(rate.date.slice(0, 7))
  const [value, setValue] = useState((rate.rateHundredths / 100).toFixed(2))
  const parsedHundredths = Math.round(Number(value.trim().replace(',', '.')) * 100)
  const changed = month !== rate.date.slice(0, 7) || parsedHundredths !== rate.rateHundredths

  useEffect(() => {
    setMonth(rate.date.slice(0, 7))
    setValue((rate.rateHundredths / 100).toFixed(2))
  }, [rate.date, rate.rateHundredths])

  return <form className="fx-rate-row" onSubmit={(event) => {
    event.preventDefault()
    if (!Number.isSafeInteger(parsedHundredths) || parsedHundredths <= 0) return
    void onSave({ ...rate, date: `${month}-01`, rateHundredths: parsedHundredths })
  }}>
    <input aria-label={`Month for ${rate.baseCurrency}/${rate.quoteCurrency}`} required type="month" value={month} onChange={(event) => setMonth(event.target.value)} disabled={saving} />
    <strong>{rate.baseCurrency}/{rate.quoteCurrency}</strong>
    <div className="fx-rate-value"><input aria-label={`${rate.baseCurrency}/${rate.quoteCurrency} rate`} required min="0.01" step="0.01" inputMode="decimal" type="number" value={value} onChange={(event) => setValue(event.target.value)} disabled={saving} /><b>{rate.quoteCurrency}</b></div>
    <div className="fx-rate-actions">
      {confirmingDelete ? <><button type="button" className="fx-cancel-delete" onClick={onCancelDelete} disabled={saving}>Cancel</button><button type="button" className="fx-confirm-delete" onClick={onDelete} disabled={saving}>{saving ? 'Deleting…' : 'Delete'}</button></> : <>
        <button type="submit" className="secondary-button" disabled={!changed || saving}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" className="icon-button" aria-label={`Delete ${rate.baseCurrency}/${rate.quoteCurrency} rate for ${month}`} onClick={onAskDelete} disabled={saving}><Trash2 size={15} /></button>
      </>}
    </div>
  </form>
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

function TransactionRow({ transaction, categories, accounts, compact = false, focusAccountId, showAccount = false, onEditCategory }: { transaction: Transaction; categories: Category[]; accounts: Account[]; compact?: boolean; focusAccountId?: string; showAccount?: boolean; onEditCategory?: () => void }) {
  const category = categories.find((item) => item.id === transaction.categoryId)
  const sourceAccount = accounts.find((item) => item.id === transaction.accountId)
  const destinationAccount = accounts.find((item) => item.id === transaction.toAccountId)
  const isTransfer = transaction.type === 'transfer'
  const isOpeningBalance = transaction.type === 'opening_balance'
  const isBalanceAdjustment = transaction.type === 'balance_adjustment'
  const transferIsIncoming = isTransfer && transaction.toAccountId === focusAccountId
  const prefix = transaction.type === 'income' || transferIsIncoming || ((isOpeningBalance || isBalanceAdjustment) && transaction.amountMinor >= 0) ? '+' : transaction.type === 'expense' || (isTransfer && focusAccountId) || ((isOpeningBalance || isBalanceAdjustment) && transaction.amountMinor < 0) ? '−' : ''
  const Icon = isTransfer ? ArrowLeftRight : isOpeningBalance ? WalletCards : isBalanceAdjustment ? RefreshCw : category ? (categoryIcons[category.icon as keyof typeof categoryIcons] ?? Sparkles) : ReceiptText
  const amountMinor = isOpeningBalance || isBalanceAdjustment ? Math.abs(transaction.amountMinor) : transaction.amountMinor
  const adjustmentLabel = transaction.adjustmentReason ? balanceAdjustmentReasonLabels[transaction.adjustmentReason] : 'Balance adjustment'
  return (
    <div className={`${compact ? 'transaction-row compact' : 'transaction-row'}${onEditCategory ? ' editable' : ''}`}>
      <span className="transaction-icon" style={{ color: isTransfer || isOpeningBalance || isBalanceAdjustment ? '#587486' : category?.color, background: isTransfer || isOpeningBalance || isBalanceAdjustment ? '#e5ecef' : `${category?.color ?? '#777'}18` }}><Icon size={18} /></span>
      <div>
        <strong>{isTransfer ? `Transfer to ${destinationAccount?.name ?? 'account'}` : isOpeningBalance ? 'Opening balance' : isBalanceAdjustment ? adjustmentLabel : transaction.payee}{transaction.posted === false && <em className="pending-badge">Pending</em>}</strong>
        <span>{isTransfer ? `${sourceAccount?.name ?? 'Account'} → ${destinationAccount?.name ?? 'Account'}` : isOpeningBalance ? sourceAccount?.name ?? 'Unknown account' : isBalanceAdjustment ? `Balance set to ${formatMoney(transaction.balanceCheckpointMinor ?? 0, transaction.currency)}` : showAccount ? sourceAccount?.name ?? 'Unknown account' : category?.name ?? 'Uncategorised'} · {formatShortDate(transaction.date)}</span>
        {transaction.note?.trim() && <span className="transaction-memo">{transaction.note.trim()}</span>}
      </div>
      {onEditCategory && <button type="button" className={!category && !isTransfer && !isOpeningBalance && !isBalanceAdjustment ? 'transaction-category-edit missing' : 'transaction-category-edit'} onClick={onEditCategory} aria-label={`Edit ${isOpeningBalance ? 'opening balance' : isTransfer ? 'transfer' : transaction.payee}`}><Pencil size={12} />Edit</button>}
      <b className={transaction.type === 'income' || transferIsIncoming || ((isOpeningBalance || isBalanceAdjustment) && transaction.amountMinor >= 0) ? 'positive' : isTransfer && !focusAccountId ? 'transfer-amount' : ''}>{prefix}{formatMoney(amountMinor, transaction.currency)}</b>
    </div>
  )
}

function TransactionsPage({ transactions, allTransactions, accounts, categories, search, setSearch, historyLoaded, historyLoading, onRequestHistory, onEditCategory }: { transactions: Transaction[]; allTransactions: Transaction[]; accounts: Account[]; categories: Category[]; search: string; setSearch: (value: string) => void; historyLoaded: boolean; historyLoading: boolean; onRequestHistory: () => Promise<void>; onEditCategory: (transaction: Transaction) => void }) {
  const [view, setView] = useState<'month' | 'all' | 'uncategorized'>('month')
  const [transactionPage, setTransactionPage] = useState(1)
  const sortedAllTransactions = useMemo(() => [...allTransactions].sort((left, right) => right.date.localeCompare(left.date)), [allTransactions])
  const uncategorized = sortedAllTransactions
    .filter((transaction) => (transaction.type === 'expense' || transaction.type === 'income') && !transaction.categoryId)
  const scopedTransactions = view === 'all' ? sortedAllTransactions : view === 'uncategorized' ? uncategorized : transactions
  const normalizedSearch = search.trim().toLocaleLowerCase('en')
  const filtered = scopedTransactions.filter((transaction) => {
    const sourceAccount = accounts.find((account) => account.id === transaction.accountId)?.name ?? ''
    const destinationAccount = accounts.find((account) => account.id === transaction.toAccountId)?.name ?? ''
    const category = categories.find((item) => item.id === transaction.categoryId)?.name ?? ''
    return !normalizedSearch || `${transaction.payee} ${transaction.payeeRaw ?? ''} ${transaction.note ?? ''} ${category} ${sourceAccount} ${destinationAccount} ${transaction.date}`.toLocaleLowerCase('en').includes(normalizedSearch)
  })
  const pageCount = Math.max(1, Math.ceil(filtered.length / detailTransactionPageSize))
  const displayedTransactions = view === 'all'
    ? filtered.slice((transactionPage - 1) * detailTransactionPageSize, transactionPage * detailTransactionPageSize)
    : filtered
  useEffect(() => setTransactionPage(1), [view, search])
  useEffect(() => setTransactionPage((current) => Math.min(current, pageCount)), [pageCount])
  const heading = view === 'uncategorized' ? 'Transactions needing a category' : view === 'all' ? 'All transactions' : 'This month’s transactions'
  return (
    <div className="page-content narrow-page">
      <div className="panel full-panel">
        <div className="panel-heading transaction-heading"><div><span className="eyebrow">Ledger</span><h2>{heading}</h2></div><div className="transaction-heading-actions"><div className="segmented three-way transaction-view-toggle"><button type="button" className={view === 'month' ? 'active transfer' : ''} onClick={() => setView('month')}>This month</button><button type="button" className={view === 'all' ? 'active transfer' : ''} onClick={() => { setView('all'); void onRequestHistory() }}>{historyLoading && !historyLoaded ? 'Loading…' : 'All dates'}</button><button type="button" className={view === 'uncategorized' ? 'active' : ''} onClick={() => { setView('uncategorized'); void onRequestHistory() }}>Needs category <b>{historyLoaded ? uncategorized.length : '…'}</b></button></div><label className="search-box"><Search size={17} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search transactions" /></label></div></div>
        <div className="table-header"><span>Description</span><span>Account</span><span>Amount</span></div>
        <div className="transaction-list-full">
          {displayedTransactions.map((transaction) => (
            <div className="transaction-table-row" key={transaction.id}>
              <TransactionRow transaction={transaction} categories={categories} accounts={accounts} onEditCategory={() => onEditCategory(transaction)} />
              <span className="account-name">{accounts.find((a) => a.id === transaction.accountId)?.name}{transaction.type === 'transfer' ? ` → ${accounts.find((a) => a.id === transaction.toAccountId)?.name ?? ''}` : ''}</span>
            </div>
          ))}
          {!filtered.length && <div className="empty-state"><ReceiptText size={28} /><h3>{view === 'uncategorized' && !search ? 'Everything is categorized' : 'No transactions found'}</h3><p>{view === 'uncategorized' && !search ? 'All non-transfer transactions have a category.' : 'Try a different search or add a new transaction.'}</p></div>}
        </div>
        {view === 'all' && pageCount > 1 && <nav className="account-transaction-pagination" aria-label="Transaction pages"><button type="button" className="secondary-button" disabled={transactionPage === 1} onClick={() => setTransactionPage((current) => Math.max(1, current - 1))}><ChevronLeft size={15} />Previous</button><span>Page {transactionPage} of {pageCount} · {detailTransactionPageSize} per page</span><button type="button" className="secondary-button" disabled={transactionPage === pageCount} onClick={() => setTransactionPage((current) => Math.min(pageCount, current + 1))}>Next<ChevronRight size={15} /></button></nav>}
      </div>
    </div>
  )
}

type PayeeSort = 'transactions' | 'alphabetical'

function PayeesPage({ payees, unusedPayeeIds, mappings, transactions, categories, accounts, onSelectPayee, onMapPayee, onCreatePayee, onChangeDefaultCategory, onDeleteUnusedPayee, onDeleteAllUnusedPayees }: {
  payees: Payee[]
  unusedPayeeIds: string[]
  mappings: PayeeMapping[]
  transactions: Transaction[]
  categories: Category[]
  accounts: Account[]
  onSelectPayee: (id: string) => void
  onMapPayee: (sourceName: string, payeeId: string) => Promise<void>
  onCreatePayee: (sourceName: string, payeeName: string, categoryId: string, accountId: string) => Promise<void>
  onChangeDefaultCategory: (payeeId: string, categoryId: string) => Promise<void>
  onDeleteUnusedPayee: (payeeId: string) => Promise<void>
  onDeleteAllUnusedPayees: () => Promise<number>
}) {
  const [mappingTargets, setMappingTargets] = useState<Record<string, string>>({})
  const [payeeQueries, setPayeeQueries] = useState<Record<string, string>>({})
  const [newPayeeNames, setNewPayeeNames] = useState<Record<string, string>>({})
  const [newPayeeCategories, setNewPayeeCategories] = useState<Record<string, string>>({})
  const [newPayeeAccounts, setNewPayeeAccounts] = useState<Record<string, string>>({})
  const [mappingErrors, setMappingErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState('')
  const [showHiddenDefaults, setShowHiddenDefaults] = useState(false)
  const [showUnusedPayees, setShowUnusedPayees] = useState(false)
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const [deleteAllError, setDeleteAllError] = useState('')
  const unmatched = useMemo(() => {
    const unmatchedByName = new Map<string, { sourceName: string; count: number; lastTransaction: string; categoryIds: string[]; accountIds: string[] }>()
    for (const transaction of transactions) {
      if (transaction.payeeId || (transaction.type !== 'expense' && transaction.type !== 'income')) continue
      const sourceName = (transaction.payeeRaw ?? transaction.payee).normalize('NFKC').trim()
      if (!sourceName) continue
      const key = sourceName.toLocaleLowerCase('en')
      const current = unmatchedByName.get(key)
      unmatchedByName.set(key, {
        sourceName: current?.sourceName ?? sourceName,
        count: (current?.count ?? 0) + 1,
        lastTransaction: !current || transaction.date > current.lastTransaction ? transaction.date : current.lastTransaction,
        categoryIds: transaction.categoryId && !current?.categoryIds.includes(transaction.categoryId) ? [...(current?.categoryIds ?? []), transaction.categoryId] : current?.categoryIds ?? [],
        accountIds: !current?.accountIds.includes(transaction.accountId) ? [...(current?.accountIds ?? []), transaction.accountId] : current.accountIds,
      })
    }
    return [...unmatchedByName.entries()].sort((left, right) => right[1].count - left[1].count || left[1].sourceName.localeCompare(right[1].sourceName))
  }, [transactions])
  const alphabeticalPayees = useMemo(() => [...payees].sort((left, right) => left.name.localeCompare(right.name)), [payees])
  const hiddenCategoryById = useMemo(() => new Map(categories.filter((category) => category.hidden).map((category) => [category.id, category])), [categories])
  const activeCategories = useMemo(() => categories.filter((category) => !category.hidden), [categories])
  const payeesWithHiddenDefaults = useMemo(() => alphabeticalPayees
    .map((payee) => ({ payee, hiddenCategory: hiddenCategoryById.get(payee.defaultCategoryId ?? '') }))
    .filter((item): item is { payee: Payee; hiddenCategory: Category } => Boolean(item.hiddenCategory)), [alphabeticalPayees, hiddenCategoryById])
  const unusedPayeeIdSet = useMemo(() => new Set(unusedPayeeIds), [unusedPayeeIds])
  const unusedPayees = useMemo(() => alphabeticalPayees.filter((payee) => unusedPayeeIdSet.has(payee.id)), [alphabeticalPayees, unusedPayeeIdSet])

  return <PayeeDirectory payees={payees} mappings={mappings} transactions={transactions} categories={categories} accounts={accounts} onSelectPayee={onSelectPayee}>
      {unusedPayees.length > 0 && <section className={`unused-payees${showUnusedPayees ? ' open' : ''}`}>
        <div className="unused-payees-heading"><div><span className="eyebrow">Unused payees</span><h3>{unusedPayees.length} payee{unusedPayees.length === 1 ? ' has' : 's have'} no transactions</h3></div><div className="unused-payees-heading-actions"><p>Would you like to delete {unusedPayees.length === 1 ? 'it' : 'them'}?</p><button type="button" className="secondary-button" aria-expanded={showUnusedPayees} aria-controls="unused-payees-list" onClick={() => setShowUnusedPayees((current) => !current)}>{showUnusedPayees ? 'Hide list' : 'Show list'}<ChevronDown size={15} /></button><button type="button" className="danger-button" onClick={() => { setConfirmingDeleteAll(true); setDeleteAllError('') }}>Delete all</button></div></div>
        {confirmingDeleteAll && <div className="unused-payees-delete-all"><div><strong>Delete all {unusedPayees.length} unused payees?</strong><span>The database will check every transaction again before deleting them. Their alternative names will also be removed.</span></div><button type="button" className="secondary-button" disabled={deletingAll} onClick={() => setConfirmingDeleteAll(false)}>Cancel</button><button type="button" className="danger-button confirming" disabled={deletingAll} onClick={async () => {
          setDeletingAll(true)
          setDeleteAllError('')
          try { await onDeleteAllUnusedPayees(); setConfirmingDeleteAll(false) } catch (cause) { setDeleteAllError(getErrorMessage(cause, 'Could not delete the unused payees.')) } finally { setDeletingAll(false) }
        }}>{deletingAll ? 'Deleting…' : `Delete all ${unusedPayees.length}`}</button>{deleteAllError && <p className="unmatched-error" role="alert">{deleteAllError}</p>}</div>}
        {showUnusedPayees && <div className="unused-payees-list" id="unused-payees-list">{unusedPayees.map((payee) => <UnusedPayeeRow key={payee.id} payee={payee} mappingCount={mappings.filter((mapping) => mapping.payeeId === payee.id).length} onDelete={onDeleteUnusedPayee} />)}</div>}
      </section>}
      {payeesWithHiddenDefaults.length > 0 && <section className={`hidden-payee-defaults${showHiddenDefaults ? ' open' : ''}`}>
        <div className="hidden-payee-defaults-heading"><div><span className="eyebrow">Defaults need attention</span><h3>{payeesWithHiddenDefaults.length} payee{payeesWithHiddenDefaults.length === 1 ? '' : 's'} using hidden categories</h3></div><div className="hidden-payee-defaults-heading-actions"><p>Choose an active replacement so future bank imports can use the payee default.</p><button type="button" className="secondary-button" aria-expanded={showHiddenDefaults} aria-controls="hidden-payee-defaults-list" onClick={() => setShowHiddenDefaults((current) => !current)}>{showHiddenDefaults ? 'Hide' : 'Show'}<ChevronDown size={15} /></button></div></div>
        {showHiddenDefaults && <div className="hidden-payee-defaults-list" id="hidden-payee-defaults-list">{payeesWithHiddenDefaults.map(({ payee, hiddenCategory }) => <HiddenPayeeDefaultRow key={payee.id} payee={payee} hiddenCategory={hiddenCategory} categories={activeCategories} onSave={onChangeDefaultCategory} />)}</div>}
      </section>}
      {unmatched.length > 0 && <section className="unmatched-payees">
        <div className="unmatched-heading"><div><span className="eyebrow">Needs review</span><h3>{unmatched.length} unmatched description{unmatched.length === 1 ? '' : 's'}</h3></div><p>Map each description to a payee. The choice is remembered for future imports.</p></div>
        <div className="unmatched-list">{unmatched.map(([key, item]) => {
          const targetId = mappingTargets[key] ?? ''
          const payeeQuery = payeeQueries[key] ?? ''
          const matchingPayees = payeeQuery.trim() ? alphabeticalPayees.filter((payee) => payee.name.toLocaleLowerCase('en').includes(payeeQuery.trim().toLocaleLowerCase('en'))).slice(0, 8) : []
          const selectedPayee = alphabeticalPayees.find((payee) => payee.id === targetId)
          const hasSelectedQuery = selectedPayee?.name.localeCompare(payeeQuery, undefined, { sensitivity: 'accent' }) === 0
          const newName = newPayeeNames[key] ?? item.sourceName
          const newCategoryId = newPayeeCategories[key] ?? (item.categoryIds.length === 1 ? item.categoryIds[0] : '')
          const newAccountId = newPayeeAccounts[key] ?? (item.accountIds.length === 1 ? item.accountIds[0] : '')
          const isPending = pending === key
          const mappingError = mappingErrors[key] ?? ''
          return <div className="unmatched-row" key={key}>
            <div className="unmatched-source"><strong>{item.sourceName}</strong><span>{item.count} transaction{item.count === 1 ? '' : 's'} · latest {formatShortDate(item.lastTransaction)}</span></div>
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
            <div className="unmatched-create"><div className="unmatched-action"><input aria-label={`New payee name for ${item.sourceName}`} value={newName} onChange={(event) => setNewPayeeNames((current) => ({ ...current, [key]: event.target.value }))} /><button className="secondary-button" disabled={!newName.trim() || !newCategoryId || !newAccountId || isPending} onClick={async () => {
              setPending(key)
              setMappingErrors((current) => ({ ...current, [key]: '' }))
              try {
                await onCreatePayee(item.sourceName, newName.trim(), newCategoryId, newAccountId)
              } catch (error) {
                setMappingErrors((current) => ({ ...current, [key]: getErrorMessage(error, 'Could not create and map this payee.') }))
              } finally {
                setPending('')
              }
            }}>{isPending ? 'Saving…' : 'Create new'}</button></div><div className="unmatched-create-defaults"><label><span>Default category</span><select aria-label={`Default category for new payee ${newName}`} value={newCategoryId} onChange={(event) => setNewPayeeCategories((current) => ({ ...current, [key]: event.target.value }))}><option value="">Choose category…</option>{categories.filter((category) => !category.hidden).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label><span>Default account</span><select aria-label={`Default account for new payee ${newName}`} value={newAccountId} onChange={(event) => setNewPayeeAccounts((current) => ({ ...current, [key]: event.target.value }))}><option value="">Choose account…</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.closed ? ' (closed)' : ''}</option>)}</select></label></div></div>
            {mappingError && <p className="unmatched-error" role="alert">{mappingError}</p>}
          </div>
        })}</div>
      </section>}
  </PayeeDirectory>
}

function UnusedPayeeRow({ payee, mappingCount, onDelete }: { payee: Payee; mappingCount: number; onDelete: (payeeId: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  return <div className="unused-payee-row">
    <span className="payee-avatar">{payee.name.slice(0, 1).toLocaleUpperCase('en')}</span>
    <div className="unused-payee-copy"><strong>{payee.name}</strong><span>{mappingCount} alternative name{mappingCount === 1 ? '' : 's'} will also be removed</span></div>
    {confirming ? <div className="unused-payee-confirm"><span>Delete this payee?</span><button type="button" className="secondary-button" disabled={deleting} onClick={() => setConfirming(false)}>Cancel</button><button type="button" className="danger-button" disabled={deleting} onClick={async () => {
      setDeleting(true)
      setError('')
      try { await onDelete(payee.id) } catch (cause) { setError(getErrorMessage(cause, 'Could not delete the payee.')); setDeleting(false) }
    }}>{deleting ? 'Deleting…' : 'Delete'}</button></div> : <button type="button" className="danger-button" onClick={() => setConfirming(true)}><Trash2 size={14} />Delete</button>}
    {error && <p className="unmatched-error" role="alert">{error}</p>}
  </div>
}

function HiddenPayeeDefaultRow({ payee, hiddenCategory, categories, onSave }: { payee: Payee; hiddenCategory: Category; categories: Category[]; onSave: (payeeId: string, categoryId: string) => Promise<void> }) {
  const [categoryId, setCategoryId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  return <div className="hidden-payee-default-row">
    <span className="payee-avatar">{payee.name.slice(0, 1).toLocaleUpperCase('en')}</span>
    <div className="hidden-payee-default-copy"><strong>{payee.name}</strong><span>Current default: <CategoryLabel category={hiddenCategory} /></span></div>
    <label><span>Replacement category</span><CategorySearchPicker ariaLabel={`Replacement default category for ${payee.name}`} value={categoryId} categories={categories} onChange={setCategoryId} /></label>
    <button type="button" className="secondary-button" disabled={!categoryId || saving} onClick={async () => {
      setSaving(true)
      setError('')
      try { await onSave(payee.id, categoryId) } catch (cause) { setError(getErrorMessage(cause, 'Could not change this default category.')) } finally { setSaving(false) }
    }}>{saving ? 'Saving…' : 'Save'}</button>
    {error && <p className="unmatched-error" role="alert">{error}</p>}
  </div>
}

function PayeeDirectory({ payees, mappings, transactions, categories, accounts, onSelectPayee, children }: { payees: Payee[]; mappings: PayeeMapping[]; transactions: Transaction[]; categories: Category[]; accounts: Account[]; onSelectPayee: (id: string) => void; children: ReactNode }) {
  const [sort, setSort] = useState<PayeeSort>('transactions')
  const [search, setSearch] = useState('')
  const payeeStats = useMemo(() => {
    const stats = new Map<string, { count: number; lastTransaction: string }>()
    for (const transaction of transactions) {
      if (!transaction.payeeId) continue
      const current = stats.get(transaction.payeeId)
      stats.set(transaction.payeeId, {
        count: (current?.count ?? 0) + 1,
        lastTransaction: !current || transaction.date > current.lastTransaction ? transaction.date : current.lastTransaction,
      })
    }
    return stats
  }, [transactions])
  const categoryNames = useMemo(() => new Map(categories.map((category) => [category.id, category.name])), [categories])
  const accountNames = useMemo(() => new Map(accounts.map((account) => [account.id, account.name])), [accounts])
  const mappingCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const mapping of mappings) counts.set(mapping.payeeId, (counts.get(mapping.payeeId) ?? 0) + 1)
    return counts
  }, [mappings])
  const rows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('en')
    return payees
      .filter((payee) => !query || payee.name.toLocaleLowerCase('en').includes(query))
      .map((payee) => ({ payee, count: payeeStats.get(payee.id)?.count ?? 0, lastTransaction: payeeStats.get(payee.id)?.lastTransaction ?? '' }))
      .sort((left, right) => sort === 'alphabetical'
        ? left.payee.name.localeCompare(right.payee.name)
        : right.count - left.count || left.payee.name.localeCompare(right.payee.name))
  }, [payees, payeeStats, search, sort])

  return <div className="page-content narrow-page">
    <div className="panel full-panel">
      <div className="panel-heading payee-heading">
        <div><span className="eyebrow">Directory</span><h2>{payees.length} payee{payees.length === 1 ? '' : 's'}</h2></div>
        <div className="payee-controls">
          <label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search payees" /></label>
          <label className="sort-box"><span>Sort by</span><select value={sort} onChange={(event) => setSort(event.target.value as PayeeSort)}><option value="transactions">Most transactions</option><option value="alphabetical">Alphabetical</option></select></label>
        </div>
      </div>
      {children}
      <div className="payee-table-header"><span>Payee</span><span>Last transaction</span><span>Transactions</span></div>
      <div className="payee-list">
        {rows.map(({ payee, count, lastTransaction }) => {
          const mappingCount = mappingCounts.get(payee.id) ?? 0
          return <button type="button" className="payee-row" key={payee.id} onClick={() => onSelectPayee(payee.id)}>
            <span className="payee-avatar">{payee.name.slice(0, 1).toLocaleUpperCase('en')}</span>
            <span className="payee-name"><strong>{payee.name}</strong><small>{categoryNames.get(payee.defaultCategoryId ?? '') ?? 'No category default'} · {accountNames.get(payee.defaultAccountId ?? '') ?? 'No account default'} · {mappingCount} alternative name{mappingCount === 1 ? '' : 's'}</small></span>
            <span className="payee-last">{lastTransaction ? formatShortDate(lastTransaction) : '—'}</span>
            <span className="payee-count">{count}</span>
            <ChevronRight size={17} />
          </button>
        })}
        {!rows.length && <div className="empty-state"><UsersRound size={28} /><h3>No payees found</h3><p>{search ? 'Try a different search.' : 'Payees will appear when transactions are added.'}</p></div>}
      </div>
    </div>
  </div>
}

function PayeeDetailPage({ payee, payees, mappings, transactions, categories, accounts, onBack, onEditTransaction, onRename, onUpdateDefaults, onAddMapping, onUpdateMapping, onRemoveMapping }: { payee: Payee; payees: Payee[]; mappings: PayeeMapping[]; transactions: Transaction[]; categories: Category[]; accounts: Account[]; onBack: () => void; onEditTransaction: (transaction: Transaction) => void; onRename: (payeeId: string, name: string) => Promise<void>; onUpdateDefaults: (payeeId: string, categoryId: string, accountId: string) => Promise<void>; onAddMapping: (payeeId: string, sourceName: string) => Promise<void>; onUpdateMapping: (mappingId: string, sourceName: string, payeeId: string, matchType: PayeeMapping['matchType']) => Promise<void>; onRemoveMapping: (mappingId: string) => Promise<void> }) {
  const sortedTransactions = [...transactions].sort((left, right) => right.date.localeCompare(left.date))
  const expenseCount = transactions.filter((transaction) => transaction.type === 'expense').length
  const incomeCount = transactions.filter((transaction) => transaction.type === 'income').length
  const [defaultCategoryId, setDefaultCategoryId] = useState(payee.defaultCategoryId ?? '')
  const [defaultAccountId, setDefaultAccountId] = useState(payee.defaultAccountId ?? '')
  const [renaming, setRenaming] = useState(false)
  const [payeeName, setPayeeName] = useState(payee.name)
  const [savingName, setSavingName] = useState(false)
  const [newMapping, setNewMapping] = useState('')
  const [savingDefaults, setSavingDefaults] = useState(false)
  const [addingMapping, setAddingMapping] = useState(false)
  const [error, setError] = useState('')
  const defaultsChanged = defaultCategoryId !== (payee.defaultCategoryId ?? '') || defaultAccountId !== (payee.defaultAccountId ?? '')
  const normalizedPayeeNameValue = payeeName.normalize('NFKC').trim()
  const duplicateName = payees.some((item) => item.id !== payee.id && item.name.localeCompare(normalizedPayeeNameValue, undefined, { sensitivity: 'accent' }) === 0)
  return <div className="page-content narrow-page">
    <div className="entity-page-toolbar"><button className="entity-back" onClick={onBack}><ChevronLeft size={16} />All payees</button></div>
    <div className="panel entity-detail-panel">
      <div className="entity-heading payee-detail-heading">
        <span className="entity-heading-icon payee-detail-icon">{payee.name.slice(0, 1).toLocaleUpperCase('en')}</span>
        <div><span className="eyebrow">Payee</span><h2>{payee.name}</h2></div>
        <div className="entity-heading-actions"><button className="secondary-button" type="button" onClick={() => { setPayeeName(payee.name); setRenaming((current) => !current); setError('') }}><Pencil size={16} />Rename</button></div>
      </div>
      {renaming && <form className="payee-name-editor" onSubmit={async (event) => {
        event.preventDefault()
        if (!normalizedPayeeNameValue || duplicateName || normalizedPayeeNameValue === payee.name) return
        setSavingName(true)
        setError('')
        try { await onRename(payee.id, normalizedPayeeNameValue); setRenaming(false) } catch (cause) { setError(getErrorMessage(cause, 'Could not rename the payee.')) } finally { setSavingName(false) }
      }}>
        <label><span>Payee name</span><input autoFocus required value={payeeName} onChange={(event) => setPayeeName(event.target.value)} /></label>
        <button className="secondary-button" type="button" onClick={() => { setPayeeName(payee.name); setRenaming(false); setError('') }}>Cancel</button>
        <button className="primary-button" disabled={!normalizedPayeeNameValue || duplicateName || normalizedPayeeNameValue === payee.name || savingName}>{savingName ? 'Saving…' : 'Save name'}</button>
        {duplicateName && <p className="auth-error" role="alert">A payee named “{normalizedPayeeNameValue}” already exists.</p>}
      </form>}
      <div className="payee-summary">
        <div><span>All transactions</span><strong>{transactions.length}</strong></div>
        <div><span>Expenses</span><strong>{expenseCount}</strong></div>
        <div><span>Income</span><strong>{incomeCount}</strong></div>
      </div>
      <section className="payee-settings">
        <div className="payee-settings-heading"><div><span className="eyebrow">Defaults</span><h3>New transactions</h3></div><p>These are suggested when this payee is selected.</p></div>
        <div className="payee-default-fields">
          <label><span>Default category</span><CategorySearchPicker ariaLabel={`Default category for ${payee.name}`} value={defaultCategoryId} categories={categories} allowEmpty onChange={setDefaultCategoryId} /></label>
          <label><span>Default account</span><select value={defaultAccountId} onChange={(event) => setDefaultAccountId(event.target.value)}><option value="">No default account</option>{accounts.filter((account) => !account.closed || account.id === defaultAccountId).map((account) => <option key={account.id} value={account.id}>{account.name}{account.closed ? ' (closed)' : ''}</option>)}</select></label>
          <button type="button" className="secondary-button" disabled={!defaultsChanged || savingDefaults} onClick={async () => { setSavingDefaults(true); setError(''); try { await onUpdateDefaults(payee.id, defaultCategoryId, defaultAccountId) } catch (cause) { setError(getErrorMessage(cause, 'Could not save defaults.')) } finally { setSavingDefaults(false) } }}>{savingDefaults ? 'Saving…' : 'Save defaults'}</button>
        </div>
      </section>
      <section className="payee-settings payee-mapping-settings">
        <div className="payee-settings-heading"><div><span className="eyebrow">Bank matching</span><h3>Alternative names</h3></div><p>Bank descriptions that should resolve to this payee.</p></div>
        <div className="payee-mapping-list">
          {mappings.map((mapping) => <PayeeMappingRow key={`${mapping.id}-${mapping.sourceName}-${mapping.payeeId}-${mapping.matchType}`} mapping={mapping} payees={payees} categories={categories} onUpdate={onUpdateMapping} onRemove={onRemoveMapping} />)}
          {!mappings.length && <p className="payee-mapping-empty">No alternative names saved yet.</p>}
        </div>
        <div className="payee-mapping-add"><input aria-label={`Add an alternative name for ${payee.name}`} placeholder="Bank description, e.g. LUIGI GELATERIA ITALIA" value={newMapping} onChange={(event) => setNewMapping(event.target.value)} /><button type="button" className="secondary-button" disabled={!newMapping.trim() || addingMapping} onClick={async () => { setAddingMapping(true); setError(''); try { await onAddMapping(payee.id, newMapping.trim()); setNewMapping('') } catch (cause) { setError(getErrorMessage(cause, 'Could not add the mapping.')) } finally { setAddingMapping(false) } }}>{addingMapping ? 'Adding…' : 'Add mapping'}</button></div>
      </section>
      {error && <p className="auth-error payee-settings-error" role="alert">{error}</p>}
      <div className="table-header"><span>Description</span><span>Account</span><span>Amount</span></div>
      <div className="transaction-list-full">
        {sortedTransactions.map((transaction) => <div className="transaction-table-row" key={transaction.id}>
          <TransactionRow transaction={transaction} categories={categories} accounts={accounts} onEditCategory={transaction.type === 'expense' || transaction.type === 'income' ? () => onEditTransaction(transaction) : undefined} />
          <span className="account-name">{accounts.find((account) => account.id === transaction.accountId)?.name}</span>
        </div>)}
        {!sortedTransactions.length && <div className="empty-state"><ReceiptText size={28} /><h3>No linked transactions</h3><p>This payee is in the register but has no transaction history.</p></div>}
      </div>
    </div>
  </div>
}

function PayeeMappingRow({ mapping, payees, categories, onUpdate, onRemove }: { mapping: PayeeMapping; payees: Payee[]; categories: Category[]; onUpdate: (mappingId: string, sourceName: string, payeeId: string, matchType: PayeeMapping['matchType']) => Promise<void>; onRemove: (mappingId: string) => Promise<void> }) {
  const [sourceName, setSourceName] = useState(mapping.sourceName)
  const [payeeId, setPayeeId] = useState(mapping.payeeId)
  const [matchType, setMatchType] = useState(mapping.matchType)
  const [pending, setPending] = useState<'save' | 'remove' | ''>('')
  const [error, setError] = useState('')
  const changed = sourceName.trim() !== mapping.sourceName || payeeId !== mapping.payeeId || matchType !== mapping.matchType
  return <div className="payee-mapping-row">
    <label><span>Bank description</span><input value={sourceName} onChange={(event) => setSourceName(event.target.value)} /></label>
    <label><span>Maps to</span><PayeeSearchPicker ariaLabel={`Payee for mapping ${mapping.sourceName}`} value={payeeId} payees={payees} categories={categories} onChange={setPayeeId} /></label>
    <label><span>Match rule</span><select value={matchType} onChange={(event) => setMatchType(event.target.value as PayeeMapping['matchType'])}><option value="exact">Exact</option><option value="starts_with">Starts with</option></select></label>
    <div className="payee-mapping-actions"><button type="button" className="secondary-button" disabled={!changed || !sourceName.trim() || !payeeId || Boolean(pending)} onClick={async () => { setPending('save'); setError(''); try { await onUpdate(mapping.id, sourceName.trim(), payeeId, matchType) } catch (cause) { setError(getErrorMessage(cause, 'Could not save this mapping.')) } finally { setPending('') } }}>{pending === 'save' ? 'Saving…' : 'Save'}</button><button type="button" className="mapping-remove" disabled={Boolean(pending)} onClick={async () => { setPending('remove'); setError(''); try { await onRemove(mapping.id) } catch (cause) { setError(getErrorMessage(cause, 'Could not remove this mapping.')) } finally { setPending('') } }}>{pending === 'remove' ? 'Removing…' : 'Remove'}</button></div>
    {error && <p className="unmatched-error" role="alert">{error}</p>}
  </div>
}

function HiddenCategoryBudgetRow({ category, spent, budget, onSelect, onUnhide }: { category: Category; spent: number; budget: number; onSelect: () => void; onUnhide: () => Promise<void> }) {
  const [unhiding, setUnhiding] = useState(false)
  return <div className="hidden-category-budget-row">
    <CategoryRow category={category} spent={spent} budget={budget} onSelect={onSelect} />
    <button type="button" className="secondary-button hidden-category-unhide" disabled={unhiding} onClick={async () => {
      setUnhiding(true)
      try { await onUnhide() } finally { setUnhiding(false) }
    }}>{unhiding ? 'Unhiding…' : 'Unhide'}</button>
  </div>
}

type OverviewBalanceGroup = 'Personal' | 'Real estate' | 'Investments' | 'Company' | 'Pension'
const overviewBalanceGroups: OverviewBalanceGroup[] = ['Personal', 'Real estate', 'Investments', 'Company', 'Pension']

function overviewBalanceGroup(account: Account): OverviewBalanceGroup {
  const group = accountBalanceSheetGroup(account)
  if (group === 'Pension') return 'Pension'
  if (group === 'Real estate') return 'Real estate'
  if (group === 'Company') return 'Company'
  return account.investment ? 'Investments' : 'Personal'
}

type OverviewPnl = { income: number; expenses: number; tax: number; net: number }

type AnnualSpendingMetric = { year: number; income: number; expenses: number; taxes: number }

function annualSpendingMetrics(data: AppData, scope: SpendingGoalScope, defaultCurrency: string, throughDate: string) {
  const categories = new Map(data.categories.map((category) => [category.id, category]))
  const metrics = new Map<number, AnnualSpendingMetric>()
  for (const transaction of data.transactions) {
    if (transaction.date > throughDate || (transaction.type !== 'income' && transaction.type !== 'expense')) continue
    const group = categories.get(transaction.categoryId ?? '')?.reportGroup
    const categoryScope: AccountScope | null = group?.startsWith('personal_') ? 'Personal' : group?.startsWith('company_') ? 'Company' : null
    if (!group || !categoryScope || (scope !== 'Combined' && scope !== categoryScope)) continue
    const year = Number(transaction.date.slice(0, 4))
    const metric = metrics.get(year) ?? { year, income: 0, expenses: 0, taxes: 0 }
    const amount = convertMinor(transaction.amountMinor, transaction.currency, defaultCurrency, transaction.date, data.fxRates) ?? 0
    const direction = transaction.type === 'income' ? 1 : -1
    if (isIncomeReportGroup(group)) metric.income += direction * amount
    if (isExpenseReportGroup(group)) metric.expenses += -direction * amount
    if (isTaxReportGroup(group)) metric.taxes += -direction * amount
    metrics.set(year, metric)
  }
  return [...metrics.values()].sort((left, right) => left.year - right.year)
}

function YearlySpendingPlan({ data, defaultCurrency, historyLoading, onSavePlan }: { data: AppData; defaultCurrency: string; historyLoading: boolean; onSavePlan: (plan: YearlyFinancialPlan) => Promise<void> }) {
  const [scope, setScope] = useState<SpendingGoalScope>('Combined')
  const [projectedCompanyIncomeInput, setProjectedCompanyIncomeInput] = useState('')
  const [monthlySalaryInput, setMonthlySalaryInput] = useState('')
  const [monthlySalaryTaxInput, setMonthlySalaryTaxInput] = useState('')
  const [monthlySocialSecurityInput, setMonthlySocialSecurityInput] = useState('')
  const [estimatedDividendInput, setEstimatedDividendInput] = useState('')
  const [corporateTaxRateInput, setCorporateTaxRateInput] = useState('')
  const [dividendTaxRateInput, setDividendTaxRateInput] = useState('')
  const [savingsGoalInput, setSavingsGoalInput] = useState('')
  const [personalSpendingInput, setPersonalSpendingInput] = useState('')
  const [companySpendingInput, setCompanySpendingInput] = useState('')
  const [planComment, setPlanComment] = useState('')
  const [editingPlan, setEditingPlan] = useState(false)
  const [comparisonOpen, setComparisonOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const today = todayInParis()
  const currentYear = Number(today.slice(0, 4))
  const metrics = annualSpendingMetrics(data, scope, defaultCurrency, today)
  const current = metrics.find((metric) => metric.year === currentYear) ?? { year: currentYear, income: 0, expenses: 0, taxes: 0 }
  const postedTaxes = annualSpendingMetrics(data, 'Combined', defaultCurrency, today).find((metric) => metric.year === currentYear)?.taxes ?? 0
  const previous = metrics.filter((metric) => metric.year < currentYear && (metric.income !== 0 || metric.expenses !== 0 || metric.taxes !== 0)).slice(-3)
  const comparison = [...previous, current]
  const plan = data.yearlyFinancialPlans.find((item) => item.year === currentYear)
  const annualSalary = (plan?.monthlySalaryMinor ?? 0) * 12
  const annualSalaryTax = (plan?.monthlySalaryTaxMinor ?? 0) * 12
  const annualSocialSecurity = (plan?.monthlySocialSecurityMinor ?? 0) * 12
  const taxableCorporateIncome = plan ? Math.max(0, plan.projectedCompanyIncomeMinor - plan.companySpendingMinor - annualSalary - annualSalaryTax - annualSocialSecurity) : 0
  const estimatedCorporateTax = plan ? Math.round(taxableCorporateIncome * plan.corporateTaxRateBps / 10_000) : 0
  const estimatedDividendTax = plan ? Math.round(plan.estimatedDividendMinor * plan.dividendTaxRateBps / 10_000) : 0
  const totalProjectedTaxes = plan ? plan.legacyProjectedTaxesMinor ?? annualSalaryTax + annualSocialSecurity + estimatedCorporateTax + estimatedDividendTax : 0
  const calculatedSpendingLimit = plan ? roundToWholeEuroMinor(Math.max(0, plan.projectedCompanyIncomeMinor - totalProjectedTaxes - plan.savingsGoalMinor)) : 0
  const personalSpendingGoal = plan?.personalSpendingMinor ?? 0
  const combinedSpendingGoal = personalSpendingGoal + (plan?.companySpendingMinor ?? 0)
  const goalAmount = scope === 'Company' ? plan?.companySpendingMinor ?? 0 : scope === 'Personal' ? personalSpendingGoal : combinedSpendingGoal
  const goalLabel = scope === 'Combined' ? 'Combined spending goal' : `${scope} spending goal`
  const goalContext = scope === 'Combined' ? 'Personal + company budgets' : 'Saved annual budget'
  const savedGoalVariance = roundToWholeEuroMinor(combinedSpendingGoal) - calculatedSpendingLimit
  const progress = goalAmount > 0 ? current.expenses / goalAmount * 100 : 0
  const currentDate = new Date(`${today}T12:00:00Z`)
  const startOfYear = new Date(Date.UTC(currentYear, 0, 1))
  const endOfYear = new Date(Date.UTC(currentYear + 1, 0, 1))
  const elapsedFraction = Math.max(1 / 366, (currentDate.getTime() - startOfYear.getTime() + 86_400_000) / (endOfYear.getTime() - startOfYear.getTime()))
  const paceProgress = elapsedFraction * 100
  const expectedSpend = goalAmount * elapsedFraction
  const paceDifference = current.expenses - expectedSpend
  const comparisonMaximum = Math.max(1, ...comparison.flatMap((metric) => [metric.income, metric.expenses, metric.taxes, Math.abs(metric.income - metric.expenses - metric.taxes)]))
  const draftProjectedCompanyIncome = parseMoneyToMinor(projectedCompanyIncomeInput)
  const draftMonthlySalary = parseOptionalMoneyToMinor(monthlySalaryInput)
  const draftMonthlySalaryTax = parseOptionalMoneyToMinor(monthlySalaryTaxInput)
  const draftMonthlySocialSecurity = parseOptionalMoneyToMinor(monthlySocialSecurityInput)
  const draftEstimatedDividend = parseOptionalMoneyToMinor(estimatedDividendInput)
  const draftCorporateTaxRate = parseOptionalPercentageToBps(corporateTaxRateInput)
  const draftDividendTaxRate = parseOptionalPercentageToBps(dividendTaxRateInput)
  const draftSavingsGoal = parseMoneyToMinor(savingsGoalInput)
  const draftPersonalSpending = parseMoneyToMinor(personalSpendingInput)
  const draftCompanySpending = parseMoneyToMinor(companySpendingInput)
  const draftAnnualSalary = (draftMonthlySalary ?? 0) * 12
  const draftAnnualSalaryTax = (draftMonthlySalaryTax ?? 0) * 12
  const draftAnnualSocialSecurity = (draftMonthlySocialSecurity ?? 0) * 12
  const draftTaxableCorporateIncome = Math.max(0, (draftProjectedCompanyIncome ?? 0) - (draftCompanySpending ?? 0) - draftAnnualSalary - draftAnnualSalaryTax - draftAnnualSocialSecurity)
  const draftCorporateTax = Math.round(draftTaxableCorporateIncome * (draftCorporateTaxRate ?? 0) / 10_000)
  const draftDividendTax = Math.round((draftEstimatedDividend ?? 0) * (draftDividendTaxRate ?? 0) / 10_000)
  const draftTotalTaxes = draftAnnualSalaryTax + draftAnnualSocialSecurity + draftCorporateTax + draftDividendTax
  const draftSpendingGoal = roundToWholeEuroMinor(Math.max(0, (draftProjectedCompanyIncome ?? 0) - draftTotalTaxes - (draftSavingsGoal ?? 0)))
  const draftMaximumPersonalSpending = Math.max(0, draftSpendingGoal - (draftCompanySpending ?? 0))
  const draftAllocatedSpending = (draftPersonalSpending ?? 0) + (draftCompanySpending ?? 0)
  const draftAllocationVariance = roundToWholeEuroMinor(draftAllocatedSpending) - draftSpendingGoal
  const moneyInput = (amountMinor: number) => (amountMinor / 100).toFixed(2)

  const resetPlanInputs = useCallback(() => {
    setProjectedCompanyIncomeInput(plan ? moneyInput(plan.projectedCompanyIncomeMinor) : '')
    const hasDetailedTaxes = plan && plan.legacyProjectedTaxesMinor === undefined
    setMonthlySalaryInput(hasDetailedTaxes ? moneyInput(plan?.monthlySalaryMinor ?? 0) : '')
    setMonthlySalaryTaxInput(hasDetailedTaxes ? moneyInput(plan?.monthlySalaryTaxMinor ?? 0) : '')
    setMonthlySocialSecurityInput(hasDetailedTaxes ? moneyInput(plan?.monthlySocialSecurityMinor ?? 0) : '')
    setEstimatedDividendInput(hasDetailedTaxes ? moneyInput(plan?.estimatedDividendMinor ?? 0) : '')
    setCorporateTaxRateInput(hasDetailedTaxes ? ((plan?.corporateTaxRateBps ?? 0) / 100).toFixed(2) : '')
    setDividendTaxRateInput(hasDetailedTaxes ? ((plan?.dividendTaxRateBps ?? 0) / 100).toFixed(2) : '')
    setSavingsGoalInput(plan ? moneyInput(plan.savingsGoalMinor) : '')
    setCompanySpendingInput(plan ? moneyInput(plan.companySpendingMinor) : '')
    setPersonalSpendingInput(plan ? moneyInput(plan.personalSpendingMinor) : '')
    setPlanComment(plan?.comment ?? '')
    setSaveError('')
  }, [plan])

  useEffect(() => { resetPlanInputs() }, [resetPlanInputs])

  const savePlan = async () => {
    if ([draftProjectedCompanyIncome, draftMonthlySalary, draftMonthlySalaryTax, draftMonthlySocialSecurity, draftEstimatedDividend, draftCorporateTaxRate, draftDividendTaxRate, draftSavingsGoal, draftPersonalSpending, draftCompanySpending].some((value) => value === null)) {
      setSaveError('Enter valid non-negative amounts with no more than two decimal places.')
      return
    }
    if (draftSpendingGoal <= 0) {
      setSaveError('Projected company income must be greater than estimated total taxes plus the savings goal.')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      await onSavePlan({
        year: currentYear,
        projectedCompanyIncomeMinor: draftProjectedCompanyIncome!,
        monthlySalaryMinor: draftMonthlySalary!,
        monthlySalaryTaxMinor: draftMonthlySalaryTax!,
        monthlySocialSecurityMinor: draftMonthlySocialSecurity!,
        estimatedDividendMinor: draftEstimatedDividend!,
        corporateTaxRateBps: draftCorporateTaxRate!,
        dividendTaxRateBps: draftDividendTaxRate!,
        savingsGoalMinor: draftSavingsGoal!,
        personalSpendingMinor: draftPersonalSpending!,
        companySpendingMinor: draftCompanySpending!,
        comment: planComment.trim(),
      })
      setEditingPlan(false)
    } catch (cause) {
      setSaveError(getErrorMessage(cause, 'Could not save the yearly financial plan.'))
    } finally {
      setSaving(false)
    }
  }

  return <section className="panel yearly-spending-plan">
    <div className="yearly-spending-heading">
      <div><span className="eyebrow">Yearly spending · {currentYear}</span><h2>Expenses so far this year</h2><p>Your spending ceiling is projected company income minus estimated total taxes and your savings goal.</p></div>
      <div className="segmented three-way yearly-scope" aria-label="Spending scope">{(['Personal', 'Company', 'Combined'] as SpendingGoalScope[]).map((item) => <button type="button" key={item} className={scope === item ? 'active transfer' : ''} aria-pressed={scope === item} onClick={() => setScope(item)}>{item}</button>)}</div>
    </div>
    {historyLoading && <div className="yearly-history-loading"><LoaderCircle size={14} />Loading complete history for an accurate year-to-date comparison…</div>}
    <div className="yearly-spending-summary">
      <div className="yearly-spent-value"><span>Spent year to date</span><strong>{formatMoney(current.expenses, defaultCurrency)}</strong><small>{goalAmount > 0 ? `${Math.round(progress)}% of ${formatMoney(goalAmount, defaultCurrency)} goal` : 'Set up this year’s financial plan'}</small><small className="taxes-excluded">{formatMoney(totalProjectedTaxes, defaultCurrency)} projected taxes · {formatMoney(current.taxes, defaultCurrency)} posted</small></div>
      <div className="yearly-progress">
        <div className="yearly-progress-track" role="img" aria-label={goalAmount > 0 ? `${Math.round(progress)}% of the goal spent; on-plan spending is ${Math.round(paceProgress)}% by today` : 'Set up the yearly financial plan to see spending pace'}><span className={progress > 100 ? 'over' : ''} style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />{goalAmount > 0 && <i className="yearly-pace-marker" style={{ left: `${Math.min(100, paceProgress)}%` }} />}</div>
        {goalAmount > 0 && <div className="yearly-progress-legend"><span><i />Spent {Math.round(progress)}%</span><span><i />On-plan today {Math.round(paceProgress)}%</span></div>}
        <div className="yearly-remaining"><span>{progress > 100 ? 'Over spending goal' : 'Remaining this year'}</span><strong className={progress > 100 ? 'negative' : ''}>{goalAmount > 0 ? formatMoney(progress > 100 ? current.expenses - goalAmount : goalAmount - current.expenses, defaultCurrency) : '—'}</strong>{goalAmount > 0 && <small className={paceDifference > 0 ? 'over-pace' : 'under-pace'}>{paceDifference === 0 ? 'On year-to-date target' : `${formatMoney(Math.abs(paceDifference), defaultCurrency)} ${paceDifference > 0 ? 'above' : 'below'} year-to-date target`}</small>}</div>
      </div>
      <div className="yearly-goal-display">
        <span>{goalLabel}<em>{goalContext}</em></span>
        <div className="yearly-goal-primary"><strong>{goalAmount > 0 ? formatMoney(goalAmount, defaultCurrency) : 'Not set'}</strong><button type="button" className="icon-button yearly-goal-edit" aria-label="Edit yearly financial plan" title="Edit plan" onClick={() => setEditingPlan(true)}><Pencil size={13} /></button></div>
        {plan && scope === 'Combined' && <small className={`yearly-saved-goal-variance ${savedGoalVariance > 0 ? 'over' : savedGoalVariance < 0 ? 'under' : ''}`}>{savedGoalVariance === 0 ? 'Matches the calculated spending limit' : `${formatWholeMoney(Math.abs(savedGoalVariance), defaultCurrency)} ${savedGoalVariance > 0 ? 'above' : 'below'} the calculated limit`}</small>}
        <div className="yearly-savings-goal"><span>Savings goal</span><strong>{plan ? formatMoney(plan.savingsGoalMinor, defaultCurrency) : 'Not set'}</strong></div>
      </div>
      {plan?.comment && <p className="yearly-plan-comment">{plan.comment}</p>}
    </div>
    {editingPlan && <div className="yearly-plan-editor">
      <div className="yearly-plan-editor-heading"><div><span className="eyebrow">Financial plan · {currentYear}</span><h3>Set the year’s limits</h3></div><button type="button" className="icon-button" aria-label="Close financial plan editor" onClick={() => { resetPlanInputs(); setEditingPlan(false) }}><X size={15} /></button></div>
      <div className="yearly-plan-inputs">
        <label><span>Projected company income</span><div><b>{defaultCurrency}</b><input autoFocus type="number" min="0" step="0.01" value={projectedCompanyIncomeInput} onChange={(event) => setProjectedCompanyIncomeInput(event.target.value)} /></div><small>Full-year company revenue, including income already received.</small></label>
        <label><span>Savings goal</span><div><b>{defaultCurrency}</b><input type="number" min="0" step="0.01" value={savingsGoalInput} onChange={(event) => setSavingsGoalInput(event.target.value)} /></div><small>What you want left after spending and total taxes.</small></label>
        <label><span>Estimated dividend</span><div><b>{defaultCurrency}</b><input type="number" min="0" step="0.01" placeholder="0" value={estimatedDividendInput} onChange={(event) => setEstimatedDividendInput(event.target.value)} /></div><small>Optional; blank is treated as zero.</small></label>
      </div>
      {plan?.legacyProjectedTaxesMinor !== undefined && <p className="yearly-plan-legacy-note">Add the tax details below to replace the previous {formatMoney(plan.legacyProjectedTaxesMinor, defaultCurrency)} total-tax estimate.</p>}
      <div className="yearly-tax-inputs">
        <label><span>Monthly salary</span><div><b>{defaultCurrency}</b><input type="number" min="0" step="0.01" placeholder="0" value={monthlySalaryInput} onChange={(event) => setMonthlySalaryInput(event.target.value)} /></div><small>Deducted from taxable corporate profit.</small></label>
        <label><span>Monthly salary tax</span><div><b>{defaultCurrency}</b><input type="number" min="0" step="0.01" placeholder="0" value={monthlySalaryTaxInput} onChange={(event) => setMonthlySalaryTaxInput(event.target.value)} /></div><small>Annualized and deducted from corporate profit.</small></label>
        <label><span>Monthly social security</span><div><b>{defaultCurrency}</b><input type="number" min="0" step="0.01" placeholder="0" value={monthlySocialSecurityInput} onChange={(event) => setMonthlySocialSecurityInput(event.target.value)} /></div><small>Annualized and deducted from corporate profit.</small></label>
        <label className="rate"><span>Corporate tax rate</span><div><input type="number" min="0" max="100" step="0.01" placeholder="0" value={corporateTaxRateInput} onChange={(event) => setCorporateTaxRateInput(event.target.value)} /><b>%</b></div><small>Applied to estimated net corporate income.</small></label>
        <label className="rate"><span>Average dividend tax</span><div><input type="number" min="0" max="100" step="0.01" placeholder="0" value={dividendTaxRateInput} onChange={(event) => setDividendTaxRateInput(event.target.value)} /><b>%</b></div><small>Flat planning rate; progressive bands are ignored.</small></label>
      </div>
      <div className="yearly-plan-allocation"><div><span className="eyebrow">Spending budgets</span><h4>Company and personal spending</h4><p>Company expenses determine taxable profit; personal spending can then be set against the remaining limit.</p></div><label><span>Company expenses</span><div><b>{defaultCurrency}</b><input type="number" min="0" step="0.01" value={companySpendingInput} onChange={(event) => setCompanySpendingInput(event.target.value)} /></div><small>Used in the corporate-tax calculation.</small></label><label><span>Personal spending</span><div><b>{defaultCurrency}</b><input type="number" min="0" step="0.01" value={personalSpendingInput} onChange={(event) => setPersonalSpendingInput(event.target.value)} /></div><small>Maximum to match savings goal: <strong>{formatWholeMoney(draftMaximumPersonalSpending, defaultCurrency)}</strong></small></label></div>
      <div className="yearly-tax-calculation">
        <div><span>Estimated net corporate income</span><strong>{formatMoney(draftTaxableCorporateIncome, defaultCurrency)}</strong><small>Company income − company expenses − annual salary, salary tax, and social security</small></div>
        <div><span>Corporate tax</span><strong>{formatMoney(draftCorporateTax, defaultCurrency)}</strong><small>{corporateTaxRateInput || '0'}% of estimated net income</small></div>
        <div><span>Dividend tax</span><strong>{formatMoney(draftDividendTax, defaultCurrency)}</strong><small>{dividendTaxRateInput || '0'}% of the estimated dividend</small></div>
        <div className="total"><span>Estimated total taxes</span><strong>{formatMoney(draftTotalTaxes, defaultCurrency)}</strong><small>Includes annual salary tax and social security; {formatMoney(postedTaxes, defaultCurrency)} already posted is not deducted again.</small></div>
      </div>
      <div className="yearly-plan-equation"><span>Projected company income</span><b>−</b><span>Estimated total taxes</span><b>−</b><span>Savings goal</span><b>=</b><strong>{formatWholeMoney(draftSpendingGoal, defaultCurrency)} calculated spending limit</strong></div>
      <label className="yearly-plan-comment-input"><span>Comment <em>Optional · 280 characters</em></span><textarea rows={3} maxLength={280} value={planComment} onChange={(event) => setPlanComment(event.target.value)} placeholder="Add a short note about this year’s plan" /></label>
      <p className={`yearly-plan-budget-variance ${draftAllocationVariance > 0 ? 'over' : draftAllocationVariance < 0 ? 'under' : 'on-goal'}`}>{draftAllocationVariance === 0 ? 'Combined budgets match the calculated spending limit' : `${formatWholeMoney(Math.abs(draftAllocationVariance), defaultCurrency)} ${draftAllocationVariance > 0 ? 'above' : 'below'} the calculated spending limit`}</p>
      {saveError && <p className="yearly-plan-error" role="alert">{saveError}</p>}
      <div className="yearly-plan-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => { resetPlanInputs(); setEditingPlan(false) }}>Cancel</button><button type="button" className="primary-button" disabled={saving} onClick={() => void savePlan()}>{saving ? 'Saving…' : 'Save financial plan'}</button></div>
    </div>}
    <button type="button" className="yearly-comparison-toggle" aria-expanded={comparisonOpen} aria-controls="yearly-comparison-content" onClick={() => setComparisonOpen((open) => !open)}><div><span className="eyebrow">Planning context</span><h3>Income and expenses by year</h3><p>Compare this year’s recorded income, spending, taxes, and net income with recent full years.</p></div><ChevronDown className={comparisonOpen ? 'expanded' : ''} size={18} /></button>
    {comparisonOpen && <div id="yearly-comparison-content">
      <div className="yearly-comparison">{comparison.map((metric) => {
        const netIncome = metric.income - metric.expenses - metric.taxes
        return <div className="yearly-comparison-row" key={metric.year}>
          <div className="yearly-comparison-year"><strong>{metric.year}</strong><span>{metric.year === currentYear ? 'So far' : 'Full year'}</span></div>
          <div className="yearly-comparison-bars"><div><span>Income</span><i><b style={{ width: `${Math.max(0, metric.income) / comparisonMaximum * 100}%` }} /></i><strong>{formatMoney(metric.income, defaultCurrency)}</strong></div><div className="expense"><span>Expenses</span><i><b style={{ width: `${Math.max(0, metric.expenses) / comparisonMaximum * 100}%` }} /></i><strong>{formatMoney(metric.expenses, defaultCurrency)}</strong></div><div className="tax"><span>Taxes</span><i><b style={{ width: `${Math.max(0, metric.taxes) / comparisonMaximum * 100}%` }} /></i><strong>{formatMoney(metric.taxes, defaultCurrency)}</strong></div><div className={`net-income ${netIncome < 0 ? 'negative-net' : ''}`}><span>Net income</span><i><b style={{ width: `${Math.abs(netIncome) / comparisonMaximum * 100}%` }} /></i><strong>{formatMoney(netIncome, defaultCurrency)}</strong></div></div>
        </div>
      })}</div>
      {plan && <div className="yearly-suggestion"><Target size={16} /><p><strong>{formatMoney(plan.savingsGoalMinor, defaultCurrency)} savings goal from {formatMoney(plan.projectedCompanyIncomeMinor, defaultCurrency)} projected company income</strong><span>{formatMoney(totalProjectedTaxes, defaultCurrency)} estimated total taxes · {formatMoney(personalSpendingGoal, defaultCurrency)} personal spending · {formatMoney(plan.companySpendingMinor, defaultCurrency)} company spending</span></p></div>}
    </div>}
  </section>
}

function OverviewPage({ accounts, defaultCurrency, totalBalance, convertBalance, personal, company, month, onOpenNetWorth, onOpenProfitAndLoss }: {
  accounts: Account[]
  defaultCurrency: string
  totalBalance: number
  convertBalance: (account: Account) => number
  personal: OverviewPnl
  company: OverviewPnl
  month: Date
  onOpenNetWorth: () => void
  onOpenProfitAndLoss: () => void
}) {
  const groupBalances = overviewBalanceGroups.map((group) => ({
    group,
    balance: accounts.filter((account) => overviewBalanceGroup(account) === group).reduce((sum, account) => sum + convertBalance(account), 0),
  }))
  const positiveGroupTotal = groupBalances.reduce((sum, item) => sum + Math.max(0, item.balance), 0)
  const combinedNetIncome = personal.net + company.net
  const scope = (label: string, values: OverviewPnl) => {
    const allocationTotal = Math.max(1, Math.max(0, values.expenses) + Math.max(0, values.tax) + Math.max(0, values.net))
    return <div className="overview-pnl-scope"><div className="overview-pnl-scope-heading"><span>{label}</span><strong className={values.net < 0 ? 'negative' : 'positive'}>{formatCompactMoney(values.net, defaultCurrency)}</strong></div><div className="overview-stack pnl-stack"><i style={{ flexGrow: Math.max(0, values.expenses) / allocationTotal }} /><i style={{ flexGrow: Math.max(0, values.tax) / allocationTotal }} /><i style={{ flexGrow: Math.max(0, values.net) / allocationTotal }} /></div><div className="overview-pnl-scope-values"><span>{label === 'Company' ? 'Revenue' : 'Income'} <b>{formatCompactMoney(values.income, defaultCurrency)}</b></span><span>Expenses <b>−{formatCompactMoney(Math.abs(values.expenses), defaultCurrency)}</b></span><span>Tax <b>−{formatCompactMoney(Math.abs(values.tax), defaultCurrency)}</b></span></div></div>
  }

  return <section className="overview-summary">
    <div className="overview-heading"><span className="eyebrow">At a glance</span><h2>Your finances</h2><p>Current net worth and activity for {monthName.format(month)}. Open either summary for the full detail.</p></div>
    <div className="overview-summary-grid">
      <button type="button" className="overview-summary-card" onClick={onOpenNetWorth}>
        <div className="overview-card-heading"><span>Current net worth</span><WalletCards size={18} /></div>
        <div className="overview-primary-value"><strong>{formatMoney(totalBalance, defaultCurrency)}</strong><small>{accounts.length} account{accounts.length === 1 ? '' : 's'}</small></div>
        <div className="overview-stack" role="img" aria-label={`Net worth composition: ${groupBalances.map((item) => `${item.group} ${formatMoney(item.balance, defaultCurrency)}`).join(', ')}`}>
          {groupBalances.map((item) => <i key={item.group} style={{ flexGrow: positiveGroupTotal ? Math.max(0, item.balance) / positiveGroupTotal : 1 }} />)}
        </div>
        <div className="overview-breakdown five-columns">{groupBalances.map((item) => <div key={item.group}><span>{item.group}</span><strong>{formatCompactMoney(item.balance, defaultCurrency)}</strong></div>)}</div>
        <span className="overview-open">View balance sheet <ArrowRight size={15} /></span>
      </button>

      <button type="button" className="overview-summary-card" onClick={onOpenProfitAndLoss}>
        <div className="overview-card-heading"><span>Profit &amp; loss · {new Intl.DateTimeFormat('en', { month: 'long' }).format(month)}</span><BarChart3 size={18} /></div>
        <div className="overview-primary-value"><strong className={combinedNetIncome < 0 ? 'negative' : 'positive'}>{formatMoney(combinedNetIncome, defaultCurrency)}</strong><small>Combined net income</small></div>
        <div className="overview-pnl-scopes">{scope('Personal', personal)}{scope('Company', company)}</div>
        <span className="overview-open">View report <ArrowRight size={15} /></span>
      </button>
    </div>
  </section>
}

function BudgetsPage({ categories, categoryGroups, categorySpending, budgetForCategory, showHiddenActivityAlert, onAdd, onManageGroups, onSelectCategory, onUnhideCategory }: {
  categories: Category[]; categoryGroups: CategoryGroup[]; categorySpending: (id: string) => number; budgetForCategory: (id: string) => number
  showHiddenActivityAlert: boolean
  onAdd: () => void; onManageGroups: () => void; onSelectCategory: (id: string) => void; onUnhideCategory: (id: string) => Promise<void>
}) {
  const [showHiddenOnly, setShowHiddenOnly] = useState(false)
  const visibleCategories = categories.filter((category) => !category.hidden)
  const hiddenCategories = categories.filter((category) => category.hidden)
  const personalIncomeCategories = visibleCategories.filter((category) => category.reportGroup === 'personal_income')
  const personalExpenseCategories = visibleCategories.filter((category) => category.reportGroup === 'personal_expense')
  const companyRevenueCategories = visibleCategories.filter((category) => category.reportGroup === 'company_revenue')
  const companyExpenseCategories = visibleCategories.filter((category) => category.reportGroup === 'company_expense')
  const personalTaxCategories = visibleCategories.filter((category) => category.reportGroup === 'personal_tax')
  const companyTaxCategories = visibleCategories.filter((category) => category.reportGroup === 'company_tax')
  const groupedRows = (rows: Category[]) => {
    const byOrder = (left: Category, right: Category) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.name.localeCompare(right.name)
    const knownGroups = categoryGroups.map((group) => ({ group, rows: rows.filter((category) => category.categoryGroupId === group.id).sort(byOrder) })).filter((item) => item.rows.length > 0)
    const ungrouped = rows.filter((category) => !category.categoryGroupId || !categoryGroups.some((group) => group.id === category.categoryGroupId)).sort(byOrder)
    return [...knownGroups, ...(ungrouped.length ? [{ group: { id: 'ungrouped', name: 'Other', sortOrder: 999, showCategories: true }, rows: ungrouped }] : [])]
  }
  const section = (title: string, subtitle: string, rows: Category[]) => <section className="budget-section"><div className="budget-section-heading"><div><h3>{title}</h3><span>{subtitle}</span></div></div>{groupedRows(rows).map(({ group, rows: groupCategories }) => <div className="category-group-block" key={group.id}><div className="category-group-label">{group.name}</div><div className="category-list roomy">{groupCategories.map((category) => <CategoryRow key={category.id} category={category} spent={categorySpending(category.id)} budget={budgetForCategory(category.id)} onSelect={() => onSelectCategory(category.id)} />)}</div></div>)}</section>
  const hiddenSection = <section className="budget-section"><div className="budget-section-heading"><div><h3>Hidden categories</h3><span>Unhide categories you want to return to active planning and new transactions</span></div></div>{groupedRows(hiddenCategories).map(({ group, rows }) => <div className="category-group-block" key={group.id}><div className="category-group-label">{group.name}</div><div className="category-list roomy">{rows.map((category) => <HiddenCategoryBudgetRow key={category.id} category={category} spent={categorySpending(category.id)} budget={budgetForCategory(category.id)} onSelect={() => onSelectCategory(category.id)} onUnhide={() => onUnhideCategory(category.id)} />)}</div></div>)}</section>
  return <section className="budget-planning">
    <HiddenCategoryActivityAlert categories={categories} categorySpending={categorySpending} onSelectCategory={onSelectCategory} prominent={showHiddenActivityAlert} />
    <div className="panel full-panel"><div className="panel-heading"><div><span className="eyebrow">Monthly plan</span><h2>{showHiddenOnly ? 'Hidden categories' : 'Budget by category'}</h2></div><div className="budget-page-actions">{hiddenCategories.length > 0 && <button className="text-button" onClick={() => setShowHiddenOnly((current) => !current)}>{showHiddenOnly ? <EyeOff size={16} /> : <Eye size={16} />}{showHiddenOnly ? 'Show active categories' : `Show hidden only (${hiddenCategories.length})`}</button>}<button className="secondary-button" onClick={onManageGroups}><Settings size={16} />Manage groups</button><button className="secondary-button" onClick={onAdd}><Plus size={17} />New category</button></div></div>{showHiddenOnly ? hiddenSection : <>{section('Personal income', 'Actual personal income compared with this month’s plan', personalIncomeCategories)}{section('Personal expenses', 'Personal spending compared with this month’s budget', personalExpenseCategories)}{personalTaxCategories.length > 0 && section('Personal taxes', 'Personal tax costs compared with this month’s plan', personalTaxCategories)}{section('Company revenue', 'Actual company revenue compared with this month’s plan', companyRevenueCategories)}{section('Company expenses', 'Company spending compared with this month’s budget', companyExpenseCategories)}{companyTaxCategories.length > 0 && section('Company taxes', 'Company tax costs compared with this month’s plan', companyTaxCategories)}</>}</div>
  </section>
}

type ReportPeriod = 'month' | 'year'
type ValuationGroup = 'investments' | 'real-estate' | 'other-assets'
type PnlScope = 'combined' | 'personal' | 'company'
type PnlMetric = 'income' | 'expenses' | 'taxes' | 'netIncome'
type PnlHistoryPoint = { key: string; label: string; income: number; expenses: number; taxes: number; netIncome: number }
const pnlMetricDefinitions: { id: PnlMetric; label: string }[] = [{ id: 'income', label: 'Income' }, { id: 'expenses', label: 'Expenses' }, { id: 'taxes', label: 'Taxes' }, { id: 'netIncome', label: 'Net income' }]

function ReportsPage({ data, viewedMonth, defaultCurrency, view, historyLoading, onChangeView, onUpdateTaxRate, onEditTransaction }: { data: AppData; viewedMonth: Date; defaultCurrency: string; view: ReportView; historyLoading: boolean; onChangeView: (view: ReportView) => void; onUpdateTaxRate: (rateBps: number) => void; onEditTransaction: (transaction: Transaction) => void }) {
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
  const budgetInPeriod = (month: string) => period === 'month' ? month === monthKey : month.startsWith(yearKey)
  const reportBudgets = data.budgets.filter((budget) => budgetInPeriod(budget.month))

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

function AccountsPage({ accounts, pendingImportCounts, totalBalance, defaultCurrency, convertBalance, onAdd, onSelectAccount, onReorder }: { accounts: Account[]; pendingImportCounts: Map<string, number>; totalBalance: number; defaultCurrency: string; convertBalance: (account: Account) => number; onAdd: () => void; onSelectAccount: (id: string) => void; onReorder: (accountIds: string[]) => Promise<boolean> }) {
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
  const groupedAccounts = balanceSheetGroups.map((group) => ({ group, accounts: orderedAccounts.filter((account) => accountBalanceSheetGroup(account) === group) })).filter(({ accounts: rows }) => rows.length > 0)

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
      <div><span className="eyebrow">Provisional {defaultCurrency} net worth</span><strong>{formatMoney(totalBalance, defaultCurrency)}</strong></div>
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
    {reordering ? <div className="account-card-grid reordering">
      {orderedAccounts.map((account, index) => (
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
          <div className="large-account-name"><h3>{account.name}</h3>{account.providerAccountId && <BankImportConnectedIcon pendingCount={pendingImportCounts.get(account.id)} />}</div><strong>{formatMoney(account.balanceMinor, account.currency)}</strong><p>{accountBalanceSheetGroup(account)} · {account.type} · {account.currency}</p>
          <div className="reorder-card-actions">
            <button className="icon-button" onClick={() => moveAccount(account.id, -1)} disabled={index === 0} aria-label={`Move ${account.name} earlier`}><ArrowUp size={16} /></button>
            <button className="icon-button" onClick={() => moveAccount(account.id, 1)} disabled={index === orderedAccounts.length - 1} aria-label={`Move ${account.name} later`}><ArrowDown size={16} /></button>
          </div>
        </div>
      ))}
    </div> : <div className="balance-sheet-groups">
      {groupedAccounts.map(({ group, accounts: rows }) => {
        const groupBalance = rows.reduce((sum, account) => sum + convertBalance(account), 0)
        return <section className="balance-sheet-group" key={group}>
          <div className="balance-sheet-group-heading"><div><span className="eyebrow">Balance sheet</span><h2>{group}</h2></div><strong>{formatMoney(groupBalance, defaultCurrency)}</strong></div>
          <div className="account-card-grid">{rows.map((account) => <button type="button" className="large-account-card" key={account.id} onClick={() => onSelectAccount(account.id)} aria-label={`View ${account.name} transactions`}><div className="large-account-top"><span style={{ background: account.color }}><Banknote size={20} /></span><small>{accountBalanceSheetGroup(account)} · {account.type}</small></div><div className="large-account-name"><h3>{account.name}</h3>{account.providerAccountId && <BankImportConnectedIcon pendingCount={pendingImportCounts.get(account.id)} />}</div><strong>{formatMoney(account.balanceMinor, account.currency)}</strong><p>Provisional balance · {account.currency}</p></button>)}</div>
        </section>
      })}
    </div>}
  </div>
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}><div className="modal"><div className="modal-heading"><div><span className="eyebrow">Next Expense</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>{children}</div></div>
}

function AccountDetailPage({ account, transactions, allTransactions, candidates, categories, payees, mappings, accounts, historyLoaded, historyLoading, onRequestHistory, onBack, onSelectAccount, onEditAccount, onAdjustBalance, onLinkBank, onSyncBank, onImportModeChange, onReviewCandidate, onPostTransfer, onRematchPayees, onCreatePayee, onPromoteMapping, onAddAlternativeName, onUnhideCategory, onEditTransaction, reviewingCandidateId, rematchingPayees, syncing, syncNotice }: { account: Account; transactions: Transaction[]; allTransactions: Transaction[]; candidates: BankImportCandidate[]; categories: Category[]; payees: Payee[]; mappings: PayeeMapping[]; accounts: Account[]; historyLoaded: boolean; historyLoading: boolean; onRequestHistory: () => Promise<void>; onBack: () => void; onSelectAccount: (id: string) => void; onEditAccount: () => void; onAdjustBalance: () => void; onLinkBank: () => void; onSyncBank: () => void; onImportModeChange: (mode: 'review' | 'automatic') => void; onReviewCandidate: (candidateId: string, decision: 'approve' | 'reject', categoryId?: string, rememberCategory?: boolean, payeeId?: string | null, rememberMapping?: boolean, bankDescription?: string, createdPayee?: boolean, defaultAccountId?: string) => void; onPostTransfer: (candidateId: string, counterpartyAccountId: string) => Promise<void>; onRematchPayees: () => void; onCreatePayee: (name: string, categoryId: string, accountId: string) => Promise<Payee>; onPromoteMapping: (mappingId: string) => Promise<void>; onAddAlternativeName: (sourceName: string, payeeId: string) => Promise<void>; onUnhideCategory: (categoryId: string) => Promise<void>; onEditTransaction: (transaction: Transaction) => void; reviewingCandidateId: string; rematchingPayees: boolean; syncing: boolean; syncNotice: string }) {
  return <div className="page-content narrow-page entity-page">
    <div className="entity-page-toolbar">
      <button className="entity-back" onClick={onBack}><ChevronLeft size={16} />All accounts</button>
      <label><span>Account</span><select value={account.id} onChange={(event) => onSelectAccount(event.target.value)}>{accounts.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
    </div>
    <section className="panel entity-detail-panel">
      <div className="entity-heading"><div className="entity-heading-icon" style={{ background: account.color }}><CreditCard size={20} /></div><div><span className="eyebrow">{accountBalanceSheetGroup(account)} · {account.type}{account.providerAccountId ? ' · Bank connected' : ''}</span><div className="entity-heading-title"><h2>{account.name}</h2>{accountIsReconciled(account) && <AccountReconciledIndicator label />}</div></div><div className="entity-heading-actions"><button className="secondary-button" onClick={onAdjustBalance}><RefreshCw size={16} />Adjust balance</button><button className="secondary-button" onClick={onEditAccount}><Pencil size={16} />Edit account</button>{account.providerAccountId && <button className="primary-button" disabled={syncing} onClick={onSyncBank}>{syncing ? <LoaderCircle className="spin-icon" size={16} /> : <RefreshCw size={16} />}{syncing ? 'Syncing…' : 'Sync now'}</button>}<button className="secondary-button" onClick={onLinkBank}><Link2 size={16} />{account.providerAccountId ? 'Reconnect' : 'Connect bank'}</button></div></div>
      {account.providerAccountId && <div className="bank-sync-status"><div><strong>{account.connectionStatus === 'active' ? 'Bank connection active' : 'Bank connected'}</strong><span>{account.lastSyncedAt ? `Last synced ${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(account.lastSyncedAt))}` : 'Not synced yet'}</span>{account.lastSyncDiagnostic && !syncNotice && <span>{formatSyncDiagnostic(account.lastSyncDiagnostic)}</span>}</div><span>{syncNotice || formatRateLimits(account)}</span></div>}
      {account.providerAccountId && <BankImportReview account={account} accounts={accounts} transactions={transactions} candidates={candidates} categories={categories} payees={payees} mappings={mappings} reviewingCandidateId={reviewingCandidateId} rematchingPayees={rematchingPayees} onModeChange={onImportModeChange} onReview={onReviewCandidate} onPostTransfer={onPostTransfer} onRematchPayees={onRematchPayees} onCreatePayee={onCreatePayee} onPromoteMapping={onPromoteMapping} onAddAlternativeName={onAddAlternativeName} onUnhideCategory={onUnhideCategory} />}
      <AccountDetail account={account} transactions={transactions} allTransactions={allTransactions} categories={categories} accounts={accounts} historyLoaded={historyLoaded} historyLoading={historyLoading} onRequestHistory={onRequestHistory} onEditTransaction={onEditTransaction} />
    </section>
  </div>
}

function CategoryLabel({ category }: { category: Category }) {
  const Icon = categoryIcons[category.icon as keyof typeof categoryIcons] ?? Sparkles
  return <span className="picker-category-label"><i style={{ color: category.color, background: `${category.color}18` }}><Icon size={13} /></i><span>{category.name}</span>{category.hidden && <em>Hidden</em>}</span>
}

function PayeeSearchPicker({ ariaLabel, value, payees, categories, allowEmpty = false, onChange, onCreate }: { ariaLabel: string; value: string; payees: Payee[]; categories: Category[]; allowEmpty?: boolean; onChange: (value: string) => void; onCreate?: (name: string) => Promise<void> }) {
  const selected = payees.find((payee) => payee.id === value)
  const [query, setQuery] = useState(selected?.name ?? '')
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  useEffect(() => setQuery(selected?.name ?? ''), [selected?.name])
  const normalizedQuery = query.trim().toLocaleLowerCase('en')
  const options = [...payees].filter((payee) => !normalizedQuery || payee.name.toLocaleLowerCase('en').includes(normalizedQuery)).sort((left, right) => left.name.localeCompare(right.name)).slice(0, 20)
  const exactMatch = payees.some((payee) => payee.name.localeCompare(query.trim(), undefined, { sensitivity: 'accent' }) === 0)

  return <div className="search-picker">
    <Search size={14} />
    <input aria-label={ariaLabel} role="combobox" aria-expanded={open} autoComplete="off" placeholder="Search payees…" value={query} onFocus={(event) => { setOpen(true); event.currentTarget.select() }} onBlur={() => { setOpen(false); setQuery(selected?.name ?? '') }} onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); event.currentTarget.blur() } }} onChange={(event) => { setQuery(event.target.value); setOpen(true) }} />
    <ChevronDown size={14} />
    {open && <div className="search-picker-options" role="listbox">
      {allowEmpty && <button type="button" role="option" aria-selected={!value} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(''); setQuery(''); setOpen(false) }}><span className="picker-option-copy"><strong>Create from bank description</strong><small>A registered payee will be created on approval</small></span></button>}
      {options.map((payee) => {
        const defaultCategory = categories.find((category) => category.id === payee.defaultCategoryId)
        return <button type="button" role="option" aria-selected={payee.id === value} key={payee.id} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(payee.id); setQuery(payee.name); setOpen(false) }}><span className="picker-option-copy"><strong>{payee.name}</strong><small>{defaultCategory ? 'Default category' : 'No default category'}</small></span>{defaultCategory && <CategoryLabel category={defaultCategory} />}{payee.id === value && <Check className="picker-check" size={14} />}</button>
      })}
      {onCreate && query.trim() && !exactMatch && <button className="picker-create-option" type="button" disabled={creating} onMouseDown={(event) => event.preventDefault()} onClick={async () => { const name = query.trim(); setCreating(true); setCreateError(''); try { await onCreate(name); setQuery(name); setOpen(false) } catch (error) { setCreateError(getErrorMessage(error, 'Could not create this payee.')) } finally { setCreating(false) } }}><Plus size={14} /><span className="picker-option-copy"><strong>{creating ? 'Creating…' : `Create “${query.trim()}”`}</strong><small>Add this name to the payee register</small></span></button>}
      {!options.length && (!onCreate || !query.trim()) && <span className="picker-empty">No matching payees</span>}
      {createError && <span className="picker-error" role="alert">{createError}</span>}
    </div>}
  </div>
}

function CategorySearchPicker({ ariaLabel, value, categories, allowEmpty = false, onChange }: { ariaLabel: string; value: string; categories: Category[]; allowEmpty?: boolean; onChange: (value: string) => void }) {
  const selected = categories.find((category) => category.id === value)
  const [query, setQuery] = useState(selected?.name ?? '')
  const [open, setOpen] = useState(false)
  useEffect(() => setQuery(selected?.name ?? ''), [selected?.name])
  const normalizedQuery = query.trim().toLocaleLowerCase('en')
  const options = [...categories].filter((category) => !normalizedQuery || category.name.toLocaleLowerCase('en').includes(normalizedQuery)).sort((left, right) => left.name.localeCompare(right.name))

  return <div className="search-picker category-search-picker">
    <Search size={14} />
    <input aria-label={ariaLabel} role="combobox" aria-expanded={open} autoComplete="off" placeholder="Search categories…" value={query} onFocus={(event) => { setOpen(true); event.currentTarget.select() }} onBlur={() => { setOpen(false); setQuery(selected?.name ?? '') }} onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); event.currentTarget.blur() } }} onChange={(event) => { setQuery(event.target.value); setOpen(true) }} />
    <ChevronDown size={14} />
    {open && <div className="search-picker-options" role="listbox">
      {allowEmpty && <button type="button" role="option" aria-selected={!value} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(''); setQuery(''); setOpen(false) }}><span className="picker-option-copy"><strong>No default category</strong><small>Choose each time</small></span>{!value && <Check className="picker-check" size={14} />}</button>}
      {options.map((category) => <button type="button" role="option" aria-selected={category.id === value} key={category.id} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(category.id); setQuery(category.name); setOpen(false) }}><CategoryLabel category={category} />{category.id === value && <Check className="picker-check" size={14} />}</button>)}
      {!options.length && <span className="picker-empty">No matching categories</span>}
    </div>}
  </div>
}

function BankImportReview({ account, accounts, transactions, candidates, categories, payees, mappings, reviewingCandidateId, rematchingPayees, onModeChange, onReview, onPostTransfer, onRematchPayees, onCreatePayee, onPromoteMapping, onAddAlternativeName, onUnhideCategory }: { account: Account; accounts: Account[]; transactions: Transaction[]; candidates: BankImportCandidate[]; categories: Category[]; payees: Payee[]; mappings: PayeeMapping[]; reviewingCandidateId: string; rematchingPayees: boolean; onModeChange: (mode: 'review' | 'automatic') => void; onReview: (candidateId: string, decision: 'approve' | 'reject', categoryId?: string, rememberCategory?: boolean, payeeId?: string | null, rememberMapping?: boolean, bankDescription?: string, createdPayee?: boolean, defaultAccountId?: string) => void; onPostTransfer: (candidateId: string, counterpartyAccountId: string) => Promise<void>; onRematchPayees: () => void; onCreatePayee: (name: string, categoryId: string, accountId: string) => Promise<Payee>; onPromoteMapping: (mappingId: string) => Promise<void>; onAddAlternativeName: (sourceName: string, payeeId: string) => Promise<void>; onUnhideCategory: (categoryId: string) => Promise<void> }) {
  const mode = account.bankImportMode ?? 'review'
  const [categoryAssignments, setCategoryAssignments] = useState<Record<string, string>>({})
  const [payeeAssignments, setPayeeAssignments] = useState<Record<string, string>>({})
  const [rememberChoices, setRememberChoices] = useState<Record<string, boolean>>({})
  const [mappingChoices, setMappingChoices] = useState<Record<string, boolean>>({})
  const [createdPayeeIds, setCreatedPayeeIds] = useState<Record<string, string>>({})
  const [promotingMappingId, setPromotingMappingId] = useState('')
  const [addingAlternativeNameId, setAddingAlternativeNameId] = useState('')
  const [unhidingCategoryId, setUnhidingCategoryId] = useState('')
  const [transferCandidateId, setTransferCandidateId] = useState('')
  const [transferAccountAssignments, setTransferAccountAssignments] = useState<Record<string, string>>({})
  const pendingNet = candidates.reduce((sum, candidate) => sum + (candidate.type === 'income' ? candidate.amountMinor : -candidate.amountMinor), 0)
  const availableCategories = categories.filter((category) => !category.hidden)
  return <section className="bank-import-review">
    <div className="bank-import-review-heading">
      <div><span className="eyebrow">New bank transactions</span><strong>{mode === 'review' ? 'Review before adding' : 'Add categorized transactions automatically'}</strong><p>{mode === 'review' ? 'Choose a category before each transaction enters the ledger. Duplicates and confident transfers are still handled automatically.' : 'Transactions with a saved payee category are added automatically; the rest wait here for review.'}</p></div>
      <div className="segmented bank-import-mode" aria-label="Bank transaction import mode">
        <button type="button" className={mode === 'review' ? 'active transfer' : ''} onClick={() => onModeChange('review')}>Review first</button>
        <button type="button" className={mode === 'automatic' ? 'active income' : ''} onClick={() => onModeChange('automatic')}>Add automatically</button>
      </div>
    </div>
    {candidates.length > 0 && <div className="bank-review-queue">
      <div className="bank-review-summary"><strong>{candidates.length} awaiting review</strong><span>Net effect if approved: {formatMoney(pendingNet, account.currency)}</span><button type="button" className="secondary-button" disabled={rematchingPayees || Boolean(reviewingCandidateId)} onClick={onRematchPayees}><RefreshCw className={rematchingPayees ? 'spin-icon' : ''} size={14} />{rematchingPayees ? 'Checking…' : 'Recheck payees'}</button></div>
      {candidates.map((candidate) => {
        const payeeId = payeeAssignments[candidate.id] ?? candidate.payeeId ?? ''
        const selectedPayee = payees.find((payee) => payee.id === payeeId)
        const payeeDefaultCategory = categories.find((category) => category.id === selectedPayee?.defaultCategoryId)
        const categoryId = categoryAssignments[candidate.id] ?? candidate.categoryId ?? ''
        const rememberCategory = rememberChoices[candidate.id] ?? Boolean(payeeId)
        const payeeWasChanged = Object.prototype.hasOwnProperty.call(payeeAssignments, candidate.id) && payeeId !== (candidate.payeeId ?? '')
        const normalizedBankDescription = candidate.payee.normalize('NFKC').trim().toLocaleLowerCase('en')
        const alreadyMappedToSelectedPayee = mappings.some((mapping) => mapping.payeeId === payeeId && mapping.sourceName.normalize('NFKC').trim().toLocaleLowerCase('en') === normalizedBankDescription)
        const offerMapping = Boolean(payeeId && payeeWasChanged && !alreadyMappedToSelectedPayee)
        const rememberMapping = mappingChoices[candidate.id] ?? true
        const selectedCategory = categories.find((category) => category.id === categoryId)
        const hiddenCategory = selectedCategory?.hidden ? selectedCategory : undefined
        const distinctNote = candidate.note?.trim().toLocaleLowerCase('en') === candidate.payee.trim().toLocaleLowerCase('en') ? '' : candidate.note
        const suggestedMapping = (() => {
          if (payeeId) return undefined
          const sourceTexts = [candidate.payee, candidate.note ?? ''].filter(Boolean)
          const candidates = mappings.flatMap((mapping) => mapping.matchType === 'exact' ? sourceTexts.filter((sourceText) => prefixMappingMatches(normalizedPayeeName(sourceText), normalizedPayeeName(mapping.sourceName))).map((sourceText) => ({ mapping, sourceText })) : []).sort((left, right) => normalizedPayeeName(right.mapping.sourceName).length - normalizedPayeeName(left.mapping.sourceName).length)
          if (!candidates.length) return undefined
          const longestLength = normalizedPayeeName(candidates[0].mapping.sourceName).length
          const longest = candidates.filter(({ mapping }) => normalizedPayeeName(mapping.sourceName).length === longestLength)
          return new Set(longest.map(({ mapping }) => mapping.payeeId)).size === 1 ? longest[0] : undefined
        })()
        const suggestedPayee = payees.find((payee) => payee.id === suggestedMapping?.mapping.payeeId)
        const transferMode = transferCandidateId === candidate.id
        const eligibleTransferAccounts = accounts.filter((item) => item.id !== account.id && !item.closed && item.currency === candidate.currency)
        const transferAccountId = transferAccountAssignments[candidate.id] ?? eligibleTransferAccounts[0]?.id ?? ''
        const possibleExistingTransfers = transactions.filter((transaction) => {
          if (transaction.type !== 'transfer' || transaction.currency !== candidate.currency) return false
          const daysApart = Math.abs(Date.parse(`${transaction.date}T12:00:00Z`) - Date.parse(`${candidate.date}T12:00:00Z`)) / 86_400_000
          if (daysApart > 3) return false
          return candidate.type === 'expense'
            ? transaction.accountId === account.id && transaction.amountMinor === candidate.amountMinor
            : transaction.toAccountId === account.id && (transaction.destinationAmountMinor ?? transaction.amountMinor) === candidate.amountMinor
        })
        const closestDistance = possibleExistingTransfers.length ? Math.min(...possibleExistingTransfers.map((transaction) => Math.abs(Date.parse(`${transaction.date}T12:00:00Z`) - Date.parse(`${candidate.date}T12:00:00Z`)))) : undefined
        const closestExistingTransfers = closestDistance === undefined ? [] : possibleExistingTransfers.filter((transaction) => Math.abs(Date.parse(`${transaction.date}T12:00:00Z`) - Date.parse(`${candidate.date}T12:00:00Z`)) === closestDistance)
        const existingTransfer = closestExistingTransfers.length === 1 ? closestExistingTransfers[0] : undefined
        const existingTransferCounterpartyId = existingTransfer ? (candidate.type === 'expense' ? existingTransfer.toAccountId : existingTransfer.accountId) : undefined
        const existingTransferCounterparty = accounts.find((item) => item.id === existingTransferCounterpartyId)
        return <div className="bank-review-row" key={candidate.id}>
          <div className="bank-review-description"><strong>{selectedPayee?.name ?? candidate.payee}{candidate.posted ? null : <em className="pending-badge">Pending</em>}</strong><span>{formatShortDate(candidate.date)} · {selectedPayee ? `Bank: ${candidate.payee}` : 'Bank description'}{distinctNote ? ` · ${distinctNote}` : ''}</span><div className="bank-review-description-actions"><em className={selectedPayee ? 'payee-match-badge matched' : 'payee-match-badge'}>{selectedPayee ? 'Matched payee' : 'New payee on approval'}</em>{!transferMode && existingTransfer && existingTransferCounterpartyId && existingTransferCounterparty ? <button type="button" disabled={Boolean(reviewingCandidateId)} onClick={() => void onPostTransfer(candidate.id, existingTransferCounterpartyId)}><ArrowLeftRight size={12} />Match existing transfer to {existingTransferCounterparty.name}</button> : !transferMode && eligibleTransferAccounts.length > 0 && <button type="button" disabled={Boolean(reviewingCandidateId)} onClick={() => setTransferCandidateId(candidate.id)}><ArrowLeftRight size={12} />Post as transfer</button>}</div></div>
          <b className={candidate.type === 'income' ? 'positive' : ''}>{candidate.type === 'income' ? '+' : '−'}{formatMoney(candidate.amountMinor, candidate.currency)}</b>
          {transferMode ? <div className="bank-review-transfer-choice">
            <label><span>{candidate.type === 'expense' ? 'Transfer to account' : 'Transfer from account'}</span><select aria-label={`${candidate.type === 'expense' ? 'Destination' : 'Source'} account for ${candidate.payee}`} value={transferAccountId} onChange={(event) => setTransferAccountAssignments((current) => ({ ...current, [candidate.id]: event.target.value }))}>{eligibleTransferAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <p>This will create one transfer and retain this bank transaction as its {candidate.type === 'expense' ? 'outgoing' : 'incoming'} bank leg.</p>
            {!eligibleTransferAccounts.length && <span className="auth-error">No other active {candidate.currency} account is available.</span>}
          </div> : <><div className="bank-review-payee">
            <PayeeSearchPicker ariaLabel={`Payee for ${candidate.payee}`} value={payeeId} payees={payees} categories={categories} allowEmpty onCreate={async (name) => {
              const createdPayee = await onCreatePayee(name, categoryId, account.id)
              const nextDefault = categories.find((category) => category.id === createdPayee.defaultCategoryId)
              setPayeeAssignments((current) => ({ ...current, [candidate.id]: createdPayee.id }))
              setCreatedPayeeIds((current) => ({ ...current, [candidate.id]: createdPayee.id }))
              setRememberChoices((current) => ({ ...current, [candidate.id]: true }))
              setMappingChoices((current) => ({ ...current, [candidate.id]: true }))
              if (nextDefault) setCategoryAssignments((current) => ({ ...current, [candidate.id]: nextDefault.id }))
            }} onChange={(nextPayeeId) => {
              const nextPayee = payees.find((payee) => payee.id === nextPayeeId)
              const nextDefault = categories.find((category) => category.id === nextPayee?.defaultCategoryId)
              setPayeeAssignments((current) => ({ ...current, [candidate.id]: nextPayeeId }))
              setRememberChoices((current) => ({ ...current, [candidate.id]: Boolean(nextPayeeId) }))
              setMappingChoices((current) => ({ ...current, [candidate.id]: Boolean(nextPayeeId) }))
              if (nextDefault) setCategoryAssignments((current) => ({ ...current, [candidate.id]: nextDefault.id }))
            }} />
            <span className="payee-default-summary">Default category: {payeeDefaultCategory ? <CategoryLabel category={payeeDefaultCategory} /> : 'None'}</span>
            {payeeDefaultCategory && payeeDefaultCategory.id !== categoryId && !payeeDefaultCategory.hidden && <button type="button" onClick={() => setCategoryAssignments((current) => ({ ...current, [candidate.id]: payeeDefaultCategory.id }))}>Use default</button>}
            {suggestedMapping && suggestedPayee && <div className="prefix-match-suggestion"><Sparkles size={13} /><p><strong>Possible match: {suggestedPayee.name}</strong><span>“{suggestedMapping.mapping.sourceName}” matches the start of the {suggestedMapping.sourceText === candidate.note ? 'bank memo' : 'bank description'}.</span><span className="prefix-match-actions"><button type="button" disabled={Boolean(promotingMappingId || addingAlternativeNameId)} onClick={async () => {
              setPromotingMappingId(suggestedMapping.mapping.id)
              try {
                await onPromoteMapping(suggestedMapping.mapping.id)
                const nextDefault = categories.find((category) => category.id === suggestedPayee.defaultCategoryId)
                setPayeeAssignments((current) => ({ ...current, [candidate.id]: suggestedPayee.id }))
                setRememberChoices((current) => ({ ...current, [candidate.id]: Boolean(suggestedPayee.id) }))
                setMappingChoices((current) => ({ ...current, [candidate.id]: false }))
                if (nextDefault) setCategoryAssignments((current) => ({ ...current, [candidate.id]: nextDefault.id }))
              } finally {
                setPromotingMappingId('')
              }
            }}>{promotingMappingId === suggestedMapping.mapping.id ? 'Updating…' : 'Use Starts with and select payee'}</button><button type="button" disabled={Boolean(promotingMappingId || addingAlternativeNameId)} onClick={async () => {
              setAddingAlternativeNameId(candidate.id)
              try {
                await onAddAlternativeName(suggestedMapping.sourceText, suggestedPayee.id)
                const nextDefault = categories.find((category) => category.id === suggestedPayee.defaultCategoryId)
                setPayeeAssignments((current) => ({ ...current, [candidate.id]: suggestedPayee.id }))
                setRememberChoices((current) => ({ ...current, [candidate.id]: Boolean(suggestedPayee.id) }))
                setMappingChoices((current) => ({ ...current, [candidate.id]: false }))
                if (nextDefault) setCategoryAssignments((current) => ({ ...current, [candidate.id]: nextDefault.id }))
              } finally {
                setAddingAlternativeNameId('')
              }
            }}>{addingAlternativeNameId === candidate.id ? 'Adding…' : 'Add to alternative names and select payee'}</button></span></p></div>}
            {offerMapping && <label className="remember-category remember-mapping"><input type="checkbox" checked={rememberMapping} onChange={(event) => setMappingChoices((current) => ({ ...current, [candidate.id]: event.target.checked }))} /><span>Remember “{candidate.payee}” as an alternative name for <strong>{selectedPayee?.name}</strong></span></label>}
          </div>
          <div className="bank-review-category">
            <CategorySearchPicker ariaLabel={`Category for ${candidate.payee}`} value={categoryId} categories={hiddenCategory ? [hiddenCategory, ...availableCategories] : availableCategories} onChange={(nextCategoryId) => { setCategoryAssignments((current) => ({ ...current, [candidate.id]: nextCategoryId })); setRememberChoices((current) => ({ ...current, [candidate.id]: Boolean(payeeId && selectedPayee?.defaultCategoryId !== nextCategoryId) })) }} />
            {payeeId && selectedPayee?.defaultCategoryId !== categoryId && <label className="remember-category"><input type="checkbox" checked={rememberCategory} onChange={(event) => setRememberChoices((current) => ({ ...current, [candidate.id]: event.target.checked }))} />Make this the default category for {selectedPayee?.name}</label>}
            {hiddenCategory && <div className="hidden-category-warning"><ShieldAlert size={14} /><p><strong>{hiddenCategory.name} is hidden.</strong> Choose an active category and remember it for this payee, or <button type="button" disabled={Boolean(unhidingCategoryId)} onClick={async () => {
              setUnhidingCategoryId(hiddenCategory.id)
              try {
                await onUnhideCategory(hiddenCategory.id)
              } finally {
                setUnhidingCategoryId('')
              }
            }}>{unhidingCategoryId === hiddenCategory.id ? 'unhiding…' : 'unhide this category'}</button>.</p></div>}
          </div></>}
          <div className="bank-review-actions">
            {transferMode ? <>
              <button className="secondary-button" type="button" disabled={Boolean(reviewingCandidateId)} onClick={() => setTransferCandidateId('')}><X size={14} />Cancel</button>
              <button className="primary-button" type="button" disabled={!transferAccountId || Boolean(reviewingCandidateId)} onClick={() => void onPostTransfer(candidate.id, transferAccountId)}>{reviewingCandidateId === candidate.id ? <LoaderCircle className="spin-icon" size={14} /> : <ArrowLeftRight size={14} />}Post transfer</button>
            </> : <>
              <button className="secondary-button" type="button" disabled={Boolean(reviewingCandidateId)} onClick={() => onReview(candidate.id, 'reject')}><X size={14} />Reject</button>
              <button className="primary-button" type="button" disabled={!categoryId || Boolean(hiddenCategory) || Boolean(reviewingCandidateId)} onClick={() => onReview(candidate.id, 'approve', categoryId, rememberCategory, payeeId || null, offerMapping && rememberMapping, candidate.payee, createdPayeeIds[candidate.id] === payeeId, account.id)}>{reviewingCandidateId === candidate.id ? <LoaderCircle className="spin-icon" size={14} /> : <Check size={14} />}Approve</button>
            </>}
          </div>
        </div>
      })}
    </div>}
  </section>
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
  const reported = diagnostic.bookedReturned + diagnostic.pendingReturned
  return [
    `Bank reported ${reported} transaction${reported === 1 ? '' : 's'}`,
    diagnostic.bookedReturned ? `${diagnostic.bookedReturned} posted` : null,
    diagnostic.pendingReturned ? `${diagnostic.pendingReturned} pending` : null,
    diagnostic.staged ? `${diagnostic.staged} need review` : null,
    diagnostic.imported ? `${diagnostic.imported} added automatically` : null,
    diagnostic.pendingPromoted ? `${diagnostic.pendingPromoted} pending → posted` : null,
    diagnostic.duplicates ? `${diagnostic.duplicates} already known` : null,
    diagnostic.transfersMatched ? `${diagnostic.transfersMatched} transfer${diagnostic.transfersMatched === 1 ? '' : 's'} matched` : null,
    diagnostic.cutoffIgnored ? `${diagnostic.cutoffIgnored} older than imported history` : null,
    diagnostic.futureIgnored ? `${diagnostic.futureIgnored} future-dated ignored` : null,
    diagnostic.malformedIgnored ? `${diagnostic.malformedIgnored} could not be read` : null,
    diagnostic.transactionError ? `Transactions error: ${diagnostic.transactionError}` : null,
    diagnostic.balanceError ? `Balance error: ${diagnostic.balanceError}` : null,
  ].filter(Boolean).join(' · ')
}

function CategoryDetailPage({ category, spent, budget, transactions, allTransactions, categories, categoryGroups, accounts, historyLoaded, historyLoading, onRequestHistory, onUpdateBudget, onUpdateGroup, onEdit, onDelete, onSetHidden, onBack, onSelectCategory, onEditTransaction }: { category: Category; spent: number; budget: number; transactions: Transaction[]; allTransactions: Transaction[]; categories: Category[]; categoryGroups: CategoryGroup[]; accounts: Account[]; historyLoaded: boolean; historyLoading: boolean; onRequestHistory: () => Promise<void>; onUpdateBudget: (categoryId: string, amountMinor: number) => void; onUpdateGroup: (categoryId: string, categoryGroupId: string) => Promise<void>; onEdit: () => void; onDelete: (categoryId: string) => Promise<void>; onSetHidden: (categoryId: string, hidden: boolean) => void; onBack: () => void; onSelectCategory: (id: string) => void; onEditTransaction: (transaction: Transaction) => void }) {
  const Icon = categoryIcons[category.icon as keyof typeof categoryIcons] ?? Sparkles
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  return <div className="page-content narrow-page entity-page">
    <div className="entity-page-toolbar">
      <button className="entity-back" onClick={onBack}><ChevronLeft size={16} />All categories</button>
      <label><span>Category</span><select value={category.id} onChange={(event) => onSelectCategory(event.target.value)}>{categories.map((option) => <option key={option.id} value={option.id}>{option.name}{option.hidden ? ' (hidden)' : ''}</option>)}</select></label>
    </div>
    <section className="panel entity-detail-panel">
      <div className="entity-heading"><div className="entity-heading-icon" style={{ color: category.color, background: `${category.color}18` }}><Icon size={20} /></div><div><span className="eyebrow">{category.reportGroup.replace('_', ' ')}{category.hidden ? ' · Hidden' : ''}</span><h2>{category.name}</h2></div><div className="entity-heading-actions"><button className="secondary-button" type="button" onClick={onEdit}><Pencil size={16} />Edit</button><button className="secondary-button" type="button" onClick={() => onSetHidden(category.id, !category.hidden)}>{category.hidden ? <Eye size={16} /> : <EyeOff size={16} />}{category.hidden ? 'Unhide category' : 'Hide category'}</button>{allTransactions.length === 0 && <button className={confirmingDelete ? 'danger-button confirming' : 'danger-button'} type="button" disabled={deleting} onClick={async () => {
        if (!confirmingDelete) { setConfirmingDelete(true); setDeleteError(''); return }
        setDeleting(true)
        try { await onDelete(category.id) } catch (cause) { setDeleteError(getErrorMessage(cause, 'Could not delete the category.')); setDeleting(false); setConfirmingDelete(false) }
      }}><Trash2 size={16} />{deleting ? 'Deleting…' : confirmingDelete ? 'Confirm delete' : 'Delete'}</button>}</div></div>
      {confirmingDelete && !deleting && <div className="category-delete-confirmation"><span>Deleting this category will also remove its budgets and clear it from payee defaults.</span><button type="button" onClick={() => setConfirmingDelete(false)}>Cancel</button></div>}
      {deleteError && <p className="auth-error" role="alert">{deleteError}</p>}
      <CategoryGroupAssignment key={`${category.id}-${category.categoryGroupId ?? 'none'}`} category={category} groups={categoryGroups} onSubmit={onUpdateGroup} />
      <CategoryDetail key={`${category.id}-${budget}`} category={category} spent={spent} budget={budget} transactions={transactions} allTransactions={allTransactions} categories={categories} accounts={accounts} historyLoaded={historyLoaded} historyLoading={historyLoading} onRequestHistory={onRequestHistory} onUpdateBudget={onUpdateBudget} onEditTransaction={onEditTransaction} />
    </section>
  </div>
}

function CategoryGroupAssignment({ category, groups, onSubmit }: { category: Category; groups: CategoryGroup[]; onSubmit: (categoryId: string, categoryGroupId: string) => Promise<void> }) {
  const [categoryGroupId, setCategoryGroupId] = useState(category.categoryGroupId ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const changed = categoryGroupId !== (category.categoryGroupId ?? '')
  return <div className="category-group-assignment">
    <label><span>Category group</span><select value={categoryGroupId} onChange={(event) => setCategoryGroupId(event.target.value)}><option value="">No group</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
    <button className="secondary-button" type="button" disabled={!changed || saving} onClick={async () => {
      setSaving(true)
      setError('')
      try {
        await onSubmit(category.id, categoryGroupId)
      } catch (cause) {
        setError(getErrorMessage(cause, 'Could not change the category group.'))
      } finally {
        setSaving(false)
      }
    }}>{saving ? 'Saving…' : 'Save group'}</button>
    {error && <p className="auth-error" role="alert">{error}</p>}
  </div>
}

function CategoryDetail({ category, spent, budget, transactions, allTransactions, categories, accounts, historyLoaded, historyLoading, onRequestHistory, onUpdateBudget, onEditTransaction }: { category: Category; spent: number; budget: number; transactions: Transaction[]; allTransactions: Transaction[]; categories: Category[]; accounts: Account[]; historyLoaded: boolean; historyLoading: boolean; onRequestHistory: () => Promise<void>; onUpdateBudget: (categoryId: string, amountMinor: number) => void; onEditTransaction: (transaction: Transaction) => void }) {
  const [transactionPeriod, setTransactionPeriod] = useState<'month' | 'all'>('month')
  const [transactionPage, setTransactionPage] = useState(1)
  const sortedAllTransactions = useMemo(() => [...allTransactions].sort((left, right) => right.date.localeCompare(left.date)), [allTransactions])
  const periodTransactions = transactionPeriod === 'all' ? sortedAllTransactions : transactions
  const pageCount = Math.max(1, Math.ceil(periodTransactions.length / detailTransactionPageSize))
  const displayedTransactions = transactionPeriod === 'all'
    ? periodTransactions.slice((transactionPage - 1) * detailTransactionPageSize, transactionPage * detailTransactionPageSize)
    : periodTransactions
  useEffect(() => setTransactionPage(1), [category.id, transactionPeriod])
  useEffect(() => setTransactionPage((current) => Math.min(current, pageCount)), [pageCount])
  const [budgetInput, setBudgetInput] = useState((budget / 100).toFixed(2))
  const remaining = budget - spent
  const saveBudget = () => {
    const amountMinor = parseMoneyToMinor(budgetInput)
    if (amountMinor === null) return
    onUpdateBudget(category.id, amountMinor)
  }
  return <div className="category-detail">
    <div className="category-detail-summary">
      <div><span>Net spent</span><strong>{formatMoney(spent)}</strong></div>
      <div><span>Budget</span><strong>{formatMoney(budget)}</strong></div>
      <div><span>Remaining</span><strong className={remaining < 0 ? 'negative' : ''}>{formatMoney(remaining)}</strong></div>
    </div>
    <div className="budget-editor">
      <label><span>Monthly plan</span><input type="number" min="0" step="0.01" value={budgetInput} onChange={(event) => setBudgetInput(event.target.value)} /></label>
      <button className="secondary-button" type="button" onClick={saveBudget}>Update budget</button>
    </div>
    <div className="category-detail-heading account-transaction-heading"><span>{historyLoading && transactionPeriod === 'all' && !historyLoaded ? 'Loading transaction history…' : `${periodTransactions.length} transaction${periodTransactions.length === 1 ? '' : 's'} ${transactionPeriod === 'all' ? 'across all dates' : 'in the selected month'}`}</span><div><div className="segmented account-transaction-period"><button type="button" className={transactionPeriod === 'month' ? 'active transfer' : ''} onClick={() => setTransactionPeriod('month')}>Selected month</button><button type="button" className={transactionPeriod === 'all' ? 'active transfer' : ''} onClick={() => { setTransactionPeriod('all'); void onRequestHistory() }}>{historyLoading && !historyLoaded ? 'Loading…' : 'All dates'}</button></div></div></div>
    <div className="category-detail-list">
      {displayedTransactions.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} categories={categories} accounts={accounts} showAccount onEditCategory={() => onEditTransaction(transaction)} />)}
      {!periodTransactions.length && <div className="empty-state compact-empty"><ReceiptText size={24} /><h3>No transactions yet</h3></div>}
    </div>
    {transactionPeriod === 'all' && pageCount > 1 && <nav className="account-transaction-pagination" aria-label="Category transaction pages"><button type="button" className="secondary-button" disabled={transactionPage === 1} onClick={() => setTransactionPage((current) => Math.max(1, current - 1))}><ChevronLeft size={15} />Previous</button><span>Page {transactionPage} of {pageCount} · {detailTransactionPageSize} per page</span><button type="button" className="secondary-button" disabled={transactionPage === pageCount} onClick={() => setTransactionPage((current) => Math.min(pageCount, current + 1))}>Next<ChevronRight size={15} /></button></nav>}
  </div>
}

const detailTransactionPageSize = 50

function AccountDetail({ account, transactions, allTransactions, categories, accounts, historyLoaded, historyLoading, onRequestHistory, onEditTransaction }: { account: Account; transactions: Transaction[]; allTransactions: Transaction[]; categories: Category[]; accounts: Account[]; historyLoaded: boolean; historyLoading: boolean; onRequestHistory: () => Promise<void>; onEditTransaction: (transaction: Transaction) => void }) {
  const [transactionPeriod, setTransactionPeriod] = useState<'month' | 'all'>('month')
  const [transactionPage, setTransactionPage] = useState(1)
  const sortedAllTransactions = useMemo(() => [...allTransactions].sort((left, right) => right.date.localeCompare(left.date)), [allTransactions])
  const periodTransactions = transactionPeriod === 'all' ? sortedAllTransactions : transactions
  const pageCount = Math.max(1, Math.ceil(periodTransactions.length / detailTransactionPageSize))
  const displayedTransactions = transactionPeriod === 'all'
    ? periodTransactions.slice((transactionPage - 1) * detailTransactionPageSize, transactionPage * detailTransactionPageSize)
    : periodTransactions
  useEffect(() => setTransactionPage(1), [account.id, transactionPeriod])
  useEffect(() => setTransactionPage((current) => Math.min(current, pageCount)), [pageCount])
  const incoming = periodTransactions.reduce((sum, transaction) => sum + (transaction.type === 'income' || transaction.toAccountId === account.id ? transaction.amountMinor : 0), 0)
  const outgoing = periodTransactions.reduce((sum, transaction) => sum + (transaction.type === 'expense' || (transaction.type === 'transfer' && transaction.accountId === account.id) ? transaction.amountMinor : 0), 0)
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
    <div className="category-detail-heading account-transaction-heading"><span>{historyLoading && transactionPeriod === 'all' && !historyLoaded ? 'Loading transaction history…' : `${periodTransactions.length} transaction${periodTransactions.length === 1 ? '' : 's'} ${transactionPeriod === 'all' ? 'across all dates' : 'in the selected month'}`}</span><div><b>{account.scope} · {account.type}</b><div className="segmented account-transaction-period"><button type="button" className={transactionPeriod === 'month' ? 'active transfer' : ''} onClick={() => setTransactionPeriod('month')}>Selected month</button><button type="button" className={transactionPeriod === 'all' ? 'active transfer' : ''} onClick={() => { setTransactionPeriod('all'); void onRequestHistory() }}>{historyLoading && !historyLoaded ? 'Loading…' : 'All dates'}</button></div></div></div>
    <div className="category-detail-list">
      {displayedTransactions.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} categories={categories} accounts={accounts} focusAccountId={account.id} onEditCategory={() => onEditTransaction(transaction)} />)}
      {!periodTransactions.length && <div className="empty-state compact-empty"><ReceiptText size={24} /><h3>No transactions yet</h3></div>}
    </div>
    {transactionPeriod === 'all' && pageCount > 1 && <nav className="account-transaction-pagination" aria-label="Account transaction pages"><button type="button" className="secondary-button" disabled={transactionPage === 1} onClick={() => setTransactionPage((current) => Math.max(1, current - 1))}><ChevronLeft size={15} />Previous</button><span>Page {transactionPage} of {pageCount} · {detailTransactionPageSize} per page</span><button type="button" className="secondary-button" disabled={transactionPage === pageCount} onClick={() => setTransactionPage((current) => Math.min(pageCount, current + 1))}>Next<ChevronRight size={15} /></button></nav>}
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
  const [pendingLink] = useState<PendingBankLink | null>(() => {
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

function TransactionDetailsForm({ transaction, transactions, categories, payees, mappings, accounts, onSubmit }: { transaction: Transaction; transactions: Transaction[]; categories: Category[]; payees: Payee[]; mappings: PayeeMapping[]; accounts: Account[]; onSubmit: (date: string, payeeName: string, payeeId: string | undefined, categoryId: string, memo: string, rememberDefault: boolean, rememberMapping: boolean, mappingSource: string, matchingTransactionIds: string[]) => Promise<void> }) {
  const [date, setDate] = useState(transaction.date)
  const [categoryId, setCategoryId] = useState(transaction.categoryId ?? '')
  const [payeeQuery, setPayeeQuery] = useState(transaction.payee)
  const [memo, setMemo] = useState(transaction.note ?? '')
  const [selectedPayeeId, setSelectedPayeeId] = useState(transaction.payeeId ?? '')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [rememberDefault, setRememberDefault] = useState(false)
  const [rememberMapping, setRememberMapping] = useState(true)
  const [selectedRelatedIds, setSelectedRelatedIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const normalizedQuery = payeeQuery.trim().toLocaleLowerCase('en')
  const matchingPayees = payees
    .filter((payee) => !normalizedQuery || payee.name.toLocaleLowerCase('en').includes(normalizedQuery))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 12)
  const selectedPayee = payees.find((payee) => payee.id === selectedPayeeId)
  const defaultCategory = categories.find((category) => category.id === selectedPayee?.defaultCategoryId)
  const selectedCategory = categories.find((category) => category.id === categoryId)
  const availableCategories = categories.filter((category) => !category.hidden || category.id === transaction.categoryId || category.id === defaultCategory?.id)
  const payeeChanged = selectedPayeeId
    ? selectedPayeeId !== transaction.payeeId
    : !transaction.payeeId || payeeQuery.trim().localeCompare(transaction.payee, undefined, { sensitivity: 'accent' }) !== 0
  const memoChanged = memo.normalize('NFKC').trim() !== (transaction.note ?? '').normalize('NFKC').trim()
  const changed = date !== transaction.date || payeeChanged || categoryId !== transaction.categoryId || memoChanged
  // `payeeRaw` is the counterparty/description supplied by the bank. Older
  // imports can have that text only in `memo`, so retain it as a fallback.
  // Prefer the raw payee because a remittance memo can be a payment reference
  // that should not become a reusable payee alias.
  const bankDescription = transaction.payeeRaw?.trim() || ''
  const bankMemo = transaction.note?.trim() || ''
  const bankMappingSource = transaction.source === 'manual' ? '' : bankDescription || bankMemo
  const bankMappingLabel = bankDescription ? 'bank description' : 'bank memo'
  const mappingAlreadyExists = Boolean(selectedPayee && mappings.some((mapping) => mapping.payeeId === selectedPayee.id && normalizedPayeeName(mapping.sourceName) === normalizedPayeeName(bankMappingSource)))
  const targetPayeeName = selectedPayee?.name ?? payeeQuery.trim()
  const offerMapping = Boolean(payeeChanged && targetPayeeName && bankMappingSource && normalizedPayeeName(bankMappingSource) !== normalizedPayeeName(targetPayeeName) && !mappingAlreadyExists)
  const normalizedTargetPayee = normalizedPayeeName(targetPayeeName)
  const relatedTransactions = transactions
    .filter((item) => item.id !== transaction.id && (item.type === 'expense' || item.type === 'income'))
    .filter((item) => selectedPayeeId ? item.payeeId === selectedPayeeId : normalizedPayeeName(item.payee) === normalizedTargetPayee)
    .sort((left, right) => right.date.localeCompare(left.date))
  const selectableRelated = relatedTransactions.filter((item) => item.categoryId !== categoryId)
  const selectedRelatedCount = selectableRelated.filter((item) => selectedRelatedIds.includes(item.id)).length
  const showRelatedTransactions = Boolean(categoryId && categoryId !== transaction.categoryId && relatedTransactions.length)

  return <form className="form" onSubmit={async (event) => { event.preventDefault(); if (!date || !categoryId || !payeeQuery.trim()) return; setSaving(true); try { await onSubmit(date, payeeQuery.trim(), selectedPayee?.id, categoryId, memo, rememberDefault, offerMapping && rememberMapping, bankMappingSource, selectedRelatedIds.filter((id) => selectableRelated.some((item) => item.id === id))) } finally { setSaving(false) } }}>
    <div className="category-edit-transaction">
      <span className="transaction-icon"><ReceiptText size={18} /></span>
      <div><strong>{transaction.payee}</strong><span>{formatShortDate(transaction.date)} · {formatMoney(transaction.amountMinor, transaction.currency)}</span></div>
    </div>
    <label><span>Date</span><input required type="date" max={todayInParis()} value={date} onChange={(event) => setDate(event.target.value)} /></label>
    {transaction.source && transaction.source !== 'manual' && date !== transaction.date && <p className="form-help">This changes where the transaction appears in reports. Its bank identity and original imported timestamp remain unchanged.</p>}
    <label><span>Payee</span><div className="transaction-payee-picker"><Search size={16} /><input required value={payeeQuery} autoComplete="off" onFocus={() => setPickerOpen(true)} onBlur={() => setPickerOpen(false)} onChange={(event) => {
      const query = event.target.value
      const exact = payees.find((payee) => payee.name.localeCompare(query.trim(), undefined, { sensitivity: 'accent' }) === 0)
      setPayeeQuery(query)
      setSelectedPayeeId(exact?.id ?? '')
      setSelectedRelatedIds([])
      const exactDefault = categories.find((category) => category.id === exact?.defaultCategoryId)
      if (exactDefault) setCategoryId(exactDefault.id)
      setRememberDefault(false)
      if (exact?.id !== selectedPayeeId) setRememberMapping(true)
      setPickerOpen(true)
    }} />
      {pickerOpen && <div className="transaction-payee-options" role="listbox">
        {matchingPayees.map((payee) => {
          const payeeDefault = categories.find((category) => category.id === payee.defaultCategoryId)
          return <button type="button" role="option" aria-selected={payee.id === selectedPayeeId} key={payee.id} onMouseDown={(event) => event.preventDefault()} onClick={() => { setPayeeQuery(payee.name); setSelectedPayeeId(payee.id); setSelectedRelatedIds([]); if (payeeDefault) setCategoryId(payeeDefault.id); setRememberDefault(false); if (payee.id !== selectedPayeeId) setRememberMapping(true); setPickerOpen(false) }}><strong>{payee.name}</strong><small>Default category: {payeeDefault ? `${payeeDefault.name}${payeeDefault.hidden ? ' (hidden)' : ''}` : 'None'}</small></button>
        })}
        {!matchingPayees.length && payeeQuery.trim() && <div className="new-payee-option"><strong>Create “{payeeQuery.trim()}”</strong><small>This payee does not exist yet.</small></div>}
      </div>}
    </div></label>
    <div className="selected-payee-default"><div><span>Selected payee default</span><strong>{selectedPayee ? (defaultCategory ? `${defaultCategory.name}${defaultCategory.hidden ? ' (hidden)' : ''}` : 'No default category') : payeeQuery.trim() ? 'New payee · transaction category will become its default' : 'Choose or enter a payee'}</strong></div></div>
    <label><span>Category</span><CategorySearchPicker ariaLabel="Category" value={categoryId} categories={availableCategories} onChange={(nextCategoryId) => { setCategoryId(nextCategoryId); setSelectedRelatedIds([]); setRememberDefault(Boolean(selectedPayee && nextCategoryId && selectedPayee.defaultCategoryId !== nextCategoryId)) }} /></label>
    <label><span>Memo <i>Optional</i></span><input value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="Add a note about this transaction" /></label>
    {selectedCategory?.hidden && <p className="category-edit-warning"><ShieldAlert size={15} />This category is hidden. Choose an active category to keep future reporting easier to understand.</p>}
    {selectedPayee && categoryId && selectedPayee.defaultCategoryId !== categoryId && <label className="remember-category transaction-default-choice"><input type="checkbox" checked={rememberDefault} onChange={(event) => setRememberDefault(event.target.checked)} />Make {selectedCategory?.name ?? 'this category'} the default for {selectedPayee.name}</label>}
    {offerMapping && <label className="remember-category transaction-default-choice transaction-mapping-choice"><input type="checkbox" checked={rememberMapping} onChange={(event) => setRememberMapping(event.target.checked)} /><span>Add the {bankMappingLabel} “{bankMappingSource}” as an alternative name for <strong>{targetPayeeName}</strong></span></label>}
    {showRelatedTransactions && <section className="related-transactions-choice">
      <div className="related-transactions-heading"><div><strong>Other transactions for {targetPayeeName}</strong><span>Select any that should use {selectedCategory?.name ?? 'this category'} too.</span></div>{selectableRelated.length > 1 && <label><input type="checkbox" checked={selectedRelatedCount === selectableRelated.length} onChange={(event) => setSelectedRelatedIds(event.target.checked ? selectableRelated.map((item) => item.id) : [])} />Select all</label>}</div>
      <div className="related-transactions-list">{relatedTransactions.map((item) => {
        const currentCategory = categories.find((category) => category.id === item.categoryId)
        const accountName = accounts.find((account) => account.id === item.accountId)?.name ?? 'Unknown account'
        const alreadyUsesCategory = item.categoryId === categoryId
        return <label className={alreadyUsesCategory ? 'related-transaction already-matched' : 'related-transaction'} key={item.id}>
          <input type="checkbox" disabled={alreadyUsesCategory} checked={alreadyUsesCategory || selectedRelatedIds.includes(item.id)} onChange={(event) => setSelectedRelatedIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
          <span><strong>{formatShortDate(item.date)} · {currentCategory?.name ?? 'Uncategorised'}</strong><small><span className="related-transaction-account">{accountName}</span><span className="related-transaction-memo" title={item.note?.trim() || 'No memo'}>{item.note?.trim() || 'No memo'}</span></small></span>
          <b className={item.type === 'income' ? 'positive' : ''}>{item.type === 'income' ? '+' : '−'}{formatMoney(item.amountMinor, item.currency)}</b>
        </label>
      })}</div>
    </section>}
    <button className="primary-button form-submit" disabled={!date || !categoryId || !payeeQuery.trim() || (!changed && !rememberDefault) || saving}>{saving ? 'Saving…' : selectedRelatedCount ? `Save ${selectedRelatedCount + 1} transactions` : 'Save transaction'}<ArrowRight size={18} /></button>
  </form>
}

function TransferDetailsForm({ transaction, accounts, onSubmit }: { transaction: Transaction; accounts: Account[]; onSubmit: (date: string, destinationAccountId: string, memo: string) => Promise<void> }) {
  const [date, setDate] = useState(transaction.date)
  const [destinationAccountId, setDestinationAccountId] = useState(transaction.toAccountId ?? '')
  const [memo, setMemo] = useState(transaction.note ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const sourceAccount = accounts.find((account) => account.id === transaction.accountId)
  const destinationAccounts = accounts.filter((account) => account.id !== transaction.accountId
    && account.currency === transaction.currency
    && (!account.closed || account.id === transaction.toAccountId))
  const changed = date !== transaction.date
    || destinationAccountId !== transaction.toAccountId
    || memo.normalize('NFKC').trim() !== (transaction.note ?? '').normalize('NFKC').trim()

  return <form className="form transfer-details-form" onSubmit={async (event) => {
    event.preventDefault()
    if (!date || !destinationAccountId || !changed) return
    setSaving(true)
    setError('')
    try {
      await onSubmit(date, destinationAccountId, memo)
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not update the transfer.'))
    } finally {
      setSaving(false)
    }
  }}>
    <div className="category-edit-transaction transfer-edit-summary">
      <span className="transaction-icon"><ArrowLeftRight size={18} /></span>
      <div><strong>{sourceAccount?.name ?? 'Unknown account'} → {accounts.find((account) => account.id === transaction.toAccountId)?.name ?? 'Unknown account'}</strong><span>{formatMoney(transaction.amountMinor, transaction.currency)}</span></div>
    </div>
    <label><span>Date</span><input required type="date" max={todayInParis()} value={date} onChange={(event) => setDate(event.target.value)} /></label>
    <div className="form-grid">
      <label><span>From account</span><input value={sourceAccount?.name ?? 'Unknown account'} disabled /></label>
      <label><span>To account</span><select required value={destinationAccountId} onChange={(event) => setDestinationAccountId(event.target.value)}>{destinationAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.closed ? ' (closed)' : ''}</option>)}</select></label>
    </div>
    <label><span>Memo <i>Optional</i></span><input value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="Add a note about this transfer" /></label>
    <p className="form-help">The amount, source account, and attached bank transaction IDs remain unchanged.</p>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <button className="primary-button form-submit" type="submit" disabled={!changed || !destinationAccountId || saving}>{saving ? 'Saving…' : 'Save transfer'}<ArrowRight size={18} /></button>
  </form>
}

function OpeningBalanceForm({ transaction, onSubmit }: { transaction: Transaction; onSubmit: (date: string, amountMinor: number) => Promise<void> }) {
  const [date, setDate] = useState(transaction.date)
  const [amount, setAmount] = useState(String(transaction.amountMinor / 100))
  const [saving, setSaving] = useState(false)
  return <form className="form" onSubmit={async (event) => {
    event.preventDefault()
    const amountMinor = parseMoneyToMinor(amount, true)
    if (amountMinor === null || !date) return
    setSaving(true)
    try { await onSubmit(date, amountMinor) } finally { setSaving(false) }
  }}>
    <label className="amount-field"><span>Opening balance</span><div><b>{transaction.currency}</b><input autoFocus required step="0.01" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} /></div></label>
    <label><span>Effective date</span><input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
    <p className="form-help">This amount affects the account balance but is excluded from budgets and reports.</p>
    <button className="primary-button form-submit" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save opening balance'}<ArrowRight size={18} /></button>
  </form>
}

function BalanceAdjustmentForm({ account, transaction, onSubmit }: { account: Account; transaction?: Transaction; onSubmit: (date: string, observedBalanceMinor: number, reason: BalanceAdjustmentReason, memo: string) => Promise<void> }) {
  const [date, setDate] = useState(transaction?.date ?? todayInParis())
  const [balance, setBalance] = useState(((transaction?.balanceCheckpointMinor ?? account.balanceMinor) / 100).toFixed(2))
  const [reason, setReason] = useState<BalanceAdjustmentReason>(transaction?.adjustmentReason ?? inferredBalanceAdjustmentReason(account))
  const [memo, setMemo] = useState(transaction?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const observedBalanceMinor = parseMoneyToMinor(balance, true)
  const estimatedDifference = transaction ? transaction.amountMinor : observedBalanceMinor === null ? null : observedBalanceMinor - account.balanceMinor
  const reasonHelp: Record<BalanceAdjustmentReason, string> = {
    market_valuation: 'Tracks an unrealized investment or pension gain or loss outside the operating P&L.',
    asset_valuation: 'Updates the value of a property or other asset outside the operating P&L.',
    liability_adjustment: 'Corrects a loan or other liability balance outside the operating P&L.',
    reconciliation: 'Corrects an unexplained balance difference without treating it as income or spending.',
    other: 'Records a balance-only adjustment outside budgets and the operating P&L.',
  }
  return <form className="form balance-adjustment-form" onSubmit={async (event) => {
    event.preventDefault()
    if (observedBalanceMinor === null || !date) return
    setSaving(true)
    setError('')
    try { await onSubmit(date, observedBalanceMinor, reason, memo) } catch (cause) { setError(getErrorMessage(cause, 'Could not save the balance adjustment.')) } finally { setSaving(false) }
  }}>
    <div className="balance-adjustment-account"><span>Account</span><strong>{account.name}</strong><small>Current calculated balance {formatMoney(account.balanceMinor, account.currency)}</small></div>
    <label className="amount-field"><span>Observed closing balance</span><div><b>{account.currency}</b><input required autoFocus type="number" step="0.01" value={balance} onChange={(event) => setBalance(event.target.value)} /></div></label>
    <label><span>Effective date</span><input required type="date" max={todayInParis()} value={date} onChange={(event) => setDate(event.target.value)} /></label>
    <label><span>Adjustment reason</span><select value={reason} onChange={(event) => setReason(event.target.value as BalanceAdjustmentReason)}>{(Object.keys(balanceAdjustmentReasonLabels) as BalanceAdjustmentReason[]).map((value) => <option key={value} value={value}>{balanceAdjustmentReasonLabels[value]}</option>)}</select><small className="field-help">{reasonHelp[reason]}</small></label>
    <label><span>Memo <i>Optional</i></span><input value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="What prompted this balance update?" /></label>
    {estimatedDifference !== null && <div className="balance-adjustment-preview"><span>{transaction ? 'Current adjustment' : 'Estimated adjustment today'}</span><strong className={estimatedDifference >= 0 ? 'positive' : 'negative'}>{estimatedDifference >= 0 ? '+' : '−'}{formatMoney(Math.abs(estimatedDifference), account.currency)}</strong><small>The final difference is calculated from all transactions through the effective date.</small></div>}
    <p className="form-help">This saves a dated balance checkpoint. Transactions after that date continue to change the balance normally, while earlier imports cannot move the account away from this observed balance.</p>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <button className="primary-button form-submit" type="submit" disabled={saving || observedBalanceMinor === null}>{saving ? 'Saving…' : transaction ? 'Update adjustment' : 'Adjust balance'}<ArrowRight size={18} /></button>
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
    ? isIncomeReportGroup(category.reportGroup) || isExpenseReportGroup(category.reportGroup)
    : isExpenseReportGroup(category.reportGroup) || taxReportGroups.includes(category.reportGroup))
  const [categoryId, setCategoryId] = useState(categories.find(c => c.reportGroup === 'personal_expense')?.id ?? '')
  function changeType(next: Transaction['type']) {
    setType(next)
    if (next !== 'transfer') setCategoryId(categories.find(c => c.reportGroup === (next === 'income' ? 'personal_income' : 'personal_expense'))?.id ?? categories[0]?.id ?? '')
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
    {type !== 'transfer' && <div className="form-grid"><label><span>Payee</span><input required list="payee-options" value={payee} onChange={(event) => {
      const nextName = event.target.value
      const selectedPayee = payees.find((item) => item.name.localeCompare(nextName.trim(), undefined, { sensitivity: 'accent' }) === 0)
      setPayee(nextName)
      if (selectedPayee?.defaultAccountId && accounts.some((account) => account.id === selectedPayee.defaultAccountId)) setAccountId(selectedPayee.defaultAccountId)
      if (selectedPayee?.defaultCategoryId && categories.some((category) => category.id === selectedPayee.defaultCategoryId)) setCategoryId(selectedPayee.defaultCategoryId)
    }} placeholder="e.g. Green Market" /><datalist id="payee-options">{payees.map((item) => <option key={item.id} value={item.name} />)}</datalist></label><label><span>Date</span><input required type="date" max={latestDate} value={date} onChange={(e) => setDate(e.target.value)} /></label></div>}
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

function AccountForm({ account, onSubmit }: { account?: Account; onSubmit: (a: Omit<Account, 'id'>, openingBalanceDate?: string) => void }) {
  const [name, setName] = useState(account?.name ?? '')
  const [type, setType] = useState<Account['type']>(account?.type ?? 'Checking')
  const [balance, setBalance] = useState(account ? String(account.balanceMinor / 100) : '')
  const [openingBalanceDate, setOpeningBalanceDate] = useState(todayInParis)
  const [balanceSheetGroup, setBalanceSheetGroup] = useState<BalanceSheetGroup>(account ? accountBalanceSheetGroup(account) : 'Personal')
  const [currency, setCurrency] = useState(account?.currency ?? 'EUR')
  function submit(e: FormEvent) {
    e.preventDefault()
    const balanceMinor = parseMoneyToMinor(balance || '0', true)
    if (!name.trim() || balanceMinor === null) return
    const scope: AccountScope = balanceSheetGroup === 'Company' ? 'Company' : 'Personal'
    onSubmit({ name: name.trim(), type, scope, balanceSheetGroup, balanceMinor, currency, color: account?.color ?? (type === 'Savings' ? '#d68853' : type === 'Cash' ? '#777a6d' : '#234e46'), closed: account?.closed ?? false, autoSync: account?.autoSync }, account ? undefined : openingBalanceDate)
  }
  return <form className="form" onSubmit={submit}><label><span>Account name</span><input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Everyday checking" /></label><div className="form-grid"><label><span>Account type</span><select value={type} onChange={e => setType(e.target.value as Account['type'])}><option>Checking</option><option>Savings</option><option>Cash</option></select></label><label><span>Balance sheet group</span><select value={balanceSheetGroup} onChange={e => setBalanceSheetGroup(e.target.value as BalanceSheetGroup)}>{balanceSheetGroups.map((group) => <option key={group}>{group}</option>)}</select></label></div>{!account && <><div className="form-grid"><label><span>Opening balance</span><input type="number" step="0.01" value={balance} onChange={e => setBalance(e.target.value)} placeholder="0.00" /></label><label><span>Currency</span><select value={currency} onChange={e => setCurrency(e.target.value)}><option>EUR</option><option>SEK</option><option>USD</option><option>GBP</option></select></label></div><label><span>Opening balance date</span><input required type="date" value={openingBalanceDate} onChange={(event) => setOpeningBalanceDate(event.target.value)} /></label><p className="form-help">The opening balance affects the account balance but is excluded from budgets and reports.</p></>}<p className="form-help">This controls where the account appears on the balance sheet. Company accounts are also used to calculate estimated corporate tax.</p><button className="primary-button form-submit">{account ? 'Save account' : 'Create account'}<ArrowRight size={18} /></button></form>
}

function CategoryGroupsForm({ groups, categories, onAdd, onRename, onReorder, onReorderCategories, onRemove }: { groups: CategoryGroup[]; categories: Category[]; onAdd: (name: string) => Promise<CategoryGroup>; onRename: (categoryGroupId: string, name: string) => Promise<void>; onReorder: (categoryGroupIds: string[]) => Promise<void>; onReorderCategories: (categoryGroupId: string, categoryIds: string[]) => Promise<void>; onRemove: (categoryGroupId: string) => Promise<void> }) {
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const orderedGroups = [...groups].sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
  const move = async (categoryGroupId: string, direction: -1 | 1) => {
    const index = orderedGroups.findIndex((group) => group.id === categoryGroupId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= orderedGroups.length) return
    const next = [...orderedGroups]
    ;[next[index], next[target]] = [next[target], next[index]]
    await onReorder(next.map((group) => group.id))
  }
  return <div className="form category-groups-form">
    <p className="form-help">Groups organize categories in your budget. Reassign a group’s categories before removing it.</p>
    <div className="category-group-manager-list">
      {orderedGroups.map((group, index) => {
        const groupCategories = categories.filter((category) => category.categoryGroupId === group.id).sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.name.localeCompare(right.name))
        return <div className="category-group-manager-section" key={group.id}>
          <CategoryGroupManagerRow group={group} categoryCount={groupCategories.length} first={index === 0} last={index === orderedGroups.length - 1} onRename={onRename} onMove={move} onRemove={onRemove} />
          <CategoryOrderList group={group} categories={groupCategories} onReorder={onReorderCategories} />
        </div>
      })}
      {!orderedGroups.length && <p className="form-help">No category groups yet.</p>}
    </div>
    <div className="category-group-add"><label><span>New group</span><input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="e.g. Household" /></label><button className="secondary-button" type="button" disabled={!newName.trim() || adding} onClick={async () => {
      setAdding(true)
      setError('')
      try {
        await onAdd(newName)
        setNewName('')
      } catch (cause) {
        setError(getErrorMessage(cause, 'Could not create the category group.'))
      } finally {
        setAdding(false)
      }
    }}>{adding ? 'Adding…' : 'Add group'}</button></div>
    {error && <p className="auth-error" role="alert">{error}</p>}
  </div>
}

function CategoryOrderList({ group, categories, onReorder }: { group: CategoryGroup; categories: Category[]; onReorder: (categoryGroupId: string, categoryIds: string[]) => Promise<void> }) {
  const [movingId, setMovingId] = useState('')
  const [error, setError] = useState('')
  const move = async (categoryId: string, direction: -1 | 1) => {
    const index = categories.findIndex((category) => category.id === categoryId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= categories.length) return
    const next = [...categories]
    ;[next[index], next[target]] = [next[target], next[index]]
    setMovingId(categoryId)
    setError('')
    try {
      await onReorder(group.id, next.map((category) => category.id))
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not reorder the categories.'))
    } finally {
      setMovingId('')
    }
  }
  if (!categories.length) return null
  return <div className="category-order-list">
    {categories.map((category, index) => <div className="category-order-row" key={category.id}>
      <span className="category-order-swatch" style={{ background: category.color }} />
      <span>{category.name}{category.hidden ? <small>Hidden</small> : null}</span>
      <div className="category-group-order-actions">
        <button className="icon-button" type="button" aria-label={`Move ${category.name} up within ${group.name}`} disabled={index === 0 || Boolean(movingId)} onClick={() => move(category.id, -1)}><ArrowUp size={14} /></button>
        <button className="icon-button" type="button" aria-label={`Move ${category.name} down within ${group.name}`} disabled={index === categories.length - 1 || Boolean(movingId)} onClick={() => move(category.id, 1)}><ArrowDown size={14} /></button>
      </div>
    </div>)}
    {error && <p className="unmatched-error" role="alert">{error}</p>}
  </div>
}

function CategoryGroupManagerRow({ group, categoryCount, first, last, onRename, onMove, onRemove }: { group: CategoryGroup; categoryCount: number; first: boolean; last: boolean; onRename: (categoryGroupId: string, name: string) => Promise<void>; onMove: (categoryGroupId: string, direction: -1 | 1) => Promise<void>; onRemove: (categoryGroupId: string) => Promise<void> }) {
  const [name, setName] = useState(group.name)
  const [pending, setPending] = useState<'save' | 'move' | 'remove' | ''>('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [error, setError] = useState('')
  const normalizedName = name.normalize('NFKC').trim()
  const changed = normalizedName !== group.name
  const run = async (kind: 'save' | 'move' | 'remove', action: () => Promise<void>) => {
    setPending(kind)
    setError('')
    try {
      await action()
    } catch (cause) {
      setError(getErrorMessage(cause, `Could not ${kind === 'save' ? 'rename' : kind} the category group.`))
    } finally {
      setPending('')
    }
  }
  return <div className="category-group-manager-row">
    <label><span>Group name</span><input value={name} onChange={(event) => { setName(event.target.value); setConfirmRemove(false) }} /></label>
    <small>{categoryCount} categor{categoryCount === 1 ? 'y' : 'ies'}</small>
    <div className="category-group-order-actions"><button className="icon-button" type="button" aria-label={`Move ${group.name} up`} disabled={first || Boolean(pending)} onClick={() => run('move', () => onMove(group.id, -1))}><ArrowUp size={14} /></button><button className="icon-button" type="button" aria-label={`Move ${group.name} down`} disabled={last || Boolean(pending)} onClick={() => run('move', () => onMove(group.id, 1))}><ArrowDown size={14} /></button></div>
    <button className="secondary-button" type="button" disabled={!changed || !normalizedName || Boolean(pending)} onClick={() => run('save', () => onRename(group.id, normalizedName))}>{pending === 'save' ? 'Saving…' : 'Save'}</button>
    <button className="mapping-remove" type="button" title={categoryCount ? 'Reassign these categories before removing the group.' : undefined} disabled={categoryCount > 0 || Boolean(pending)} onClick={() => {
      if (!confirmRemove) {
        setConfirmRemove(true)
        return
      }
      run('remove', () => onRemove(group.id))
    }}>{pending === 'remove' ? 'Removing…' : confirmRemove ? 'Confirm remove' : 'Remove'}</button>
    {error && <p className="unmatched-error" role="alert">{error}</p>}
  </div>
}

function CategoryDetailsForm({ category, categories, onSubmit }: { category: Category; categories: Category[]; onSubmit: (categoryId: string, changes: Pick<Category, 'name' | 'reportGroup' | 'icon' | 'color'>) => Promise<void> }) {
  const [name, setName] = useState(category.name)
  const [reportGroup, setReportGroup] = useState<ReportGroup>(category.reportGroup)
  const [icon, setIcon] = useState(category.icon in categoryIcons ? category.icon : 'sparkles')
  const [color, setColor] = useState(category.color)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const normalizedName = name.normalize('NFKC').trim()
  const duplicate = categories.some((item) => item.id !== category.id && item.name.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0)
  const validColor = /^#[0-9a-f]{6}$/i.test(color)
  const unchanged = normalizedName === category.name && reportGroup === category.reportGroup && icon === category.icon && color.toLocaleLowerCase('en') === category.color.toLocaleLowerCase('en')
  const PreviewIcon = categoryIcons[icon as keyof typeof categoryIcons] ?? Sparkles
  return <form className="form" onSubmit={async (event) => {
    event.preventDefault()
    if (!normalizedName || duplicate || !validColor || unchanged) return
    setSaving(true)
    setError('')
    try {
      await onSubmit(category.id, { name: normalizedName, reportGroup, icon, color })
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not update the category.'))
      setSaving(false)
    }
  }}>
    <label><span>Category name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label><span>Report group</span><select value={reportGroup} onChange={(event) => setReportGroup(event.target.value as ReportGroup)}><option value="personal_income">Personal income</option><option value="personal_expense">Personal expense</option><option value="personal_tax">Personal tax</option><option value="company_revenue">Company revenue</option><option value="company_expense">Company expense</option><option value="company_tax">Company tax</option></select></label>
    <div className="category-appearance-row">
      <div className="category-appearance-preview"><span style={{ color, background: `${color}18` }}><PreviewIcon size={22} /></span><div><small>Preview</small><strong>{normalizedName || 'Category'}</strong></div></div>
      <label className="category-color-field"><span>Color</span><div><input type="color" value={validColor ? color : '#5d7d91'} onChange={(event) => setColor(event.target.value)} /><input aria-label="Category color hex value" value={color} onChange={(event) => setColor(event.target.value)} maxLength={7} /></div></label>
    </div>
    <fieldset className="category-icon-field"><legend>Icon</legend><div>{Object.entries(categoryIcons).map(([value, Icon]) => <button type="button" className={icon === value ? 'selected' : ''} key={value} title={value.replaceAll('-', ' ')} aria-label={`Use ${value.replaceAll('-', ' ')} icon`} aria-pressed={icon === value} onClick={() => setIcon(value)}><Icon size={18} /></button>)}</div></fieldset>
    {duplicate && <p className="auth-error" role="alert">A category named “{normalizedName}” already exists.</p>}
    {!validColor && <p className="auth-error" role="alert">Enter a six-digit hex color such as #5d7d91.</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    <button className="primary-button form-submit" disabled={!normalizedName || duplicate || !validColor || unchanged || saving}>{saving ? 'Saving…' : 'Save category'}<ArrowRight size={18} /></button>
  </form>
}

function CategoryForm({ categoryGroups, onSubmit }: { categoryGroups: CategoryGroup[]; onSubmit: (c: Omit<Category, 'id'>, budgetMinor: number) => void }) {
  const [name, setName] = useState(''); const [budget, setBudget] = useState(''); const [reportGroup, setReportGroup] = useState<ReportGroup>('personal_expense'); const [categoryGroupId, setCategoryGroupId] = useState(categoryGroups[0]?.id ?? '')
  function submit(e: FormEvent) { e.preventDefault(); const budgetMinor = parseMoneyToMinor(budget || '0'); if (!name || budgetMinor === null) return; onSubmit({ name, reportGroup, categoryGroupId: categoryGroupId || undefined, color: '#5d7d91', icon: isIncomeReportGroup(reportGroup) ? 'briefcase' : 'sparkles', hidden: false }, budgetMinor) }
  return <form className="form" onSubmit={submit}><label><span>Category name</span><input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Personal care" /></label><div className="form-grid"><label><span>Report group</span><select value={reportGroup} onChange={e => setReportGroup(e.target.value as ReportGroup)}><option value="personal_income">Personal income</option><option value="personal_expense">Personal expense</option><option value="personal_tax">Personal tax</option><option value="company_revenue">Company revenue</option><option value="company_expense">Company expense</option><option value="company_tax">Company tax</option></select></label><label><span>Category group</span><select value={categoryGroupId} onChange={e => setCategoryGroupId(e.target.value)}>{categoryGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label></div><label><span>Monthly plan</span><input type="number" min="0" step="0.01" value={budget} onChange={e => setBudget(e.target.value)} placeholder="0.00" /></label><button className="primary-button form-submit">Create category<ArrowRight size={18} /></button></form>
}

export default App
