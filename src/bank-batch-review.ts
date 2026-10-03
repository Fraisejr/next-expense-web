import type { BankImportCandidate, Category, Payee, PayeeMapping, Transaction } from './types'

type BankApprovalPreferences = { rememberCategory?: boolean; rememberMapping?: boolean; setPayeeDefaults?: boolean }
export type BankApprovalChoice = BankApprovalPreferences & { payeeId?: string; categoryId?: string; memo?: string; transfer?: boolean }
export type ReadyBankApproval = BankApprovalPreferences & { id: string; accountId: string; payeeId: string; payeeName?: string; categoryId: string; memo: string }

export function bankReviewChoices(candidates: BankImportCandidate[], mappings: PayeeMapping[], selections: {
  payeeAssignments: Record<string, string>; categoryAssignments: Record<string, string>; memoAssignments: Record<string, string>
  createdPayeeIds: Record<string, string>; rememberChoices: Record<string, boolean>; mappingChoices: Record<string, boolean>; transferCandidateId: string
}): Record<string, BankApprovalChoice> {
  return Object.fromEntries(candidates.map((candidate) => {
    const payeeId = selections.payeeAssignments[candidate.id] ?? candidate.payeeId ?? ''
    const changed = Object.prototype.hasOwnProperty.call(selections.payeeAssignments, candidate.id) && payeeId !== (candidate.payeeId ?? '')
    const name = candidate.payee.normalize('NFKC').trim().toLocaleLowerCase('en')
    const mapped = mappings.some((mapping) => mapping.payeeId === payeeId && mapping.sourceName.normalize('NFKC').trim().toLocaleLowerCase('en') === name)
    return [candidate.id, {
      payeeId, categoryId: selections.categoryAssignments[candidate.id] ?? candidate.categoryId ?? '',
      memo: selections.memoAssignments[candidate.id] ?? candidate.note ?? '',
      transfer: selections.transferCandidateId === candidate.id,
      rememberCategory: selections.rememberChoices[candidate.id] ?? Boolean(payeeId),
      rememberMapping: Boolean(payeeId && changed && !mapped && (selections.mappingChoices[candidate.id] ?? true)),
      setPayeeDefaults: !payeeId || selections.createdPayeeIds[candidate.id] === payeeId,
    }]
  }))
}
type ReviewTransaction = Pick<Transaction, 'id' | 'accountId' | 'type' | 'currency' | 'amountMinor' | 'date'> & { toAccountId?: string; destinationAmountMinor?: number }
type ReviewOptions = Parameters<typeof eligibleBankApprovals>[0]

export function shouldAutoLoadBankHistory(bankLinked: boolean, candidateCount: number, historyLoaded: boolean, alreadyAttempted = false): boolean {
  return bankLinked && candidateCount > 0 && !historyLoaded && !alreadyAttempted
}

export function bankApprovalReview(options: ReviewOptions & { historyLoaded: boolean }) {
  if (!options.historyLoaded) return { readyRows: null, excluded: null }
  const readyRows = eligibleBankApprovals(options)
  const readyIds = new Set(readyRows.map(row => row.id))
  const excluded = { missingPayee: 0, missingCategory: 0, ambiguous: 0 }
  for (const candidate of options.candidates) {
    if (readyIds.has(candidate.id)) continue
    const choice = options.choices[candidate.id]
    const payeeId = choice?.payeeId ?? candidate.payeeId ?? ''
    if (payeeId ? !options.payees.some(payee => payee.id === payeeId) : !candidate.payee.normalize('NFKC').trim()) excluded.missingPayee++
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
    const payeeName = candidate.payee.normalize('NFKC').trim()
    const validPayee = payeeId ? payees.some(payee => payee.id === payeeId) : Boolean(payeeName)
    if (candidate.accountId !== accountId || choice?.transfer || !validPayee || !categories.some(category => category.id === categoryId && !category.hidden)) return []
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
    return [{ id: candidate.id, accountId, payeeId, ...(!payeeId ? { payeeName } : {}), categoryId, memo: choice?.memo ?? candidate.note ?? '',
      ...(choice?.rememberCategory !== undefined ? { rememberCategory: choice.rememberCategory } : {}),
      ...(choice?.rememberMapping !== undefined ? { rememberMapping: choice.rememberMapping } : {}),
      ...(choice?.setPayeeDefaults !== undefined ? { setPayeeDefaults: choice.setPayeeDefaults } : {}),
    }]
  })
}

type BankApprovalServices = Pick<typeof import('./database'), 'ensurePayees' | 'updateBankImportCandidateDetails' | 'approveBankImportCandidate'>

export async function approveReadyBankRow(workspaceId: string, row: ReadyBankApproval, services: BankApprovalServices) {
  let payeeId = row.payeeId
  if (!payeeId) {
    const name = row.payeeName?.normalize('NFKC').trim()
    if (!name) throw new Error('A bank description is required to create a payee.')
    const [payee] = await services.ensurePayees(workspaceId, [name])
    if (!payee?.id) throw new Error('The payee could not be created.')
    payeeId = payee.id
  }
  await services.updateBankImportCandidateDetails(workspaceId, row.id, payeeId, row.memo, row.accountId)
  await services.approveBankImportCandidate(workspaceId, row.id, row.categoryId, false)
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
