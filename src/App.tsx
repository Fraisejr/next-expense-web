import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ArrowLeftRight, ArrowRight, Banknote, BriefcaseBusiness,
  BarChart3, BriefcaseMedical, CalendarDays, CarFront, ChevronDown, ChevronLeft, ChevronRight, CircleHelp,
  ArrowDown, ArrowUp, Check, CreditCard, Dumbbell, Eye, EyeOff, GripVertical, HeartHandshake, House, Link2, LoaderCircle, LogOut, Menu, Pencil, Plane, Plus, ReceiptText, Search, Settings, Trash2,
  RefreshCw, ShieldAlert, ShoppingBag, ShoppingBasket, Sparkles, Target, Tv, UsersRound, Utensils, WalletCards, Wine, X, Zap,
} from 'lucide-react'
import { matchPath, useLocation, useNavigate } from 'react-router-dom'
import { approveBankImportCandidate, assignPayeeMapping, createAccount, createCategory, createCategoryGroup, createPayee, createPayeeMapping, createTransaction, deleteCategoryGroup, deletePayeeMapping, deleteUnusedCategory, ensurePayees, linkBankAccount, loadWorkspace, normalizedPayeeName, prefixMappingMatches, rejectBankImportCandidate, saveAccountOrder, saveBankSync, saveBudget, saveCategoryGroupOrder, updateAccountDetails, updateBankImportCandidatePayee, updateBankImportMode, updateCategoryGroupAssignment, updateCategoryGroupName, updateCategoryHidden, updateCategoryName, updatePayeeDefaultCategory, updatePayeeDefaults, updatePayeeMapping, updateTaxRate, updateTransactionCategories, updateTransactionDetails, WorkspaceNotLinkedError, type BankSyncPayload, type LoadedWorkspace } from './database'
import { neon } from './neon'
import type { Account, AccountScope, AppData, BalanceSheetGroup, BankImportCandidate, Category, CategoryGroup, Payee, PayeeMapping, ReportGroup, Transaction } from './types'

type Page = 'transactions' | 'payees' | 'budgets' | 'reports' | 'accounts'
type Modal = 'transaction' | 'account' | 'edit-account' | 'category' | 'edit-category' | 'category-groups' | 'bank' | null
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
  { id: 'budgets', label: 'Budget', icon: Target, path: '/' },
  { id: 'transactions', label: 'Transactions', icon: ReceiptText, path: '/transactions' },
  { id: 'accounts', label: 'Accounts', icon: WalletCards, path: '/accounts' },
  { id: 'reports', label: 'Reports', icon: BarChart3, path: '/reports' },
  { id: 'payees', label: 'Payees', icon: UsersRound, path: '/payees' },
]
const balanceSheetGroups: BalanceSheetGroup[] = ['Personal', 'Company', 'Real estate', 'Pension']

function accountBalanceSheetGroup(account: Account): BalanceSheetGroup {
  return account.balanceSheetGroup ?? (account.scope === 'Company' ? 'Company' : 'Personal')
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
  const [openAccountGroups, setOpenAccountGroups] = useState<Record<BalanceSheetGroup, boolean>>({ Personal: true, Company: true, 'Real estate': true, Pension: true })
  const [closedAccountsOpen, setClosedAccountsOpen] = useState(false)
  const [bankTarget, setBankTarget] = useState<Account | null>(null)
  const [accountTarget, setAccountTarget] = useState<Account | null>(null)
  const [categoryTarget, setCategoryTarget] = useState<Transaction | null>(null)
  const [syncingAccountId, setSyncingAccountId] = useState('')
  const [reviewingCandidateId, setReviewingCandidateId] = useState('')
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
          : location.pathname === '/reports' || location.pathname === '/performance' ? 'reports'
            : location.pathname === '/accounts' ? 'accounts'
              : 'budgets'
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
  const budgetForCategory = (categoryId: string) => data.budgets
    .filter((budget) => budget.month === selectedMonthKey && budget.categoryId === categoryId)
    .reduce((sum, budget) => sum + budget.amountMinor, 0)
  const companyCategoryGroupIds = new Set(data.categoryGroups.filter((group) => group.name.toLocaleLowerCase('en') === 'company').map((group) => group.id))
  const companyCategories = data.categories.filter((category) => category.categoryGroupId && companyCategoryGroupIds.has(category.categoryGroupId))
  const companyIncome = companyCategories.filter((category) => category.reportGroup === 'income').reduce((sum, category) => sum + categorySpending(category.id), 0)
  const companyExpenses = companyCategories.filter((category) => category.reportGroup === 'expense').reduce((sum, category) => sum + categorySpending(category.id), 0)
  const estimatedCompanyTax = Math.max(0, Math.round((companyIncome - companyExpenses) * data.settings.estimatedCompanyTaxRateBps / 10_000))
  const plannedForGroup = (group: ReportGroup) => data.categories.filter((category) => !category.hidden && category.reportGroup === group).reduce((sum, category) => sum + budgetForCategory(category.id), 0)
  const plannedIncome = plannedForGroup('income')
  const plannedExpenses = plannedForGroup('expense')
  const plannedTaxes = plannedForGroup('tax')
  const plannedCapitalGains = plannedForGroup('capital_gain')
  const plannedCompanyIncome = companyCategories.filter((category) => !category.hidden && category.reportGroup === 'income').reduce((sum, category) => sum + budgetForCategory(category.id), 0)
  const plannedCompanyExpenses = companyCategories.filter((category) => !category.hidden && category.reportGroup === 'expense').reduce((sum, category) => sum + budgetForCategory(category.id), 0)
  const plannedCompanyTax = Math.max(0, Math.round((plannedCompanyIncome - plannedCompanyExpenses) * data.settings.estimatedCompanyTaxRateBps / 10_000))
  const actualResult = income - expenses - taxesPaid - estimatedCompanyTax + capitalGains
  const plannedResult = plannedIncome - plannedExpenses - plannedTaxes - plannedCompanyTax + plannedCapitalGains
  const selectedCategory = data.categories.find((category) => category.id === categoryMatch?.params.categoryId)
  const selectedAccount = data.accounts.find((account) => account.id === accountMatch?.params.accountId)
  const selectedPayee = data.payees.find((payee) => payee.id === payeeMatch?.params.payeeId)
  const pageTitle = selectedAccount?.name ?? selectedCategory?.name ?? selectedPayee?.name ?? navItems.find((item) => item.id === page)?.label ?? 'Budget'
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

  async function renameCategory(categoryId: string, name: string) {
    const normalizedName = name.normalize('NFKC').trim()
    try {
      setSyncError('')
      if (!normalizedName) throw new Error('Enter a category name.')
      if (data.categories.some((category) => category.id !== categoryId && category.name.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0)) {
        throw new Error(`A category named “${normalizedName}” already exists.`)
      }
      await updateCategoryName(workspace.workspaceId, categoryId, normalizedName)
      setData((current) => ({
        ...current,
        categories: current.categories.map((category) => category.id === categoryId ? { ...category, name: normalizedName } : category),
      }))
      setModal(null)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not rename the category.'))
      throw error
    }
  }

  async function changeCategoryGroup(categoryId: string, categoryGroupId: string) {
    try {
      setSyncError('')
      await updateCategoryGroupAssignment(workspace.workspaceId, categoryId, categoryGroupId || null)
      setData((current) => ({
        ...current,
        categories: current.categories.map((category) => category.id === categoryId ? { ...category, categoryGroupId: categoryGroupId || undefined } : category),
      }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not change the category group.'))
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
      const resolvedPayees = transaction.type === 'transfer' ? [] : await ensurePayees(workspace.workspaceId, [transaction.payee])
      const resolvedPayee = resolvedPayees[0]
      const createdPayee = resolvedPayee && !data.payees.some((payee) => payee.id === resolvedPayee.id)
      if (createdPayee && transaction.categoryId) await updatePayeeDefaults(workspace.workspaceId, resolvedPayee.id, transaction.categoryId, transaction.accountId)
      const payeeWithDefaults = createdPayee && resolvedPayee ? { ...resolvedPayee, defaultCategoryId: transaction.categoryId, defaultAccountId: transaction.accountId } : resolvedPayee
      const nextTransaction = { ...transaction, id: uid(), payeeId: resolvedPayee?.id }
      await createTransaction(workspace.workspaceId, nextTransaction)
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
        const signedAmount = transaction.type === 'income' ? transaction.amountMinor : -transaction.amountMinor
        return account.id === transaction.accountId ? { ...account, balanceMinor: account.balanceMinor + signedAmount } : account
      }),
    }))
    setModal(null)
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Could not save the transaction.')
    }
  }

  async function changeTransactionDetails(transactionId: string, payeeName: string, payeeId: string | undefined, categoryId: string, rememberDefault: boolean, rememberMapping: boolean, mappingSource: string, matchingTransactionIds: string[]) {
    try {
      setSyncError('')
      const selectedPayee = payeeId ? data.payees.find((payee) => payee.id === payeeId) : undefined
      const [payee] = selectedPayee ? [selectedPayee] : await ensurePayees(workspace.workspaceId, [payeeName])
      const createdPayee = !data.payees.some((item) => item.id === payee.id)
      const transaction = data.transactions.find((item) => item.id === transactionId)
      await updateTransactionDetails(workspace.workspaceId, transactionId, payee.id, categoryId)
      await updateTransactionCategories(workspace.workspaceId, matchingTransactionIds, categoryId)
      if (createdPayee && transaction) await updatePayeeDefaults(workspace.workspaceId, payee.id, categoryId, transaction.accountId)
      else if (rememberDefault) await updatePayeeDefaultCategory(workspace.workspaceId, payee.id, categoryId)
      if (rememberMapping && mappingSource.trim()) {
        try {
          const normalizedSource = normalizedPayeeName(mappingSource)
          const existingMapping = data.payeeMappings.find((mapping) => normalizedPayeeName(mapping.sourceName) === normalizedSource)
          if (existingMapping && existingMapping.payeeId !== payee.id) await updatePayeeMapping(workspace.workspaceId, existingMapping.id, mappingSource, payee.id, existingMapping.matchType)
          else if (!existingMapping) await createPayeeMapping(workspace.workspaceId, mappingSource, payee.id)
        } catch (mappingError) {
          const refreshed = await loadWorkspace()
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
        transactions: current.transactions.map((transaction) => transaction.id === transactionId ? { ...transaction, payeeId: payee.id, payee: payee.name, categoryId } : matchingTransactionIds.includes(transaction.id) ? { ...transaction, categoryId } : transaction),
      }))
      setCategoryTarget(null)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not update the transaction.'))
    }
  }

  async function mapUnmatchedPayee(sourceName: string, payeeId: string) {
    try {
      setSyncError('')
      await assignPayeeMapping(workspace.workspaceId, sourceName, payeeId)
      const refreshed = await loadWorkspace()
      setData(refreshed.data)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not map the transaction description.'))
      throw error
    }
  }

  async function createPayeeFromUnmatched(sourceName: string, payeeName: string, categoryId: string, accountId: string) {
    try {
      setSyncError('')
      const payee: Payee = { id: uid(), name: payeeName.normalize('NFKC').trim(), defaultCategoryId: categoryId, defaultAccountId: accountId }
      await createPayee(workspace.workspaceId, payee, data.payees.length)
      await assignPayeeMapping(workspace.workspaceId, sourceName, payee.id)
      const refreshed = await loadWorkspace()
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

  async function addPayeeMapping(payeeId: string, sourceName: string) {
    try {
      setSyncError('')
      await createPayeeMapping(workspace.workspaceId, sourceName, payeeId)
      const refreshed = await loadWorkspace()
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
            const refreshed = await loadWorkspace()
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
          } catch (mappingError) {
            const refreshed = await loadWorkspace()
            setData(refreshed.data)
            setSyncError(`Transaction approved, but its bank description could not be saved as a mapping: ${getErrorMessage(mappingError, 'Unknown error')}`)
            return
          }
        }
      }
      else await rejectBankImportCandidate(workspace.workspaceId, candidateId)
      const refreshed = await loadWorkspace()
      setData(refreshed.data)
    } catch (error) {
      setSyncError(getErrorMessage(error, `Could not ${decision} the bank transaction.`))
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
          {accountsByBalanceSheetGroup.map(({ group, accounts }) => accounts.length > 0 && <SidebarAccountGroup key={group} label={group} accounts={accounts} open={openAccountGroups[group]} onToggle={() => setOpenAccountGroups((current) => ({ ...current, [group]: !current[group] }))} selectedAccountId={selectedAccount?.id} onSelect={(id) => goTo(`/accounts/${id}`)} />)}
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

        {page === 'transactions' && (
          <TransactionsPage transactions={transactions} allTransactions={data.transactions} accounts={data.accounts} categories={data.categories} search={search} setSearch={setSearch} onEditCategory={setCategoryTarget} />
        )}
        {page === 'payees' && !selectedPayee && (
          <PayeesPage payees={data.payees} mappings={data.payeeMappings} transactions={data.transactions} categories={data.categories} accounts={data.accounts} onSelectPayee={(id) => goTo(`/payees/${id}`)} onMapPayee={mapUnmatchedPayee} onCreatePayee={createPayeeFromUnmatched} />
        )}
        {page === 'budgets' && !selectedCategory && (
          <BudgetsPage categories={data.categories} categoryGroups={data.categoryGroups} categorySpending={categorySpending} budgetForCategory={budgetForCategory} totalBalance={totalBalance} income={income} expenses={expenses} estimatedCompanyTax={estimatedCompanyTax} actualResult={actualResult} plannedIncome={plannedIncome} plannedExpenses={plannedExpenses} plannedCompanyTax={plannedCompanyTax} plannedResult={plannedResult} defaultCurrency={workspace.defaultCurrency} taxRateBps={data.settings.estimatedCompanyTaxRateBps} onUpdateTaxRate={changeTaxRate} onAdd={() => setModal('category')} onManageGroups={() => setModal('category-groups')} onSelectCategory={(id) => goTo(`/categories/${id}`)} onUnhideCategory={(id) => setCategoryHidden(id, false)} />
        )}
        {page === 'reports' && (
          <ReportsPage data={data} viewedMonth={viewedMonth} defaultCurrency={workspace.defaultCurrency} onUpdateTaxRate={changeTaxRate} />
        )}
        {page === 'accounts' && !selectedAccount && (
          <AccountsPage accounts={activeAccounts} totalBalance={totalBalance} defaultCurrency={workspace.defaultCurrency} onAdd={() => setModal('account')} onSelectAccount={(id) => goTo(`/accounts/${id}`)} onReorder={reorderAccounts} />
        )}
        {selectedAccount && (
          <AccountDetailPage account={selectedAccount} transactions={transactions.filter((transaction) => transaction.accountId === selectedAccount.id || transaction.toAccountId === selectedAccount.id)} candidates={data.bankImportCandidates.filter((candidate) => candidate.accountId === selectedAccount.id)} categories={data.categories} payees={data.payees} mappings={data.payeeMappings} accounts={data.accounts} onBack={() => goTo('/accounts')} onSelectAccount={(id) => goTo(`/accounts/${id}`)} onEditAccount={() => { setAccountTarget(selectedAccount); setModal('edit-account') }} onLinkBank={() => { setBankTarget(selectedAccount); setModal('bank') }} onSyncBank={() => syncBank(selectedAccount)} onImportModeChange={(mode) => changeBankImportMode(selectedAccount.id, mode)} onReviewCandidate={decideBankImportCandidate} onCreatePayee={createPayeeForReview} onPromoteMapping={promotePayeeMapping} onUnhideCategory={(categoryId) => setCategoryHidden(categoryId, false)} onEditTransaction={setCategoryTarget} reviewingCandidateId={reviewingCandidateId} syncing={syncingAccountId === selectedAccount.id} syncNotice={syncNotice?.accountId === selectedAccount.id ? syncNotice.message : ''} />
        )}
        {selectedCategory && (
          <CategoryDetailPage category={selectedCategory} spent={categorySpending(selectedCategory.id)} budget={budgetForCategory(selectedCategory.id)} transactions={transactions.filter((transaction) => transaction.categoryId === selectedCategory.id)} allTimeTransactionCount={data.transactions.filter((transaction) => transaction.categoryId === selectedCategory.id).length} categories={data.categories} categoryGroups={data.categoryGroups} accounts={data.accounts} onUpdateBudget={updateBudget} onUpdateGroup={changeCategoryGroup} onRename={() => setModal('edit-category')} onDelete={removeUnusedCategory} onSetHidden={setCategoryHidden} onBack={() => goTo('/')} onSelectCategory={(id) => goTo(`/categories/${id}`)} onEditTransaction={setCategoryTarget} />
        )}
        {selectedPayee && (
          <PayeeDetailPage key={selectedPayee.id} payee={selectedPayee} payees={data.payees} mappings={data.payeeMappings.filter((mapping) => mapping.payeeId === selectedPayee.id)} transactions={data.transactions.filter((transaction) => transaction.payeeId === selectedPayee.id)} categories={data.categories} accounts={data.accounts} onBack={() => goTo('/payees')} onEditTransaction={setCategoryTarget} onUpdateDefaults={changePayeeDefaults} onAddMapping={addPayeeMapping} onUpdateMapping={changePayeeMapping} onRemoveMapping={removePayeeMapping} />
        )}
      </main>

      {modal && (
        <ModalShell title={modal === 'transaction' ? 'Add transaction' : modal === 'account' ? 'Create account' : modal === 'edit-account' ? 'Edit account' : modal === 'category' ? 'Create category' : modal === 'edit-category' ? 'Rename category' : modal === 'category-groups' ? 'Manage category groups' : `Connect ${bankTarget?.name ?? 'account'}`} onClose={() => { setModal(null); setAccountTarget(null) }}>
          {modal === 'transaction' && <TransactionForm accounts={activeAccounts} categories={data.categories.filter((category) => !category.hidden)} payees={data.payees} onSubmit={addTransaction} />}
          {modal === 'account' && <AccountForm onSubmit={addAccount} />}
          {modal === 'edit-account' && accountTarget && <AccountForm account={accountTarget} onSubmit={(changes) => editAccount({ ...accountTarget, ...changes })} />}
          {modal === 'category' && <CategoryForm categoryGroups={data.categoryGroups} onSubmit={addCategory} />}
          {modal === 'edit-category' && selectedCategory && <CategoryNameForm category={selectedCategory} categories={data.categories} onSubmit={renameCategory} />}
          {modal === 'category-groups' && <CategoryGroupsForm groups={data.categoryGroups} categories={data.categories} onAdd={addCategoryGroup} onRename={renameCategoryGroup} onReorder={reorderCategoryGroups} onRemove={removeCategoryGroup} />}
          {modal === 'bank' && bankTarget && <BankLinkForm account={bankTarget} workspaceId={workspace.workspaceId} onComplete={() => window.location.reload()} />}
        </ModalShell>
      )}
      {categoryTarget && <ModalShell title="Edit transaction" onClose={() => setCategoryTarget(null)}>
        <TransactionDetailsForm transaction={categoryTarget} transactions={data.transactions} categories={data.categories} payees={data.payees} mappings={data.payeeMappings} onSubmit={(payeeName, payeeId, categoryId, rememberDefault, rememberMapping, mappingSource, matchingTransactionIds) => changeTransactionDetails(categoryTarget.id, payeeName, payeeId, categoryId, rememberDefault, rememberMapping, mappingSource, matchingTransactionIds)} />
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

function HiddenCategoryActivityAlert({ categories, categorySpending, onSelectCategory }: { categories: Category[]; categorySpending: (id: string) => number; onSelectCategory: (id: string) => void }) {
  const affectedCategories = categories
    .map((category) => ({ category, balance: categorySpending(category.id) }))
    .filter(({ category, balance }) => category.hidden && balance !== 0)
    .sort((left, right) => Math.abs(right.balance) - Math.abs(left.balance))

  if (!affectedCategories.length) return null

  return <div className="hidden-category-activity-alert" role="alert">
    <ShieldAlert size={19} />
    <div>
      <strong>Hidden {affectedCategories.length === 1 ? 'category has' : 'categories have'} a balance this month</strong>
      <p>Review {affectedCategories.length === 1 ? 'it' : 'them'} so activity does not stay out of sight.</p>
      <div className="hidden-category-activity-items">
        {affectedCategories.map(({ category, balance }) => <button type="button" key={category.id} onClick={() => onSelectCategory(category.id)}>{category.name}<b>{formatMoney(balance)}</b></button>)}
      </div>
    </div>
  </div>
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

function TransactionRow({ transaction, categories, accounts, compact = false, focusAccountId, onEditCategory }: { transaction: Transaction; categories: Category[]; accounts: Account[]; compact?: boolean; focusAccountId?: string; onEditCategory?: () => void }) {
  const category = categories.find((item) => item.id === transaction.categoryId)
  const sourceAccount = accounts.find((item) => item.id === transaction.accountId)
  const destinationAccount = accounts.find((item) => item.id === transaction.toAccountId)
  const isTransfer = transaction.type === 'transfer'
  const transferIsIncoming = isTransfer && transaction.toAccountId === focusAccountId
  const prefix = transaction.type === 'income' || transferIsIncoming ? '+' : transaction.type === 'expense' || (isTransfer && focusAccountId) ? '−' : ''
  const Icon = isTransfer ? ArrowLeftRight : category ? (categoryIcons[category.icon as keyof typeof categoryIcons] ?? Sparkles) : ReceiptText
  return (
    <div className={`${compact ? 'transaction-row compact' : 'transaction-row'}${onEditCategory ? ' editable' : ''}`}>
      <span className="transaction-icon" style={{ color: isTransfer ? '#587486' : category?.color, background: isTransfer ? '#e5ecef' : `${category?.color ?? '#777'}18` }}><Icon size={18} /></span>
      <div>
        <strong>{isTransfer ? `Transfer to ${destinationAccount?.name ?? 'account'}` : transaction.payee}{transaction.posted === false && <em className="pending-badge">Pending</em>}</strong>
        <span>{isTransfer ? `${sourceAccount?.name ?? 'Account'} → ${destinationAccount?.name ?? 'Account'}` : category?.name ?? 'Uncategorised'} · {shortDate.format(new Date(`${transaction.date}T12:00:00`))}</span>
      </div>
      {onEditCategory && <button type="button" className={category ? 'transaction-category-edit' : 'transaction-category-edit missing'} onClick={onEditCategory} aria-label={`Edit ${transaction.payee}`}><Pencil size={12} />Edit</button>}
      <b className={transaction.type === 'income' || transferIsIncoming ? 'positive' : isTransfer && !focusAccountId ? 'transfer-amount' : ''}>{prefix}{formatMoney(transaction.amountMinor, transaction.currency)}</b>
    </div>
  )
}

function TransactionsPage({ transactions, allTransactions, accounts, categories, search, setSearch, onEditCategory }: { transactions: Transaction[]; allTransactions: Transaction[]; accounts: Account[]; categories: Category[]; search: string; setSearch: (value: string) => void; onEditCategory: (transaction: Transaction) => void }) {
  const [view, setView] = useState<'month' | 'uncategorized'>('month')
  const uncategorized = [...allTransactions]
    .filter((transaction) => transaction.type !== 'transfer' && !transaction.categoryId)
    .sort((left, right) => right.date.localeCompare(left.date))
  const displayed = view === 'uncategorized' ? uncategorized : transactions
  const filtered = displayed.filter((t) => `${t.payee} ${t.note ?? ''} ${categories.find(c => c.id === t.categoryId)?.name ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  return (
    <div className="page-content narrow-page">
      <div className="panel full-panel">
        <div className="panel-heading transaction-heading"><div><span className="eyebrow">Ledger</span><h2>{view === 'uncategorized' ? 'Transactions needing a category' : 'This month’s transactions'}</h2></div><div className="transaction-heading-actions"><div className="segmented transaction-view-toggle"><button type="button" className={view === 'month' ? 'active transfer' : ''} onClick={() => setView('month')}>This month</button><button type="button" className={view === 'uncategorized' ? 'active' : ''} onClick={() => setView('uncategorized')}>Needs category <b>{uncategorized.length}</b></button></div><label className="search-box"><Search size={17} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search transactions" /></label></div></div>
        <div className="table-header"><span>Description</span><span>Account</span><span>Amount</span></div>
        <div className="transaction-list-full">
          {filtered.map((transaction) => (
            <div className="transaction-table-row" key={transaction.id}>
              <TransactionRow transaction={transaction} categories={categories} accounts={accounts} onEditCategory={transaction.type === 'transfer' ? undefined : () => onEditCategory(transaction)} />
              <span className="account-name">{accounts.find((a) => a.id === transaction.accountId)?.name}{transaction.type === 'transfer' ? ` → ${accounts.find((a) => a.id === transaction.toAccountId)?.name ?? ''}` : ''}</span>
            </div>
          ))}
          {!filtered.length && <div className="empty-state"><ReceiptText size={28} /><h3>{view === 'uncategorized' && !search ? 'Everything is categorized' : 'No transactions found'}</h3><p>{view === 'uncategorized' && !search ? 'All non-transfer transactions have a category.' : 'Try a different search or add a new transaction.'}</p></div>}
        </div>
      </div>
    </div>
  )
}

type PayeeSort = 'transactions' | 'alphabetical'

function PayeesPage({ payees, mappings, transactions, categories, accounts, onSelectPayee, onMapPayee, onCreatePayee }: {
  payees: Payee[]
  mappings: PayeeMapping[]
  transactions: Transaction[]
  categories: Category[]
  accounts: Account[]
  onSelectPayee: (id: string) => void
  onMapPayee: (sourceName: string, payeeId: string) => Promise<void>
  onCreatePayee: (sourceName: string, payeeName: string, categoryId: string, accountId: string) => Promise<void>
}) {
  const [sort, setSort] = useState<PayeeSort>('transactions')
  const [search, setSearch] = useState('')
  const [mappingTargets, setMappingTargets] = useState<Record<string, string>>({})
  const [payeeQueries, setPayeeQueries] = useState<Record<string, string>>({})
  const [newPayeeNames, setNewPayeeNames] = useState<Record<string, string>>({})
  const [newPayeeCategories, setNewPayeeCategories] = useState<Record<string, string>>({})
  const [newPayeeAccounts, setNewPayeeAccounts] = useState<Record<string, string>>({})
  const [mappingErrors, setMappingErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState('')
  const unmatchedByName = new Map<string, { sourceName: string; count: number; lastTransaction: string; categoryIds: string[]; accountIds: string[] }>()
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
      categoryIds: [...new Set([...(current?.categoryIds ?? []), ...(transaction.categoryId ? [transaction.categoryId] : [])])],
      accountIds: [...new Set([...(current?.accountIds ?? []), transaction.accountId])],
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
          const newCategoryId = newPayeeCategories[key] ?? (item.categoryIds.length === 1 ? item.categoryIds[0] : '')
          const newAccountId = newPayeeAccounts[key] ?? (item.accountIds.length === 1 ? item.accountIds[0] : '')
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
      <div className="payee-table-header"><span>Payee</span><span>Last transaction</span><span>Transactions</span></div>
      <div className="payee-list">
        {rows.map(({ payee, count, lastTransaction }) => <button type="button" className="payee-row" key={payee.id} onClick={() => onSelectPayee(payee.id)}>
          <span className="payee-avatar">{payee.name.slice(0, 1).toLocaleUpperCase('en')}</span>
          <span className="payee-name"><strong>{payee.name}</strong><small>{categories.find((category) => category.id === payee.defaultCategoryId)?.name ?? 'No category default'} · {accounts.find((account) => account.id === payee.defaultAccountId)?.name ?? 'No account default'} · {mappings.filter((mapping) => mapping.payeeId === payee.id).length} alternative name{mappings.filter((mapping) => mapping.payeeId === payee.id).length === 1 ? '' : 's'}</small></span>
          <span className="payee-last">{lastTransaction ? shortDate.format(new Date(`${lastTransaction}T12:00:00`)) : '—'}</span>
          <span className="payee-count">{count}</span>
          <ChevronRight size={17} />
        </button>)}
        {!rows.length && <div className="empty-state"><UsersRound size={28} /><h3>No payees found</h3><p>{search ? 'Try a different search.' : 'Payees will appear when transactions are added.'}</p></div>}
      </div>
    </div>
  </div>
}

function PayeeDetailPage({ payee, payees, mappings, transactions, categories, accounts, onBack, onEditTransaction, onUpdateDefaults, onAddMapping, onUpdateMapping, onRemoveMapping }: { payee: Payee; payees: Payee[]; mappings: PayeeMapping[]; transactions: Transaction[]; categories: Category[]; accounts: Account[]; onBack: () => void; onEditTransaction: (transaction: Transaction) => void; onUpdateDefaults: (payeeId: string, categoryId: string, accountId: string) => Promise<void>; onAddMapping: (payeeId: string, sourceName: string) => Promise<void>; onUpdateMapping: (mappingId: string, sourceName: string, payeeId: string, matchType: PayeeMapping['matchType']) => Promise<void>; onRemoveMapping: (mappingId: string) => Promise<void> }) {
  const sortedTransactions = [...transactions].sort((left, right) => right.date.localeCompare(left.date))
  const expenseCount = transactions.filter((transaction) => transaction.type === 'expense').length
  const incomeCount = transactions.filter((transaction) => transaction.type === 'income').length
  const [defaultCategoryId, setDefaultCategoryId] = useState(payee.defaultCategoryId ?? '')
  const [defaultAccountId, setDefaultAccountId] = useState(payee.defaultAccountId ?? '')
  const [newMapping, setNewMapping] = useState('')
  const [savingDefaults, setSavingDefaults] = useState(false)
  const [addingMapping, setAddingMapping] = useState(false)
  const [error, setError] = useState('')
  const defaultsChanged = defaultCategoryId !== (payee.defaultCategoryId ?? '') || defaultAccountId !== (payee.defaultAccountId ?? '')
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
          <TransactionRow transaction={transaction} categories={categories} accounts={accounts} onEditCategory={transaction.type === 'transfer' ? undefined : () => onEditTransaction(transaction)} />
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

function BudgetSummaryItem({ label, actual, planned, currency, tone }: { label: string; actual: number; planned?: number; currency: string; tone?: string }) {
  return <div className={`budget-summary-item ${tone ?? ''}`}><span>{label}</span><strong>{formatMoney(actual, currency)}</strong>{planned !== undefined && <small>Plan {formatMoney(planned, currency)}</small>}</div>
}

function BudgetsPage({ categories, categoryGroups, categorySpending, budgetForCategory, totalBalance, income, expenses, estimatedCompanyTax, actualResult, plannedIncome, plannedExpenses, plannedCompanyTax, plannedResult, defaultCurrency, taxRateBps, onUpdateTaxRate, onAdd, onManageGroups, onSelectCategory, onUnhideCategory }: {
  categories: Category[]; categoryGroups: CategoryGroup[]; categorySpending: (id: string) => number; budgetForCategory: (id: string) => number
  totalBalance: number; income: number; expenses: number; estimatedCompanyTax: number; actualResult: number; plannedIncome: number; plannedExpenses: number; plannedCompanyTax: number; plannedResult: number; defaultCurrency: string; taxRateBps: number
  onUpdateTaxRate: (rateBps: number) => void; onAdd: () => void; onManageGroups: () => void; onSelectCategory: (id: string) => void; onUnhideCategory: (id: string) => Promise<void>
}) {
  const [showHiddenOnly, setShowHiddenOnly] = useState(false)
  const visibleCategories = categories.filter((category) => !category.hidden)
  const hiddenCategories = categories.filter((category) => category.hidden)
  const incomeCategories = visibleCategories.filter((category) => category.reportGroup === 'income')
  const expenseCategories = visibleCategories.filter((category) => category.reportGroup === 'expense')
  const taxCategories = visibleCategories.filter((category) => category.reportGroup === 'tax')
  const groupedRows = (rows: Category[]) => {
    const knownGroups = categoryGroups.map((group) => ({ group, rows: rows.filter((category) => category.categoryGroupId === group.id) })).filter((item) => item.rows.length > 0)
    const ungrouped = rows.filter((category) => !category.categoryGroupId || !categoryGroups.some((group) => group.id === category.categoryGroupId))
    return [...knownGroups, ...(ungrouped.length ? [{ group: { id: 'ungrouped', name: 'Other', sortOrder: 999, showCategories: true }, rows: ungrouped }] : [])]
  }
  const section = (title: string, subtitle: string, rows: Category[]) => <section className="budget-section"><div className="budget-section-heading"><div><h3>{title}</h3><span>{subtitle}</span></div></div>{groupedRows(rows).map(({ group, rows: groupCategories }) => <div className="category-group-block" key={group.id}><div className="category-group-label">{group.name}</div><div className="category-list roomy">{groupCategories.map((category) => <CategoryRow key={category.id} category={category} spent={categorySpending(category.id)} budget={budgetForCategory(category.id)} onSelect={() => onSelectCategory(category.id)} />)}</div></div>)}</section>
  const hiddenSection = <section className="budget-section"><div className="budget-section-heading"><div><h3>Hidden categories</h3><span>Unhide categories you want to return to active planning and new transactions</span></div></div>{groupedRows(hiddenCategories).map(({ group, rows }) => <div className="category-group-block" key={group.id}><div className="category-group-label">{group.name}</div><div className="category-list roomy">{rows.map((category) => <HiddenCategoryBudgetRow key={category.id} category={category} spent={categorySpending(category.id)} budget={budgetForCategory(category.id)} onSelect={() => onSelectCategory(category.id)} onUnhide={() => onUnhideCategory(category.id)} />)}</div></div>)}</section>
  return <div className="page-content narrow-page">
    {!showHiddenOnly && <section className="panel budget-dashboard-summary">
      <div className="budget-dashboard-heading"><div><span className="eyebrow">Personal + company</span><h2>Monthly position</h2><p>Internal transfers are excluded.</p></div><label className="budget-tax-rate"><span>Company tax estimate</span><div><input aria-label="Company tax planning rate" type="number" min="0" max="100" step="0.1" value={taxRateBps / 100} onChange={(event) => onUpdateTaxRate(Math.max(0, Math.round(Number(event.target.value) * 100)))} /><b>%</b></div></label></div>
      <div className="budget-summary-grid">
        <BudgetSummaryItem label="Provisional balance" actual={totalBalance} currency={defaultCurrency} />
        <BudgetSummaryItem label="Income" actual={income} planned={plannedIncome} currency={defaultCurrency} tone="positive-summary" />
        <BudgetSummaryItem label="Expenses" actual={expenses} planned={plannedExpenses} currency={defaultCurrency} />
        <BudgetSummaryItem label="Estimated company tax" actual={estimatedCompanyTax} planned={plannedCompanyTax} currency={defaultCurrency} />
        <BudgetSummaryItem label="Result" actual={actualResult} planned={plannedResult} currency={defaultCurrency} tone={actualResult < 0 ? 'negative-summary' : 'result-summary'} />
      </div>
    </section>}
    <HiddenCategoryActivityAlert categories={categories} categorySpending={categorySpending} onSelectCategory={onSelectCategory} />
    <div className="panel full-panel"><div className="panel-heading"><div><span className="eyebrow">Monthly plan</span><h2>{showHiddenOnly ? 'Hidden categories' : 'Budget by category'}</h2></div><div className="budget-page-actions">{hiddenCategories.length > 0 && <button className="text-button" onClick={() => setShowHiddenOnly((current) => !current)}>{showHiddenOnly ? <EyeOff size={16} /> : <Eye size={16} />}{showHiddenOnly ? 'Show active categories' : `Show hidden only (${hiddenCategories.length})`}</button>}<button className="secondary-button" onClick={onManageGroups}><Settings size={16} />Manage groups</button><button className="secondary-button" onClick={onAdd}><Plus size={17} />New category</button></div></div>{showHiddenOnly ? hiddenSection : <>{section('Planned income', 'Actual income compared with this month’s plan', incomeCategories)}{section('Expense budgets', 'Net spending compared with this month’s budget', expenseCategories)}{taxCategories.length > 0 && section('Tax plan', 'Recorded tax costs compared with this month’s plan', taxCategories)}</>}</div>
  </div>
}

type ReportPeriod = 'month' | 'year'

function ReportsPage({ data, viewedMonth, defaultCurrency, onUpdateTaxRate }: { data: AppData; viewedMonth: Date; defaultCurrency: string; onUpdateTaxRate: (rateBps: number) => void }) {
  const [period, setPeriod] = useState<ReportPeriod>('month')
  const monthKey = toMonthKey(viewedMonth)
  const yearKey = String(viewedMonth.getFullYear())
  const categoryById = new Map(data.categories.map((category) => [category.id, category]))
  const companyCategoryGroupIds = new Set(data.categoryGroups.filter((group) => group.name.toLocaleLowerCase('en') === 'company').map((group) => group.id))
  const isCompanyCategory = (categoryId?: string) => {
    const categoryGroupId = categoryById.get(categoryId ?? '')?.categoryGroupId
    return Boolean(categoryGroupId && companyCategoryGroupIds.has(categoryGroupId))
  }
  const inPeriod = (date: string) => period === 'month' ? date.startsWith(monthKey) : date.startsWith(yearKey)
  const reportTransactions = data.transactions.filter((transaction) => transaction.currency === defaultCurrency && inPeriod(transaction.date) && transaction.type !== 'transfer')
  const companyTransactions = reportTransactions.filter((transaction) => isCompanyCategory(transaction.categoryId))
  const budgetInPeriod = (month: string) => period === 'month' ? month === monthKey : month.startsWith(yearKey)
  const reportBudgets = data.budgets.filter((budget) => budgetInPeriod(budget.month))
  const companyBudgets = data.budgets.filter((budget) => budgetInPeriod(budget.month) && isCompanyCategory(budget.categoryId))

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
  const companyTaxEstimate = estimatedTax(companyActualProfit)
  const actualExcludingGains = actualIncome - actualExpenses - recordedTaxes - companyTaxEstimate
  const actualIncludingGains = actualExcludingGains + capitalGains

  const forecastIncome = totalBudgetsForGroup(reportBudgets, 'income')
  const forecastExpenses = totalBudgetsForGroup(reportBudgets, 'expense')
  const plannedTaxes = totalBudgetsForGroup(reportBudgets, 'tax')
  const companyForecastProfit = totalBudgetsForGroup(companyBudgets, 'income') - totalBudgetsForGroup(companyBudgets, 'expense')
  const forecastTax = estimatedTax(companyForecastProfit)
  const forecastExcludingGains = forecastIncome - forecastExpenses - plannedTaxes - forecastTax

  return <div className="page-content narrow-page report-page">
    <div className="report-toolbar">
      <span className="report-scope-label">Personal + company</span>
      <div className="segmented"><button className={period === 'month' ? 'active transfer' : ''} onClick={() => setPeriod('month')}>Month</button><button className={period === 'year' ? 'active transfer' : ''} onClick={() => setPeriod('year')}>Year</button></div>
    </div>
    <section className="report-hero">
      <div><span className="eyebrow">Combined performance · {period === 'month' ? monthName.format(viewedMonth) : yearKey}</span><h2>Economic result</h2><p>Your personal and company activity in one P&amp;L. Internal transfers are excluded.</p></div>
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

function AccountsPage({ accounts, totalBalance, defaultCurrency, onAdd, onSelectAccount, onReorder }: { accounts: Account[]; totalBalance: number; defaultCurrency: string; onAdd: () => void; onSelectAccount: (id: string) => void; onReorder: (accountIds: string[]) => Promise<boolean> }) {
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
          <h3>{account.name}</h3><strong>{formatMoney(account.balanceMinor, account.currency)}</strong><p>{accountBalanceSheetGroup(account)} · {account.type} · {account.currency}</p>
          <div className="reorder-card-actions">
            <button className="icon-button" onClick={() => moveAccount(account.id, -1)} disabled={index === 0} aria-label={`Move ${account.name} earlier`}><ArrowUp size={16} /></button>
            <button className="icon-button" onClick={() => moveAccount(account.id, 1)} disabled={index === orderedAccounts.length - 1} aria-label={`Move ${account.name} later`}><ArrowDown size={16} /></button>
          </div>
        </div>
      ))}
    </div> : <div className="balance-sheet-groups">
      {groupedAccounts.map(({ group, accounts: rows }) => {
        const groupBalance = rows.filter((account) => account.currency === defaultCurrency).reduce((sum, account) => sum + account.balanceMinor, 0)
        return <section className="balance-sheet-group" key={group}>
          <div className="balance-sheet-group-heading"><div><span className="eyebrow">Balance sheet</span><h2>{group}</h2></div><strong>{formatMoney(groupBalance, defaultCurrency)}</strong></div>
          <div className="account-card-grid">{rows.map((account) => <button type="button" className="large-account-card" key={account.id} onClick={() => onSelectAccount(account.id)} aria-label={`View ${account.name} transactions`}><div className="large-account-top"><span style={{ background: account.color }}><Banknote size={20} /></span><small>{accountBalanceSheetGroup(account)} · {account.type}</small></div><h3>{account.name}</h3><strong>{formatMoney(account.balanceMinor, account.currency)}</strong><p>Provisional balance · {account.currency}</p></button>)}</div>
        </section>
      })}
    </div>}
  </div>
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}><div className="modal"><div className="modal-heading"><div><span className="eyebrow">Next Expense</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>{children}</div></div>
}

function AccountDetailPage({ account, transactions, candidates, categories, payees, mappings, accounts, onBack, onSelectAccount, onEditAccount, onLinkBank, onSyncBank, onImportModeChange, onReviewCandidate, onCreatePayee, onPromoteMapping, onUnhideCategory, onEditTransaction, reviewingCandidateId, syncing, syncNotice }: { account: Account; transactions: Transaction[]; candidates: BankImportCandidate[]; categories: Category[]; payees: Payee[]; mappings: PayeeMapping[]; accounts: Account[]; onBack: () => void; onSelectAccount: (id: string) => void; onEditAccount: () => void; onLinkBank: () => void; onSyncBank: () => void; onImportModeChange: (mode: 'review' | 'automatic') => void; onReviewCandidate: (candidateId: string, decision: 'approve' | 'reject', categoryId?: string, rememberCategory?: boolean, payeeId?: string | null, rememberMapping?: boolean, bankDescription?: string, createdPayee?: boolean, defaultAccountId?: string) => void; onCreatePayee: (name: string, categoryId: string, accountId: string) => Promise<Payee>; onPromoteMapping: (mappingId: string) => Promise<void>; onUnhideCategory: (categoryId: string) => Promise<void>; onEditTransaction: (transaction: Transaction) => void; reviewingCandidateId: string; syncing: boolean; syncNotice: string }) {
  return <div className="page-content narrow-page entity-page">
    <div className="entity-page-toolbar">
      <button className="entity-back" onClick={onBack}><ChevronLeft size={16} />All accounts</button>
      <label><span>Account</span><select value={account.id} onChange={(event) => onSelectAccount(event.target.value)}>{accounts.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
    </div>
    <section className="panel entity-detail-panel">
      <div className="entity-heading"><div className="entity-heading-icon" style={{ background: account.color }}><CreditCard size={20} /></div><div><span className="eyebrow">{accountBalanceSheetGroup(account)} · {account.type}{account.providerAccountId ? ' · Bank connected' : ''}</span><h2>{account.name}</h2></div><div className="entity-heading-actions"><button className="secondary-button" onClick={onEditAccount}><Pencil size={16} />Edit account</button>{account.providerAccountId && <button className="primary-button" disabled={syncing} onClick={onSyncBank}>{syncing ? <LoaderCircle className="spin-icon" size={16} /> : <RefreshCw size={16} />}{syncing ? 'Syncing…' : 'Sync now'}</button>}<button className="secondary-button" onClick={onLinkBank}><Link2 size={16} />{account.providerAccountId ? 'Reconnect' : 'Connect bank'}</button></div></div>
      {account.providerAccountId && <div className="bank-sync-status"><div><strong>{account.connectionStatus === 'active' ? 'Bank connection active' : 'Bank connected'}</strong><span>{account.lastSyncedAt ? `Last synced ${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(account.lastSyncedAt))}` : 'Not synced yet'}</span>{account.lastSyncDiagnostic && !syncNotice && <span>{formatSyncDiagnostic(account.lastSyncDiagnostic)}</span>}</div><span>{syncNotice || formatRateLimits(account)}</span></div>}
      {account.providerAccountId && <BankImportReview account={account} candidates={candidates} categories={categories} payees={payees} mappings={mappings} reviewingCandidateId={reviewingCandidateId} onModeChange={onImportModeChange} onReview={onReviewCandidate} onCreatePayee={onCreatePayee} onPromoteMapping={onPromoteMapping} onUnhideCategory={onUnhideCategory} />}
      <AccountDetail account={account} transactions={transactions} categories={categories} accounts={accounts} onEditTransaction={onEditTransaction} />
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

function BankImportReview({ account, candidates, categories, payees, mappings, reviewingCandidateId, onModeChange, onReview, onCreatePayee, onPromoteMapping, onUnhideCategory }: { account: Account; candidates: BankImportCandidate[]; categories: Category[]; payees: Payee[]; mappings: PayeeMapping[]; reviewingCandidateId: string; onModeChange: (mode: 'review' | 'automatic') => void; onReview: (candidateId: string, decision: 'approve' | 'reject', categoryId?: string, rememberCategory?: boolean, payeeId?: string | null, rememberMapping?: boolean, bankDescription?: string, createdPayee?: boolean, defaultAccountId?: string) => void; onCreatePayee: (name: string, categoryId: string, accountId: string) => Promise<Payee>; onPromoteMapping: (mappingId: string) => Promise<void>; onUnhideCategory: (categoryId: string) => Promise<void> }) {
  const mode = account.bankImportMode ?? 'review'
  const [categoryAssignments, setCategoryAssignments] = useState<Record<string, string>>({})
  const [payeeAssignments, setPayeeAssignments] = useState<Record<string, string>>({})
  const [rememberChoices, setRememberChoices] = useState<Record<string, boolean>>({})
  const [mappingChoices, setMappingChoices] = useState<Record<string, boolean>>({})
  const [createdPayeeIds, setCreatedPayeeIds] = useState<Record<string, string>>({})
  const [promotingMappingId, setPromotingMappingId] = useState('')
  const [unhidingCategoryId, setUnhidingCategoryId] = useState('')
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
      <div className="bank-review-summary"><strong>{candidates.length} awaiting review</strong><span>Net effect if approved: {formatMoney(pendingNet, account.currency)}</span></div>
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
        return <div className="bank-review-row" key={candidate.id}>
          <div className="bank-review-description"><strong>{selectedPayee?.name ?? candidate.payee}{candidate.posted ? null : <em className="pending-badge">Pending</em>}</strong><span>{shortDate.format(new Date(`${candidate.date}T12:00:00Z`))} · {selectedPayee ? `Bank: ${candidate.payee}` : 'Bank description'}{distinctNote ? ` · ${distinctNote}` : ''}</span><em className={selectedPayee ? 'payee-match-badge matched' : 'payee-match-badge'}>{selectedPayee ? 'Matched payee' : 'New payee on approval'}</em></div>
          <b className={candidate.type === 'income' ? 'positive' : ''}>{candidate.type === 'income' ? '+' : '−'}{formatMoney(candidate.amountMinor, candidate.currency)}</b>
          <div className="bank-review-payee">
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
            {suggestedMapping && suggestedPayee && <div className="prefix-match-suggestion"><Sparkles size={13} /><p><strong>Possible match: {suggestedPayee.name}</strong><span>“{suggestedMapping.mapping.sourceName}” matches the start of the {suggestedMapping.sourceText === candidate.note ? 'bank memo' : 'bank description'}.</span><button type="button" disabled={Boolean(promotingMappingId)} onClick={async () => {
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
            }}>{promotingMappingId === suggestedMapping.mapping.id ? 'Updating…' : 'Use Starts with and select payee'}</button></p></div>}
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
          </div>
          <div className="bank-review-actions">
            <button className="secondary-button" type="button" disabled={Boolean(reviewingCandidateId)} onClick={() => onReview(candidate.id, 'reject')}><X size={14} />Reject</button>
            <button className="primary-button" type="button" disabled={!categoryId || Boolean(hiddenCategory) || Boolean(reviewingCandidateId)} onClick={() => onReview(candidate.id, 'approve', categoryId, rememberCategory, payeeId || null, offerMapping && rememberMapping, candidate.payee, createdPayeeIds[candidate.id] === payeeId, account.id)}>{reviewingCandidateId === candidate.id ? <LoaderCircle className="spin-icon" size={14} /> : <Check size={14} />}Approve</button>
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

function CategoryDetailPage({ category, spent, budget, transactions, allTimeTransactionCount, categories, categoryGroups, accounts, onUpdateBudget, onUpdateGroup, onRename, onDelete, onSetHidden, onBack, onSelectCategory, onEditTransaction }: { category: Category; spent: number; budget: number; transactions: Transaction[]; allTimeTransactionCount: number; categories: Category[]; categoryGroups: CategoryGroup[]; accounts: Account[]; onUpdateBudget: (categoryId: string, amountMinor: number, scope: AccountScope) => void; onUpdateGroup: (categoryId: string, categoryGroupId: string) => Promise<void>; onRename: () => void; onDelete: (categoryId: string) => Promise<void>; onSetHidden: (categoryId: string, hidden: boolean) => void; onBack: () => void; onSelectCategory: (id: string) => void; onEditTransaction: (transaction: Transaction) => void }) {
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
      <div className="entity-heading"><div className="entity-heading-icon" style={{ color: category.color, background: `${category.color}18` }}><Icon size={20} /></div><div><span className="eyebrow">{category.reportGroup.replace('_', ' ')}{category.hidden ? ' · Hidden' : ''}</span><h2>{category.name}</h2></div><div className="entity-heading-actions"><button className="secondary-button" type="button" onClick={onRename}><Pencil size={16} />Rename</button><button className="secondary-button" type="button" onClick={() => onSetHidden(category.id, !category.hidden)}>{category.hidden ? <Eye size={16} /> : <EyeOff size={16} />}{category.hidden ? 'Unhide category' : 'Hide category'}</button>{allTimeTransactionCount === 0 && <button className={confirmingDelete ? 'danger-button confirming' : 'danger-button'} type="button" disabled={deleting} onClick={async () => {
        if (!confirmingDelete) { setConfirmingDelete(true); setDeleteError(''); return }
        setDeleting(true)
        try { await onDelete(category.id) } catch (cause) { setDeleteError(getErrorMessage(cause, 'Could not delete the category.')); setDeleting(false); setConfirmingDelete(false) }
      }}><Trash2 size={16} />{deleting ? 'Deleting…' : confirmingDelete ? 'Confirm delete' : 'Delete'}</button>}</div></div>
      {confirmingDelete && !deleting && <div className="category-delete-confirmation"><span>Deleting this category will also remove its budgets and clear it from payee defaults.</span><button type="button" onClick={() => setConfirmingDelete(false)}>Cancel</button></div>}
      {deleteError && <p className="auth-error" role="alert">{deleteError}</p>}
      <CategoryGroupAssignment key={`${category.id}-${category.categoryGroupId ?? 'none'}`} category={category} groups={categoryGroups} onSubmit={onUpdateGroup} />
      <CategoryDetail key={`${category.id}-${budget}`} category={category} spent={spent} budget={budget} transactions={transactions} categories={categories} accounts={accounts} onUpdateBudget={onUpdateBudget} onEditTransaction={onEditTransaction} />
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

function CategoryDetail({ category, spent, budget, transactions, categories, accounts, onUpdateBudget, onEditTransaction }: { category: Category; spent: number; budget: number; transactions: Transaction[]; categories: Category[]; accounts: Account[]; onUpdateBudget: (categoryId: string, amountMinor: number, scope: AccountScope) => void; onEditTransaction: (transaction: Transaction) => void }) {
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
      {transactions.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} categories={categories} accounts={accounts} onEditCategory={() => onEditTransaction(transaction)} />)}
      {!transactions.length && <div className="empty-state compact-empty"><ReceiptText size={24} /><h3>No transactions yet</h3></div>}
    </div>
  </div>
}

function AccountDetail({ account, transactions, categories, accounts, onEditTransaction }: { account: Account; transactions: Transaction[]; categories: Category[]; accounts: Account[]; onEditTransaction: (transaction: Transaction) => void }) {
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
      {transactions.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} categories={categories} accounts={accounts} focusAccountId={account.id} onEditCategory={transaction.type === 'transfer' ? undefined : () => onEditTransaction(transaction)} />)}
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

function TransactionDetailsForm({ transaction, transactions, categories, payees, mappings, onSubmit }: { transaction: Transaction; transactions: Transaction[]; categories: Category[]; payees: Payee[]; mappings: PayeeMapping[]; onSubmit: (payeeName: string, payeeId: string | undefined, categoryId: string, rememberDefault: boolean, rememberMapping: boolean, mappingSource: string, matchingTransactionIds: string[]) => Promise<void> }) {
  const [categoryId, setCategoryId] = useState(transaction.categoryId ?? '')
  const [payeeQuery, setPayeeQuery] = useState(transaction.payee)
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
  const changed = payeeChanged || categoryId !== transaction.categoryId
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
    .filter((item) => item.id !== transaction.id && item.type !== 'transfer')
    .filter((item) => selectedPayeeId ? item.payeeId === selectedPayeeId : normalizedPayeeName(item.payee) === normalizedTargetPayee)
    .sort((left, right) => right.date.localeCompare(left.date))
  const selectableRelated = relatedTransactions.filter((item) => item.categoryId !== categoryId)
  const selectedRelatedCount = selectableRelated.filter((item) => selectedRelatedIds.includes(item.id)).length
  const showRelatedTransactions = Boolean(categoryId && categoryId !== transaction.categoryId && relatedTransactions.length)

  return <form className="form" onSubmit={async (event) => { event.preventDefault(); if (!categoryId || !payeeQuery.trim()) return; setSaving(true); try { await onSubmit(payeeQuery.trim(), selectedPayee?.id, categoryId, rememberDefault, offerMapping && rememberMapping, bankMappingSource, selectedRelatedIds.filter((id) => selectableRelated.some((item) => item.id === id))) } finally { setSaving(false) } }}>
    <div className="category-edit-transaction">
      <span className="transaction-icon"><ReceiptText size={18} /></span>
      <div><strong>{transaction.payee}</strong><span>{shortDate.format(new Date(`${transaction.date}T12:00:00`))} · {formatMoney(transaction.amountMinor, transaction.currency)}</span></div>
    </div>
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
    {selectedCategory?.hidden && <p className="category-edit-warning"><ShieldAlert size={15} />This category is hidden. Choose an active category to keep future reporting easier to understand.</p>}
    {selectedPayee && categoryId && selectedPayee.defaultCategoryId !== categoryId && <label className="remember-category transaction-default-choice"><input type="checkbox" checked={rememberDefault} onChange={(event) => setRememberDefault(event.target.checked)} />Make {selectedCategory?.name ?? 'this category'} the default for {selectedPayee.name}</label>}
    {offerMapping && <label className="remember-category transaction-default-choice transaction-mapping-choice"><input type="checkbox" checked={rememberMapping} onChange={(event) => setRememberMapping(event.target.checked)} /><span>Add the {bankMappingLabel} “{bankMappingSource}” as an alternative name for <strong>{targetPayeeName}</strong></span></label>}
    {showRelatedTransactions && <section className="related-transactions-choice">
      <div className="related-transactions-heading"><div><strong>Other transactions for {targetPayeeName}</strong><span>Select any that should use {selectedCategory?.name ?? 'this category'} too.</span></div>{selectableRelated.length > 1 && <label><input type="checkbox" checked={selectedRelatedCount === selectableRelated.length} onChange={(event) => setSelectedRelatedIds(event.target.checked ? selectableRelated.map((item) => item.id) : [])} />Select all</label>}</div>
      <div className="related-transactions-list">{relatedTransactions.map((item) => {
        const currentCategory = categories.find((category) => category.id === item.categoryId)
        const alreadyUsesCategory = item.categoryId === categoryId
        return <label className={alreadyUsesCategory ? 'related-transaction already-matched' : 'related-transaction'} key={item.id}>
          <input type="checkbox" disabled={alreadyUsesCategory} checked={alreadyUsesCategory || selectedRelatedIds.includes(item.id)} onChange={(event) => setSelectedRelatedIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
          <span><strong>{shortDate.format(new Date(`${item.date}T12:00:00`))}</strong><small>{currentCategory?.name ?? 'Uncategorised'}</small></span>
          <b className={item.type === 'income' ? 'positive' : ''}>{item.type === 'income' ? '+' : '−'}{formatMoney(item.amountMinor, item.currency)}</b>
        </label>
      })}</div>
    </section>}
    <button className="primary-button form-submit" disabled={!categoryId || !payeeQuery.trim() || (!changed && !rememberDefault) || saving}>{saving ? 'Saving…' : selectedRelatedCount ? `Save ${selectedRelatedCount + 1} transactions` : 'Save transaction'}<ArrowRight size={18} /></button>
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

function AccountForm({ account, onSubmit }: { account?: Account; onSubmit: (a: Omit<Account, 'id'>) => void }) {
  const [name, setName] = useState(account?.name ?? '')
  const [type, setType] = useState<Account['type']>(account?.type ?? 'Checking')
  const [balance, setBalance] = useState(account ? String(account.balanceMinor / 100) : '')
  const [balanceSheetGroup, setBalanceSheetGroup] = useState<BalanceSheetGroup>(account ? accountBalanceSheetGroup(account) : 'Personal')
  const [currency, setCurrency] = useState(account?.currency ?? 'EUR')
  function submit(e: FormEvent) {
    e.preventDefault()
    const balanceMinor = parseMoneyToMinor(balance || '0', true)
    if (!name.trim() || balanceMinor === null) return
    const scope: AccountScope = balanceSheetGroup === 'Company' ? 'Company' : 'Personal'
    onSubmit({ name: name.trim(), type, scope, balanceSheetGroup, balanceMinor, currency, color: account?.color ?? (type === 'Savings' ? '#d68853' : type === 'Cash' ? '#777a6d' : '#234e46'), closed: account?.closed ?? false, autoSync: account?.autoSync })
  }
  return <form className="form" onSubmit={submit}><label><span>Account name</span><input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Everyday checking" /></label><div className="form-grid"><label><span>Account type</span><select value={type} onChange={e => setType(e.target.value as Account['type'])}><option>Checking</option><option>Savings</option><option>Cash</option></select></label><label><span>Balance sheet group</span><select value={balanceSheetGroup} onChange={e => setBalanceSheetGroup(e.target.value as BalanceSheetGroup)}>{balanceSheetGroups.map((group) => <option key={group}>{group}</option>)}</select></label></div>{!account && <div className="form-grid"><label><span>Current balance</span><input type="number" step="0.01" value={balance} onChange={e => setBalance(e.target.value)} placeholder="0.00" /></label><label><span>Currency</span><select value={currency} onChange={e => setCurrency(e.target.value)}><option>EUR</option><option>SEK</option><option>USD</option><option>GBP</option></select></label></div>}<p className="form-help">This controls where the account appears on the balance sheet. Company accounts are also used to calculate estimated corporate tax.</p><button className="primary-button form-submit">{account ? 'Save account' : 'Create account'}<ArrowRight size={18} /></button></form>
}

function CategoryGroupsForm({ groups, categories, onAdd, onRename, onReorder, onRemove }: { groups: CategoryGroup[]; categories: Category[]; onAdd: (name: string) => Promise<CategoryGroup>; onRename: (categoryGroupId: string, name: string) => Promise<void>; onReorder: (categoryGroupIds: string[]) => Promise<void>; onRemove: (categoryGroupId: string) => Promise<void> }) {
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
      {orderedGroups.map((group, index) => <CategoryGroupManagerRow key={group.id} group={group} categoryCount={categories.filter((category) => category.categoryGroupId === group.id).length} first={index === 0} last={index === orderedGroups.length - 1} onRename={onRename} onMove={move} onRemove={onRemove} />)}
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

function CategoryNameForm({ category, categories, onSubmit }: { category: Category; categories: Category[]; onSubmit: (categoryId: string, name: string) => Promise<void> }) {
  const [name, setName] = useState(category.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const normalizedName = name.normalize('NFKC').trim()
  const duplicate = categories.some((item) => item.id !== category.id && item.name.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0)
  const unchanged = normalizedName === category.name
  return <form className="form" onSubmit={async (event) => {
    event.preventDefault()
    if (!normalizedName || duplicate || unchanged) return
    setSaving(true)
    setError('')
    try {
      await onSubmit(category.id, normalizedName)
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not rename the category.'))
      setSaving(false)
    }
  }}>
    <label><span>Category name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} /></label>
    {duplicate && <p className="auth-error" role="alert">A category named “{normalizedName}” already exists.</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    <button className="primary-button form-submit" disabled={!normalizedName || duplicate || unchanged || saving}>{saving ? 'Saving…' : 'Save name'}<ArrowRight size={18} /></button>
  </form>
}

function CategoryForm({ categoryGroups, onSubmit }: { categoryGroups: CategoryGroup[]; onSubmit: (c: Omit<Category, 'id'>, budgetMinor: number, scope: AccountScope) => void }) {
  const [name, setName] = useState(''); const [budget, setBudget] = useState(''); const [reportGroup, setReportGroup] = useState<ReportGroup>('expense'); const [scope, setScope] = useState<AccountScope>('Personal'); const [categoryGroupId, setCategoryGroupId] = useState(categoryGroups[0]?.id ?? '')
  function submit(e: FormEvent) { e.preventDefault(); const budgetMinor = parseMoneyToMinor(budget || '0'); if (!name || budgetMinor === null) return; onSubmit({ name, reportGroup, categoryGroupId: categoryGroupId || undefined, color: '#5d7d91', icon: reportGroup === 'income' ? 'briefcase' : 'sparkles', hidden: false }, budgetMinor, scope) }
  return <form className="form" onSubmit={submit}><label><span>Category name</span><input autoFocus required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Personal care" /></label><div className="form-grid"><label><span>Report group</span><select value={reportGroup} onChange={e => setReportGroup(e.target.value as ReportGroup)}><option value="income">Income</option><option value="expense">Expense</option><option value="tax">Tax</option><option value="capital_gain">Capital gain/loss</option></select></label><label><span>Category group</span><select value={categoryGroupId} onChange={e => { const nextGroupId = e.target.value; setCategoryGroupId(nextGroupId); if (categoryGroups.find((group) => group.id === nextGroupId)?.name === 'Company') setScope('Company') }}>{categoryGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label></div><label><span>Budget owner</span><select value={scope} onChange={e => setScope(e.target.value as AccountScope)}><option>Personal</option><option>Company</option></select></label><label><span>Monthly plan</span><input type="number" min="0" step="0.01" value={budget} onChange={e => setBudget(e.target.value)} placeholder="0.00" /></label><button className="primary-button form-submit">Create category<ArrowRight size={18} /></button></form>
}

export default App
