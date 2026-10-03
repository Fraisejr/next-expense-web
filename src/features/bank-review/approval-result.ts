import type { AppData, Payee, PayeeMapping, Transaction } from '../../types'

export type BankApprovalResult = {
  candidateId: string
  accountId: string
  transaction: Transaction
  payee: Payee
  mapping: PayeeMapping | null
  rematched: { id: string; payeeId: string; categoryId?: string }[]
  balanceMinor: number
  pendingCount: number
}

export function applyBankApproval(current: AppData, result: BankApprovalResult, selectedMonth: string, fullHistory: boolean): AppData {
  const rematched = new Map(result.rematched.map((candidate) => [candidate.id, candidate]))
  const includeTransaction = fullHistory || result.transaction.date.slice(0, 7) === selectedMonth
  const transactions = current.transactions.filter((transaction) => transaction.id !== result.transaction.id)
  return {
    ...current,
    accounts: current.accounts.map((account) => account.id === result.accountId ? { ...account, balanceMinor: result.balanceMinor } : account),
    transactions: includeTransaction ? [...transactions, result.transaction] : transactions,
    payees: [...current.payees.filter((payee) => payee.id !== result.payee.id), result.payee],
    unusedPayeeIds: current.unusedPayeeIds.filter((id) => id !== result.payee.id),
    payeeMappings: result.mapping ? [...current.payeeMappings.filter((mapping) => mapping.id !== result.mapping!.id), result.mapping] : current.payeeMappings,
    bankImportCandidates: current.bankImportCandidates.filter((candidate) => candidate.id !== result.candidateId).map((candidate) => {
      const matched = rematched.get(candidate.id)
      return matched && candidate.accountId === result.accountId ? { ...candidate, payeeId: matched.payeeId, categoryId: matched.categoryId } : candidate
    }),
  }
}
