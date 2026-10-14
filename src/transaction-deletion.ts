import type { Dispatch, SetStateAction } from 'react'
import type { AppData, Transaction } from './types.ts'

export async function removeTransaction(transaction: Transaction, services: {
  deleteTransaction: () => Promise<void>
  clearTransactionCache: () => Promise<void>
  invalidateTransactionMonth: (date: string) => void
  setWrittenData: Dispatch<SetStateAction<AppData>>
  reloadWorkspaceSnapshot: () => Promise<{ data: AppData }>
  setSyncError: (message: string) => void
  getErrorMessage: (error: unknown, fallback: string) => string
}) {
  services.setSyncError('')
  // A failed write must leave the dialog and local records intact.
  await services.deleteTransaction()
  services.invalidateTransactionMonth(transaction.date)
  services.setWrittenData((current) => ({ ...current, transactions: current.transactions.filter((item) => item.id !== transaction.id) }))
  try {
    await services.clearTransactionCache()
    // Reload computed balances and adjustment amounts, including both sides of transfers.
    const refreshed = await services.reloadWorkspaceSnapshot()
    services.setWrittenData(refreshed.data)
  } catch (error) {
    // The deletion succeeded. Do not present a refresh failure as a failed delete.
    services.setSyncError(`Transaction deleted, but balances and reports could not refresh. Reload the page. ${services.getErrorMessage(error, 'Could not refresh workspace.')}`)
  }
}
