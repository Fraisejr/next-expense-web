// Cache access is optional: a blocked browser database must not block totals.
export async function accessIndexedCache<T>(databaseName: string, storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  if (typeof indexedDB === 'undefined') return null
  return new Promise((resolve) => {
    let settled = false
    let database: IDBDatabase | undefined
    const finish = (value: T | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      database?.close()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), 2000)
    let open: IDBOpenDBRequest
    try { open = indexedDB.open(databaseName, 1) } catch { finish(null); return }
    open.onupgradeneeded = () => open.result.createObjectStore(storeName)
    open.onblocked = open.onerror = () => finish(null)
    open.onsuccess = () => {
      database = open.result
      if (settled) { database.close(); return }
      try {
        const transaction = database.transaction(storeName, mode)
        const request = action(transaction.objectStore(storeName))
        transaction.oncomplete = () => finish(request.result)
        transaction.onerror = transaction.onabort = () => finish(null)
      } catch { finish(null) }
    }
  })
}

