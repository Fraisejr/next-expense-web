import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { BankSyncSummary } from '../../../shared/bank-types.ts'
import { getErrorMessage } from '../../app-utils'
import { approveReadyBankRow, createBankApprovalBatch, eligibleBankApprovals, type BankApprovalBatchResult, type ReadyBankApproval } from '../../bank-batch-review'
import { approveBankImportCandidate, approveBankImportCandidateAsTransfer, clearTransactionCache, createPayeeMapping, ensurePayees, rejectBankImportCandidate, rematchPendingBankImportPayees, updateBankImportCandidateDetails, updateBankImportMode, updatePayeeDefaults, updatePayeeMapping, type LoadedWorkspace } from '../../database'
import type { Account, AppData } from '../../types'

export function useBankReviewActions({ workspaceId, data, setWrittenData, setSyncError, reloadWorkspaceSnapshot, hasFullHistory, apiJson }: {
  workspaceId: string
  data: AppData
  setWrittenData: Dispatch<SetStateAction<AppData>>
  setSyncError: Dispatch<SetStateAction<string>>
  reloadWorkspaceSnapshot: () => Promise<LoadedWorkspace>
  hasFullHistory: () => boolean
  apiJson: <T>(url: string, init?: RequestInit) => Promise<T>
}) {
  const [syncingAccountId, setSyncingAccountId] = useState('')
  const [reviewingCandidateId, setReviewingCandidateId] = useState('')
  const [bankBatchProgress, setBankBatchProgress] = useState<{ accountId: string; done: number; total: number } | null>(null)
  const [bankBatchResult, setBankBatchResult] = useState<{ accountId: string; result: BankApprovalBatchResult } | null>(null)
  const bankBatchRunningRef = useRef(false)
  const bankBatchRef = useRef(createBankApprovalBatch((row) => approveReadyBankRow(workspaceId, row, {
    ensurePayees, updateBankImportCandidateDetails, approveBankImportCandidate,
  })))
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

  async function decideBankImportCandidate(candidateId: string, decision: 'approve' | 'reject', categoryId?: string, rememberCategory = false, payeeId?: string | null, rememberMapping = false, bankDescription = '', createdPayee = false, defaultAccountId = '', memo = '') {
    if (bankBatchRunningRef.current || reviewingCandidateId) return
    try {
      setSyncError('')
      setReviewingCandidateId(candidateId)
      if (decision === 'approve') {
        if (!categoryId) throw new Error('Choose a category before approving this transaction.')
        let resolvedPayeeId = payeeId ?? null
        let payeeCreatedDuringApproval = false
        if (!resolvedPayeeId) {
          const [createdPayee] = await ensurePayees(workspaceId, [bankDescription])
          resolvedPayeeId = createdPayee.id
          payeeCreatedDuringApproval = true
        }
        await updateBankImportCandidateDetails(workspaceId, candidateId, resolvedPayeeId, memo)
        await approveBankImportCandidate(workspaceId, candidateId, categoryId, rememberCategory)
        if ((createdPayee || payeeCreatedDuringApproval) && defaultAccountId) {
          try {
            await updatePayeeDefaults(workspaceId, resolvedPayeeId, categoryId, defaultAccountId)
          } catch (defaultsError) {
            const refreshed = await reloadWorkspaceSnapshot()
            setWrittenData(refreshed.data)
            setSyncError(`Transaction approved, but the new payee defaults could not be saved: ${getErrorMessage(defaultsError, 'Unknown error')}`)
            return
          }
        }
        if (rememberMapping && resolvedPayeeId && bankDescription.trim()) {
          try {
            const normalizedDescription = bankDescription.normalize('NFKC').trim().toLocaleLowerCase('en')
            const existingMapping = data.payeeMappings.find((mapping) => mapping.sourceName.normalize('NFKC').trim().toLocaleLowerCase('en') === normalizedDescription)
            if (existingMapping && existingMapping.payeeId !== resolvedPayeeId) await updatePayeeMapping(workspaceId, existingMapping.id, bankDescription, resolvedPayeeId, existingMapping.matchType)
            else if (!existingMapping) await createPayeeMapping(workspaceId, bankDescription, resolvedPayeeId)
            if (defaultAccountId) await rematchPendingBankImportPayees(workspaceId, defaultAccountId)
          } catch (mappingError) {
            const refreshed = await reloadWorkspaceSnapshot()
            setWrittenData(refreshed.data)
            setSyncError(`Transaction approved, but its bank description could not be saved as a mapping: ${getErrorMessage(mappingError, 'Unknown error')}`)
            return
          }
        }
      }
      else await rejectBankImportCandidate(workspaceId, candidateId)
      const refreshed = await reloadWorkspaceSnapshot()
      setWrittenData(refreshed.data)
    } catch (error) {
      setSyncError(getErrorMessage(error, `Could not ${decision} the bank transaction.`))
    } finally {
      setReviewingCandidateId('')
    }
  }

  async function approveReadyBankCandidates(accountId: string, rows: ReadyBankApproval[]) {
    if (bankBatchRunningRef.current || reviewingCandidateId || !rows.length || !hasFullHistory()) return
    bankBatchRunningRef.current = true
    try {
      const needsPayee = rows.filter((row) => !row.payeeId).length
      const payeeNotice = needsPayee ? `\n\n${needsPayee} transaction${needsPayee === 1 ? '' : 's'} without a selected payee will use the bank description to create or reuse a payee.` : ''
      if (!window.confirm(`Approve ${rows.length} ready bank transaction${rows.length === 1 ? '' : 's'} for ${data.accounts.find((account) => account.id === accountId)?.name ?? 'this account'}?${payeeNotice}`)) return
      setSyncError('')
      setBankBatchResult(null)
      setBankBatchProgress({ accountId, done: 0, total: rows.length })
      const result = await bankBatchRef.current.run(rows, (row) => {
        const current = latestBankData.current
        return hasFullHistory() && eligibleBankApprovals({ accountId, candidates: current.bankImportCandidates, payees: current.payees, categories: current.categories, transactions: current.transactions, choices: { [row.id]: { payeeId: row.payeeId, categoryId: row.categoryId, memo: row.memo } } }).some((candidate) => candidate.id === row.id && candidate.payeeName === row.payeeName)
      }, (done, total) => setBankBatchProgress({ accountId, done, total }))
      if (result) {
        setBankBatchResult({ accountId, result })
        const refreshed = await reloadWorkspaceSnapshot()
        setWrittenData(refreshed.data)
      }
    } catch (error) {
      setSyncError(getErrorMessage(error, 'Could not refresh bank transactions after batch approval.'))
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
    if (bankBatchRunningRef.current || reviewingCandidateId) return
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
