import { useEffect, useRef, useState } from 'react'
import { annualSummaryKey, calculateAnnualSpending, type AnnualSpendingSummary } from './annual-spending'
import { readAnnualSummary, writeAnnualSummary } from './annual-summary-cache'
import { loadCachedAllTransactions, transactionHistoryRevision } from './database'
import { loadRevisionCached } from './revision-cache'
import { loadCurrentTransactionHistory } from './transaction-history-request'
import { getErrorMessage } from './app-utils'
import type { AppData } from './types'

export function useAnnualSpendingSummary(userId: string, workspaceId: string, data: AppData, currency: string, today: string, generation: number) {
  const key = annualSummaryKey(workspaceId, currency, today, data)
  const latestData = useRef(data)
  latestData.current = data
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ key: string; value: AnnualSpendingSummary | null; loading: boolean; error: string }>({ key: '', value: null, loading: true, error: '' })
  useEffect(() => {
    let cancelled = false
    const summaryData = latestData.current
    setState((previous) => ({ key, value: previous.key === key ? previous.value : null, loading: true, error: '' }))
    const cached = readAnnualSummary(userId, key)
    void cached.then((value) => {
      if (!cancelled && value) setState({ key, value: value.value, loading: true, error: '' })
    })
    void loadCurrentTransactionHistory({
      generation: () => generation,
      load: () => loadRevisionCached({
        revision: () => transactionHistoryRevision(workspaceId),
        read: () => cached,
        load: async () => calculateAnnualSpending(await loadCachedAllTransactions(workspaceId), summaryData, currency, today),
        write: async (value) => { void writeAnnualSummary(userId, { key, ...value }) },
      }),
      apply: (value) => { if (!cancelled) setState({ key, value, loading: false, error: '' }) },
    }).catch((error) => {
      if (!cancelled) setState((previous) => ({ ...previous, loading: false, error: getErrorMessage(error, 'Could not load yearly totals.') }))
    })
    return () => { cancelled = true }
  }, [userId, workspaceId, key, currency, today, generation, attempt])
  return { value: state.key === key ? state.value : null, loading: state.key !== key || state.loading, error: state.key === key ? state.error : '', retry: () => setAttempt((value) => value + 1) }
}
