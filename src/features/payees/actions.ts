import type { Dispatch, SetStateAction } from 'react'
import type { LoadedWorkspace } from '../../database'
import type { AppData, Payee, PayeeMapping } from '../../types'

type PayeeDatabase = typeof import('./api')
export type PayeeActionServices = Pick<PayeeDatabase,
  | 'assignPayeeMapping' | 'cleanedMappingName' | 'createPayee' | 'createPayeeMapping'
  | 'deleteAllUnusedPayees' | 'deletePayeeMapping' | 'deleteUnusedPayee' | 'ensurePayees'
  | 'rematchPendingBankImportPayees' | 'updatePayeeDefaultCategory' | 'updatePayeeDefaults'
  | 'updatePayeeMapping' | 'updatePayeeName'
> & {
  uid: () => string
  getErrorMessage: (error: unknown, fallback: string) => string
}

export function createPayeeActions({ workspaceId, data, setWrittenData, setSyncError, reloadWorkspaceSnapshot, services }: {
  workspaceId: string
  data: AppData
  setWrittenData: Dispatch<SetStateAction<AppData>>
  setSyncError: Dispatch<SetStateAction<string>>
  reloadWorkspaceSnapshot: () => Promise<LoadedWorkspace>
  services: PayeeActionServices
}) {
  async function mapUnmatchedPayee(sourceName: string, payeeId: string) {
    try {
      setSyncError('')
      await services.assignPayeeMapping(workspaceId, sourceName, payeeId)
      const refreshed = await reloadWorkspaceSnapshot()
      setWrittenData(refreshed.data)
    } catch (error) {
      setSyncError(services.getErrorMessage(error, 'Could not map the transaction description.'))
      throw error
    }
  }

  async function createPayeeFromUnmatched(sourceName: string, payeeName: string, categoryId: string, accountId: string) {
    try {
      setSyncError('')
      const [payee] = await services.ensurePayees(workspaceId, [payeeName])
      if (!payee) throw new Error('The payee could not be created.')
      await services.updatePayeeDefaults(workspaceId, payee.id, categoryId || null, accountId || null)
      await services.assignPayeeMapping(workspaceId, sourceName, payee.id)
      const refreshed = await reloadWorkspaceSnapshot()
      setWrittenData(refreshed.data)
    } catch (error) {
      setSyncError(services.getErrorMessage(error, 'Could not create and map the payee.'))
      throw error
    }
  }

  async function createPayeeForReview(payeeName: string, categoryId: string, accountId: string) {
    try {
      setSyncError('')
      const payeeWithDefaults: Payee = { id: services.uid(), name: payeeName.normalize('NFKC').trim(), defaultCategoryId: categoryId || undefined, defaultAccountId: accountId || undefined }
      await services.createPayee(workspaceId, payeeWithDefaults, data.payees.length)
      setWrittenData((current) => ({
        ...current,
        payees: [...current.payees, payeeWithDefaults],
      }))
      return payeeWithDefaults
    } catch (error) {
      setSyncError(services.getErrorMessage(error, 'Could not create the payee.'))
      throw error
    }
  }

  async function changePayeeDefaults(payeeId: string, categoryId: string, accountId: string) {
    try {
      setSyncError('')
      await services.updatePayeeDefaults(workspaceId, payeeId, categoryId || null, accountId || null)
      setWrittenData((current) => ({
        ...current,
        payees: current.payees.map((payee) => payee.id === payeeId ? { ...payee, defaultCategoryId: categoryId || undefined, defaultAccountId: accountId || undefined } : payee),
      }))
    } catch (error) {
      setSyncError(services.getErrorMessage(error, 'Could not update the payee defaults.'))
      throw error
    }
  }

  async function changePayeeDefaultCategoryOnly(payeeId: string, categoryId: string) {
    try {
      setSyncError('')
      await services.updatePayeeDefaultCategory(workspaceId, payeeId, categoryId || null)
      setWrittenData((current) => ({
        ...current,
        payees: current.payees.map((payee) => payee.id === payeeId ? { ...payee, defaultCategoryId: categoryId || undefined } : payee),
      }))
    } catch (error) {
      setSyncError(services.getErrorMessage(error, 'Could not update the payee default category.'))
      throw error
    }
  }

  async function renamePayee(payeeId: string, name: string) {
    const normalizedName = name.normalize('NFKC').trim()
    if (!normalizedName) throw new Error('A payee name is required.')
    if (data.payees.some((payee) => payee.id !== payeeId && payee.name.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0)) {
      throw new Error(`A payee named “${normalizedName}” already exists.`)
    }
    try {
      setSyncError('')
      await services.updatePayeeName(workspaceId, payeeId, normalizedName)
      setWrittenData((current) => ({
        ...current,
        payees: current.payees.map((payee) => payee.id === payeeId ? { ...payee, name: normalizedName } : payee),
        transactions: current.transactions.map((transaction) => transaction.payeeId === payeeId ? { ...transaction, payee: normalizedName } : transaction),
      }))
    } catch (error) {
      setSyncError(services.getErrorMessage(error, 'Could not rename the payee.'))
      throw error
    }
  }

  async function removeUnusedPayee(payeeId: string) {
    try {
      setSyncError('')
      await services.deleteUnusedPayee(workspaceId, payeeId)
      setWrittenData((current) => ({
        ...current,
        payees: current.payees.filter((payee) => payee.id !== payeeId),
        unusedPayeeIds: current.unusedPayeeIds.filter((id) => id !== payeeId),
        payeeMappings: current.payeeMappings.filter((mapping) => mapping.payeeId !== payeeId),
        bankImportCandidates: current.bankImportCandidates.map((candidate) => candidate.payeeId === payeeId ? { ...candidate, payeeId: undefined } : candidate),
      }))
    } catch (error) {
      setSyncError(services.getErrorMessage(error, 'Could not delete the payee.'))
      throw error
    }
  }

  async function removeAllUnusedPayees() {
    try {
      setSyncError('')
      const deletedIds = await services.deleteAllUnusedPayees(workspaceId, data.unusedPayeeIds)
      const refreshed = await reloadWorkspaceSnapshot()
      setWrittenData(refreshed.data)
      return deletedIds.length
    } catch (error) {
      setSyncError(services.getErrorMessage(error, 'Could not delete the unused payees.'))
      throw error
    }
  }

  async function addPayeeMapping(payeeId: string, sourceName: string) {
    try {
      setSyncError('')
      await services.createPayeeMapping(workspaceId, sourceName, payeeId)
      const refreshed = await reloadWorkspaceSnapshot()
      setWrittenData(refreshed.data)
    } catch (error) {
      setSyncError(services.getErrorMessage(error, 'Could not add the mapping.'))
      throw error
    }
  }

  async function changePayeeMapping(mappingId: string, sourceName: string, payeeId: string, matchType: PayeeMapping['matchType']) {
    try {
      setSyncError('')
      await services.updatePayeeMapping(workspaceId, mappingId, sourceName, payeeId, matchType)
      setWrittenData((current) => ({
        ...current,
        payeeMappings: current.payeeMappings.map((mapping) => mapping.id === mappingId ? { ...mapping, sourceName: services.cleanedMappingName(sourceName, matchType), payeeId, matchType } : mapping),
      }))
    } catch (error) {
      setSyncError(services.getErrorMessage(error, 'Could not update the mapping.'))
      throw error
    }
  }

  async function promotePayeeMapping(mappingId: string) {
    const mapping = data.payeeMappings.find((item) => item.id === mappingId)
    if (!mapping) throw new Error('The suggested mapping no longer exists.')
    await changePayeeMapping(mapping.id, mapping.sourceName, mapping.payeeId, 'starts_with')
  }

  async function addPayeeAlternativeForReview(sourceName: string, payeeId: string, accountId: string) {
    try {
      setSyncError('')
      await services.createPayeeMapping(workspaceId, sourceName, payeeId)
      await services.rematchPendingBankImportPayees(workspaceId, accountId)
      const refreshed = await reloadWorkspaceSnapshot()
      setWrittenData(refreshed.data)
    } catch (error) {
      setSyncError(services.getErrorMessage(error, 'Could not add the alternative payee name.'))
      throw error
    }
  }

  async function removePayeeMapping(mappingId: string) {
    try {
      setSyncError('')
      await services.deletePayeeMapping(workspaceId, mappingId)
      setWrittenData((current) => ({ ...current, payeeMappings: current.payeeMappings.filter((mapping) => mapping.id !== mappingId) }))
    } catch (error) {
      setSyncError(services.getErrorMessage(error, 'Could not remove the mapping.'))
      throw error
    }
  }


  return { mapUnmatchedPayee, createPayeeFromUnmatched, createPayeeForReview, changePayeeDefaults, changePayeeDefaultCategoryOnly, renamePayee, removeUnusedPayee, removeAllUnusedPayees, addPayeeMapping, changePayeeMapping, promotePayeeMapping, addPayeeAlternativeForReview, removePayeeMapping }
}
