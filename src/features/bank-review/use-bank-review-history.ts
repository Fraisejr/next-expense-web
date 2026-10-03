import { useEffect, useRef, useState } from 'react'
import { loadTransactionRange } from '../../database'
import { getErrorMessage } from '../../app-utils'
import { loadCurrentTransactionHistory } from '../../transaction-history-request'
import type { BankImportCandidate, Transaction } from '../../types'
import { bankReviewHistoryRange } from './history-range'

export function useBankReviewHistory(workspaceId: string, accountId: string | undefined, candidates: BankImportCandidate[], generation: number) {
  const range = bankReviewHistoryRange(accountId ?? '', candidates)
  const key = range ? JSON.stringify([workspaceId, range, generation]) : ''
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ key: string; attempt: number; transactions: Transaction[]; loading: boolean; loaded: boolean; error: string }>({
    key: '', attempt: 0, transactions: [], loading: false, loaded: false, error: '',
  })
  const latestKey = useRef(key)
  latestKey.current = key
  useEffect(() => {
    if (!key) return
    let cancelled = false
    const [, query] = JSON.parse(key) as [string, NonNullable<typeof range>, number]
    setState({ key, attempt, transactions: [], loading: true, loaded: false, error: '' })
    void loadCurrentTransactionHistory({
      load: () => loadTransactionRange(workspaceId, query),
      generation: () => generation,
      apply: (transactions) => {
        if (!cancelled && latestKey.current === key) setState({ key, attempt, transactions, loading: false, loaded: true, error: '' })
      },
    }).catch((error) => {
      if (!cancelled) setState({ key, attempt, transactions: [], loading: false, loaded: false, error: getErrorMessage(error, 'Could not check recent transactions. Please retry.') })
    })
    return () => { cancelled = true }
  }, [key, attempt, workspaceId, generation])
  const current = state.key === key && state.attempt === attempt
  const loaded = Boolean(key && current && state.loaded)
  const readiness = useRef(false)
  readiness.current = loaded
  return {
    transactions: loaded ? state.transactions : [], loaded,
    loading: Boolean(key && (!current || state.loading)), error: current ? state.error : '',
    retry: async () => { setAttempt((value) => value + 1) },
    hasHistory: () => readiness.current && latestKey.current === key,
  }
}
