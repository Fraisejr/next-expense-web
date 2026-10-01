import type { LoadedWorkspace } from './database.ts'

export const workspaceCacheVersion = 1
export type CachedWorkspace = {
  version: number
  userId: string
  workspaceId: string
  parisDate: string
  revision: number | null
  workspace: LoadedWorkspace
}

export function validWorkspaceCache(value: unknown, userId: string): value is CachedWorkspace {
  if (!value || typeof value !== 'object') return false
  const cache = value as Partial<CachedWorkspace>
  return cache.version === workspaceCacheVersion && cache.userId === userId
    && typeof cache.workspaceId === 'string' && cache.workspaceId === cache.workspace?.workspaceId
    && typeof cache.parisDate === 'string' && Array.isArray(cache.workspace.data?.accounts)
    && (cache.revision === null || (typeof cache.revision === 'number' && Number.isSafeInteger(cache.revision)))
    && /^\d{4}-(0[1-9]|1[0-2])$/.test(cache.workspace.loadedMonthKey ?? '')
}

export function shouldReloadWorkspace(cache: CachedWorkspace, parisDate: string, revision: number | null) {
  return cache.parisDate !== parisDate || cache.revision === null || revision === null || cache.revision !== revision
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
