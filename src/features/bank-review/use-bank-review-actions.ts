import type { BankApprovalResult } from './approval-result'
import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { BankSyncSummary } from '../../../shared/bank-types.ts'
import { getErrorMessage } from '../../app-utils'
import { createBankApprovalBatch, eligibleBankApprovals, type BankApprovalBatchResult, type ReadyBankApproval } from '../../bank-batch-review'
import { approveBankReviewItem, approveBankImportCandidateAsTransfer, clearTransactionCache, rejectBankImportCandidate, rematchPendingBankImportPayees, updateBankImportCandidateDetails, updateBankImportMode, type LoadedWorkspace } from '../../database'
import type { Account, AppData } from '../../types'
import type { useBankReviewHistory } from './use-bank-review-history'

export function useBankReviewActions({ workspaceId, data, setWrittenData, setSyncError, reloadWorkspaceSnapshot, applyConfirmedBankApprovals, reviewHistory, apiJson }: {
  workspaceId: string
  data: AppData
  setWrittenData: Dispatch<SetStateAction<AppData>>
  setSyncError: Dispatch<SetStateAction<string>>
  reloadWorkspaceSnapshot: () => Promise<LoadedWorkspace>
  applyConfirmedBankApprovals: (results: BankApprovalResult[]) => void
  reviewHistory: ReturnType<typeof useBankReviewHistory>
  apiJson: <T>(url: string, init?: RequestInit) => Promise<T>
}) {
  const [syncingAccountId, setSyncingAccountId] = useState('')
  const [reviewingCandidateId, setReviewingCandidateId] = useState('')
  const [bankBatchProgress, setBankBatchProgress] = useState<{ accountId: string; done: number; total: number } | null>(null)
  const [bankBatchResult, setBankBatchResult] = useState<{ accountId: string; result: BankApprovalBatchResult } | null>(null)
  const bankBatchRunningRef = useRef(false)
  const singleReviewRunningRef = useRef(false)
  const [rematchingAccountId, setRematchingAccountId] = useState('')
  const [syncNotice, setSyncNotice] = useState<{ accountId: string; message: string } | null>(null)
  const latestBankData = useRef(data)
  latestBankData.current = data

  async function changeBankImportMode(accountId: string, mode: 'review' | 'automatic') {
    try {
      setSyncError('')
      await updateBankImportMode(workspaceId, accountId, mode)
      setWrittenData((current) => ({
        ...current,
        accounts: current.accounts.map((account) => account.id === accountId ? { ...account, bankImportMode: mode } : account),
      }))
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not update the bank import mode.'))
    }
  }

  async function decideBankImportCandidate(candidateId: string, decision: 'approve' | 'reject', categoryId?: string, rememberCategory = false, payeeId?: string | null, rememberMapping = false, _bankDescription = '', createdPayee = false, defaultAccountId = '', memo = '') {
    // The database uses the stored bank description, rather than trusting a client copy.
    void _bankDescription
    if (bankBatchRunningRef.current || singleReviewRunningRef.current) return
    singleReviewRunningRef.current = true
    try {
      setSyncError('')
      setReviewingCandidateId(candidateId)
      if (decision === 'approve') {
        if (!categoryId) throw new Error('Choose a category before approving this transaction.')
        const candidate = latestBankData.current.bankImportCandidates.find((item) => item.id === candidateId)
        if (!candidate) throw new Error('This bank transaction is no longer awaiting review.')
        const result = await approveBankReviewItem(workspaceId, candidate.accountId, candidateId, categoryId, {
          payeeId, memo, rememberCategory, rememberMapping,
          setPayeeDefaults: Boolean((createdPayee || !payeeId) && defaultAccountId),
        })
        applyConfirmedBankApprovals([result])
        return
      }
      else await rejectBankImportCandidate(workspaceId, candidateId)
      const refreshed = await reloadWorkspaceSnapshot()
      setWrittenData(refreshed.data)
    } catch (error) {
      setSyncError(getErrorMessage(error, `Could not ${decision} the bank transaction.`))
    } finally {
      singleReviewRunningRef.current = false
      setReviewingCandidateId('')
    }
  }

  async function approveReadyBankCandidates(accountId: string, rows: ReadyBankApproval[]) {
    if (bankBatchRunningRef.current || singleReviewRunningRef.current || !rows.length || !reviewHistory.hasHistory()) return
    bankBatchRunningRef.current = true
    try {
      setSyncError('')
      setBankBatchResult(null)
      setBankBatchProgress({ accountId, done: 0, total: rows.length })
      const confirmed: BankApprovalResult[] = []
      const batch = createBankApprovalBatch(async (row) => {
        confirmed.push(await approveBankReviewItem(workspaceId, row.accountId, row.id, row.categoryId, { payeeId: row.payeeId, memo: row.memo, rememberCategory: row.rememberCategory, rememberMapping: row.rememberMapping, setPayeeDefaults: row.setPayeeDefaults }))
      })
      const result = await batch.run(rows, (row) => {
        const current = latestBankData.current
        return reviewHistory.hasHistory() && eligibleBankApprovals({ accountId, candidates: current.bankImportCandidates, payees: current.payees, categories: current.categories, transactions: reviewHistory.transactions, choices: { [row.id]: { payeeId: row.payeeId, categoryId: row.categoryId, memo: row.memo } } }).some((candidate) => candidate.id === row.id && candidate.payeeName === row.payeeName)
      }, (done, total) => setBankBatchProgress({ accountId, done, total }))
      if (result) {
        setBankBatchResult({ accountId, result })
        if (confirmed.length) applyConfirmedBankApprovals(confirmed)
      }
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not approve bank transactions.'))
    } finally {
      setBankBatchProgress(null)
      bankBatchRunningRef.current = false
    }
  }

  async function rematchBankImportPayees(accountId: string) {
    try {
      setSyncError('')
      setRematchingAccountId(accountId)
      const matched = await rematchPendingBankImportPayees(workspaceId, accountId)
      const refreshed = await reloadWorkspaceSnapshot()
      setWrittenData(refreshed.data)
      setSyncNotice({ accountId, message: matched ? `${matched} pending ${matched === 1 ? 'transaction now has' : 'transactions now have'} a matched payee.` : 'No additional payees matched.' })
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not recheck pending payees.'))
    } finally {
      setRematchingAccountId('')
    }
  }

  async function postBankImportAsTransfer(candidateId: string, counterpartyAccountId: string, memo: string) {
    if (bankBatchRunningRef.current || singleReviewRunningRef.current) return
    singleReviewRunningRef.current = true
    try {
      setSyncError('')
      setReviewingCandidateId(candidateId)
      const candidate = data.bankImportCandidates.find((item) => item.id === candidateId)
      await updateBankImportCandidateDetails(workspaceId, candidateId, candidate?.payeeId ?? null, memo)
      await approveBankImportCandidateAsTransfer(workspaceId, candidateId, counterpartyAccountId)
      void clearTransactionCache(workspaceId)
      const refreshed = await reloadWorkspaceSnapshot()
      setWrittenData(refreshed.data)
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not post the bank transaction as a transfer.'))
      throw error
    } finally {
      singleReviewRunningRef.current = false
      setReviewingCandidateId('')
    }
  }

  async function syncBank(account: Account) {
    if (!account.providerAccountId) return
    setSyncError('')
    setSyncNotice(null)
    setSyncingAccountId(account.id)
    try {
      const result = await apiJson<BankSyncSummary>('/api/gocardless/sync-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: workspaceId,
          accountId: account.id,
        }),
      })
      const refreshed = await reloadWorkspaceSnapshot()
      setWrittenData(refreshed.data)
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

  return { syncingAccountId, reviewingCandidateId, bankBatchProgress, bankBatchResult, rematchingAccountId, syncNotice, changeBankImportMode, decideBankImportCandidate, approveReadyBankCandidates, rematchBankImportPayees, postBankImportAsTransfer, syncBank }
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
