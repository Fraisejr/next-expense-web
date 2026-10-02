import type { LoadedWorkspace } from './database.ts'

export const workspaceCacheVersion = 6
export type CachedWorkspace = {
  version: number
  userId: string
  workspaceId: string
  parisDate: string
  revision: number | null
  workspace: LoadedWorkspace
}

const protectedCollections = ['payees', 'categories', 'timeCodes', 'bankImportCandidates', 'accounts'] as const

export function assessWorkspaceSnapshot(loaded: LoadedWorkspace, previous?: LoadedWorkspace): { trusted: boolean; reason?: string } {
  const data = loaded.data
  if (!data || protectedCollections.some((key) => !Array.isArray(data[key]))) return { trusted: false, reason: 'Workspace data is incomplete.' }
  // A populated workspace with one missing register is ambiguous after auth bootstrap.
  if (data.accounts.length > 0 && (data.payees.length === 0 || data.categories.length === 0)) {
    return { trusted: false, reason: 'Payees and categories could not be verified. Retry loading your workspace.' }
  }
  if (previous?.workspaceId === loaded.workspaceId && (
    (previous.data.accounts.length > data.accounts.length)
    || (previous.bankConnectionCount !== undefined && loaded.bankConnectionCount !== undefined && previous.bankConnectionCount > loaded.bankConnectionCount)
    || (previous.data.payees.length > 0 && data.payees.length === 0)
    || (previous.data.categories.length > 0 && data.categories.length === 0)
    || (previous.data.timeCodes.length > data.timeCodes.length)
    || previous.data.accounts.some((account) => account.providerAccountId
      && !data.accounts.some((next) => next.id === account.id && next.providerAccountId))
  )) return { trusted: false, reason: 'A workspace refresh could not verify previously populated rows. Retry refresh.' }
  if (previous?.workspaceId === loaded.workspaceId && (loaded.snapshotRevision === previous.snapshotRevision || loaded.snapshotRevision === null)) {
    const lostRows = protectedCollections.some((key) => data[key].length < previous.data[key].length)
    const lostConnection = previous.data.accounts.some((account) => account.providerAccountId
      && !data.accounts.some((next) => next.id === account.id && next.providerAccountId))
    if (lostRows || lostConnection) return { trusted: false, reason: 'A workspace refresh returned fewer rows without a confirmed revision change. Retry refresh.' }
  }
  return { trusted: true }
}

export function acceptWorkspaceRefresh(previous: LoadedWorkspace, loaded: LoadedWorkspace): LoadedWorkspace {
  const assessment = assessWorkspaceSnapshot(loaded, previous)
  if (!assessment.trusted) throw new Error(assessment.reason)
  return loaded
}

export function validWorkspaceCache(value: unknown, userId: string): value is CachedWorkspace {
  if (!value || typeof value !== 'object') return false
  const cache = value as Partial<CachedWorkspace>
  return cache.version === workspaceCacheVersion && cache.userId === userId
    && typeof cache.workspaceId === 'string' && cache.workspaceId === cache.workspace?.workspaceId
    && typeof cache.parisDate === 'string' && assessWorkspaceSnapshot(cache.workspace).trusted
    && cache.workspace.snapshotCountsAuthoritative === true
    && cache.workspace.data.accounts.length > 0
    && cache.workspace.data.accounts.every((account) => {
      if (!account.providerAccountId) return true
      const status = cache.workspace?.candidateQueueByAccount?.[account.id]
      const hasCandidates = cache.workspace?.data.bankImportCandidates.some((candidate) => candidate.accountId === account.id)
      return status === 'pending' ? hasCandidates : (status === 'empty' || status === 'unknown') && !hasCandidates
    })
    && (cache.revision === null || (typeof cache.revision === 'number' && Number.isSafeInteger(cache.revision)))
    && /^\d{4}-(0[1-9]|1[0-2])$/.test(cache.workspace.loadedMonthKey ?? '')
}

export function shouldReloadWorkspace(cache: CachedWorkspace, parisDate: string, revision: number | null) {
  return !validWorkspaceCache(cache, cache.userId) || cache.parisDate !== parisDate || cache.revision === null || revision === null || cache.revision !== revision
    || cache.workspace.data.accounts.some((account) => account.providerAccountId && cache.workspace.candidateQueueByAccount?.[account.id] !== 'pending')
}

export function refreshWasOvertaken(startMutation: number, currentMutation: number) {
  return currentMutation !== startMutation
}

const databaseName = 'next-expense-workspace-snapshots'
const storeName = 'snapshots'

function openCache(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

async function accessCache<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const database = await openCache()
  if (!database) return null
  return new Promise((resolve) => {
    const request = action(database.transaction(storeName, mode).objectStore(storeName))
    request.onsuccess = () => { resolve(request.result); database.close() }
    request.onerror = () => { resolve(null); database.close() }
  })
}

export async function readWorkspaceCache(userId: string): Promise<CachedWorkspace | null> {
  const value = await accessCache<unknown>('readonly', (store) => store.get(userId))
  return validWorkspaceCache(value, userId) ? value : null
}

export async function writeWorkspaceCache(cache: CachedWorkspace) {
  if (!validWorkspaceCache(cache, cache.userId)) return
  await accessCache('readwrite', (store) => store.put(cache, cache.userId))
}

export async function invalidateWorkspaceCache(userId: string) {
  const database = await openCache()
  if (!database) return
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const request = store.get(userId)
    request.onsuccess = () => {
      if (validWorkspaceCache(request.result, userId)) store.put({ ...request.result, revision: null }, userId)
    }
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onerror = () => { database.close(); resolve() }
  })
}

export async function clearWorkspaceCache(userId: string) {
  await accessCache('readwrite', (store) => store.delete(userId))
}
