import type { BankImportCandidate, Category, Payee, Transaction } from './types'

export type BankApprovalChoice = { payeeId?: string; categoryId?: string; memo?: string; transfer?: boolean }
export type ReadyBankApproval = { id: string; accountId: string; payeeId: string; categoryId: string; memo: string }
type ReviewTransaction = Pick<Transaction, 'id' | 'accountId' | 'type' | 'currency' | 'amountMinor' | 'date'> & { toAccountId?: string; destinationAmountMinor?: number }
type ReviewOptions = Parameters<typeof eligibleBankApprovals>[0]

export function shouldAutoLoadBankHistory(bankLinked: boolean, candidateCount: number, historyLoaded: boolean, alreadyAttempted = false): boolean {
  return bankLinked && candidateCount > 0 && !historyLoaded && !alreadyAttempted
}

export function bankApprovalReview(options: ReviewOptions & { historyLoaded: boolean }) {
  if (!options.historyLoaded) return { readyRows: null, excluded: null }
  const readyRows = eligibleBankApprovals(options)
  const readyIds = new Set(readyRows.map(row => row.id))
  const excluded = { unposted: 0, missingPayee: 0, missingCategory: 0, ambiguous: 0 }
  for (const candidate of options.candidates) {
    if (readyIds.has(candidate.id)) continue
    const choice = options.choices[candidate.id]
    if (!candidate.posted) excluded.unposted++
    else if (!options.payees.some(payee => payee.id === (choice?.payeeId ?? candidate.payeeId))) excluded.missingPayee++
    else if (!options.categories.some(category => category.id === (choice?.categoryId ?? candidate.categoryId) && !category.hidden)) excluded.missingCategory++
    else excluded.ambiguous++
  }
  return { readyRows, excluded }
}

export function eligibleBankApprovals({ accountId, candidates, payees, categories, transactions, choices }: {
  accountId: string
  candidates: BankImportCandidate[]
  payees: Pick<Payee, 'id'>[]
  categories: Pick<Category, 'id' | 'hidden'>[]
  transactions: ReviewTransaction[]
  choices: Record<string, BankApprovalChoice>
}): ReadyBankApproval[] {
  return candidates.flatMap(candidate => {
    const choice = choices[candidate.id]
    const payeeId = choice?.payeeId ?? candidate.payeeId ?? ''
    const categoryId = choice?.categoryId ?? candidate.categoryId ?? ''
    if (candidate.accountId !== accountId || !candidate.posted || choice?.transfer || !payees.some(payee => payee.id === payeeId) || !categories.some(category => category.id === categoryId && !category.hidden)) return []
    if (candidates.some(other => other.id !== candidate.id && other.accountId === accountId && other.date === candidate.date && other.currency === candidate.currency && other.type === candidate.type && other.amountMinor === candidate.amountMinor)) return []
    const ambiguous = transactions.some(transaction => {
      if (transaction.id === candidate.transactionId || transaction.currency !== candidate.currency) return false
      const days = Math.abs(Date.parse(`${transaction.date}T12:00:00Z`) - Date.parse(`${candidate.date}T12:00:00Z`)) / 86_400_000
      if (transaction.type === 'transfer') return days <= 3 && (candidate.type === 'expense'
        ? transaction.accountId === accountId && transaction.amountMinor === candidate.amountMinor
        : transaction.toAccountId === accountId && (transaction.destinationAmountMinor ?? transaction.amountMinor) === candidate.amountMinor)
      return days === 0 && transaction.accountId === accountId && transaction.type === candidate.type && transaction.amountMinor === candidate.amountMinor
    })
    if (ambiguous) return []
    return [{ id: candidate.id, accountId, payeeId, categoryId, memo: choice?.memo ?? candidate.note ?? '' }]
  })
}

export type BankApprovalBatchResult = { approved: number; failed: number; skipped: number; errors: string[] }

export function createBankApprovalBatch(approve: (row: ReadyBankApproval) => Promise<void>) {
  let running = false
  return {
    get running() { return running },
    async run(rows: ReadyBankApproval[], current: (row: ReadyBankApproval) => boolean = () => true, progress?: (done: number, total: number) => void): Promise<BankApprovalBatchResult | null> {
      if (running) return null
      const result: BankApprovalBatchResult = { approved: 0, failed: 0, skipped: 0, errors: [] }
      if (!rows.length) return result
      running = true
      try {
        for (const row of rows) {
          if (!current(row)) result.skipped++
          else {
            try { await approve(row); result.approved++ }
            catch (error) { result.failed++; result.errors.push(`${row.id}: ${error instanceof Error ? error.message : String(error)}`) }
          }
          progress?.(result.approved + result.failed + result.skipped, rows.length)
        }
      } finally { running = false }
      return result
    },
  }
}
