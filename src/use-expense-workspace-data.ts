import { useCallback, useEffect, useRef, useState } from 'react'
import { todayInParis } from '../shared/bank-data.ts'
import { getErrorMessage } from './app-utils'
import { loadCachedAllTransactions, loadTransactionPage, loadWorkspace, type LoadedWorkspace } from './database'
import type { AppData, Transaction } from './types'
import { refreshWasOvertaken, workspaceCacheVersion, writeWorkspaceCache } from './workspace-cache'
import { dataFromWorkspaceRefresh } from './workspace-refresh-data'
import { loadCurrentTransactionHistory } from './transaction-history-request'
import { applyBankApproval, type BankApprovalResult } from './features/bank-review/approval-result'

export function useExpenseWorkspaceData({ workspace, userId, selectedMonthKey, refreshStartedMutation, onLocalMutation, onRefreshApplied, onRefreshConflict }: {
  workspace: LoadedWorkspace
  userId: string
  selectedMonthKey: string
  refreshStartedMutation: number
  onLocalMutation: () => void
  onRefreshApplied: (loaded: LoadedWorkspace) => void
  onRefreshConflict: () => void
}) {
  const [data, setData] = useState<AppData>(workspace.data)
  const [candidateQueueByAccount, setCandidateQueueByAccount] = useState(workspace.candidateQueueByAccount ?? {})
  const [syncError, setSyncError] = useState('')
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const historyLoadedRef = useRef(false)
  const historyRequest = useRef<Promise<void> | null>(null)
  const monthCache = useRef(new Map<string, Transaction[]>([[workspace.loadedMonthKey, workspace.data.transactions]]))
  const [monthAttempt, setMonthAttempt] = useState(0)
  const localMutationCount = useRef(0)
  const snapshotGeneration = useRef(0)
  const appliedWorkspace = useRef(workspace)
  const activeMonth = useRef(selectedMonthKey)
  activeMonth.current = selectedMonthKey
  const setWrittenData: typeof setData = (value) => {
    localMutationCount.current++
    snapshotGeneration.current++
    onLocalMutation()
    setData(value)
  }

  const ensureFullHistory = useCallback(async (revalidate = false) => {
    if (historyLoadedRef.current && !revalidate) return
    if (historyRequest.current) return historyRequest.current
    setHistoryLoading(true)
    const request = loadCurrentTransactionHistory({
      load: () => loadCachedAllTransactions(workspace.workspaceId),
      generation: () => snapshotGeneration.current,
      apply: (allTransactions) => {
        historyLoadedRef.current = true
        setData((current) => ({ ...current, transactions: allTransactions }))
        setHistoryLoaded(true)
      },
    })
      .catch((cause) => setSyncError(getErrorMessage(cause, 'Could not load transaction history.')))
      .finally(() => { setHistoryLoading(false); historyRequest.current = null })
    historyRequest.current = request
    return request
  }, [workspace.workspaceId])

  useEffect(() => {
    if (appliedWorkspace.current === workspace) return
    appliedWorkspace.current = workspace
    // Parent checks before committing. This second check covers an edit between
    // the parent render and this effect.
    if (refreshWasOvertaken(refreshStartedMutation, localMutationCount.current)) {
      onRefreshConflict()
      return
    }
    snapshotGeneration.current++
    setCandidateQueueByAccount(workspace.candidateQueueByAccount ?? {})
    monthCache.current.clear()
    monthCache.current.set(workspace.loadedMonthKey, workspace.data.transactions)
    setData((current) => dataFromWorkspaceRefresh(current, workspace, selectedMonthKey, historyLoadedRef.current))
    if (historyLoadedRef.current) void (async () => {
      if (historyRequest.current) await historyRequest.current
      await ensureFullHistory(true)
    })()
    else if (selectedMonthKey !== workspace.loadedMonthKey) {
      const generation = snapshotGeneration.current
      const mutation = localMutationCount.current
      const monthStart = `${selectedMonthKey}-01`
      const nextMonth = new Date(`${monthStart}T12:00:00Z`)
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
      void loadTransactionPage(workspace.workspaceId, { startDate: monthStart, endDate: nextMonth.toISOString().slice(0, 10) })
        .then(({ transactions }) => {
          if (generation !== snapshotGeneration.current || mutation !== localMutationCount.current) return
          monthCache.current.set(selectedMonthKey, transactions)
          setData((current) => ({ ...current, transactions }))
        })
        .catch((cause) => setSyncError(getErrorMessage(cause, 'Could not load this month.')))
    }
    onRefreshApplied(workspace)
  // A changed workspace object is the refresh event; route and callback changes are not.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  useEffect(() => {
    if (historyLoaded) return
    const generation = snapshotGeneration.current
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
      if (cancelled || historyLoadedRef.current || generation !== snapshotGeneration.current) return
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
  }, [historyLoaded, selectedMonthKey, workspace.workspaceId, monthAttempt])

  async function reloadWorkspaceSnapshot() {
    const refreshed = await loadWorkspace(selectedMonthKey, { ...workspace, data })
    setCandidateQueueByAccount(refreshed.candidateQueueByAccount ?? {})
    monthCache.current.clear()
    monthCache.current.set(refreshed.loadedMonthKey, refreshed.data.transactions)
    void writeWorkspaceCache({ version: workspaceCacheVersion, userId, workspaceId: refreshed.workspaceId,
      parisDate: todayInParis(), revision: refreshed.snapshotRevision, workspace: refreshed })
    historyLoadedRef.current = false
    setHistoryLoaded(false)
    return refreshed
  }

  function invalidateTransactionMonth(date: string) { monthCache.current.delete(date.slice(0, 7)) }
  function applyConfirmedBankApprovals(results: BankApprovalResult[]) {
    for (const result of results) invalidateTransactionMonth(result.transaction.date)
    for (const [month, transactions] of monthCache.current) {
      if (results.some((result) => transactions.some((transaction) => transaction.id === result.transaction.id))) monthCache.current.delete(month)
    }
    setCandidateQueueByAccount((current) => {
      const next = { ...current }
      for (const result of results) next[result.accountId] = result.pendingCount ? 'pending' : 'empty'
      return next
    })
    setWrittenData((current) => results.reduce((next, result) => applyBankApproval(next, result, activeMonth.current, historyLoadedRef.current), current))
    // A month request overtaken by this write needs another chance after navigation.
    if (activeMonth.current !== selectedMonthKey) setMonthAttempt((value) => value + 1)
  }
  function hasFullHistory() { return historyLoadedRef.current }

  return { data, setWrittenData, candidateQueueByAccount, syncError, setSyncError, historyLoaded, historyLoading,
    ensureFullHistory, reloadWorkspaceSnapshot, invalidateTransactionMonth, applyConfirmedBankApprovals, hasFullHistory, historyGeneration: snapshotGeneration.current }
}
