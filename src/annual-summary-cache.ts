import { accessIndexedCache } from './indexed-cache'
import type { AnnualSpendingSummary } from './annual-spending'
import type { RevisionCached } from './revision-cache'

export type CachedAnnualSummary = RevisionCached<AnnualSpendingSummary> & { key: string }

export async function readAnnualSummary(userId: string, key: string): Promise<CachedAnnualSummary | null> {
  const cached = await accessIndexedCache<unknown>('next-expense-annual-summaries', 'summaries', 'readonly', (store) => store.get(userId)) as CachedAnnualSummary | null
  return cached?.key === key && Number.isSafeInteger(cached.revision)
    && ['Personal', 'Company', 'Combined'].every((scope) => Array.isArray(cached.value?.[scope as keyof AnnualSpendingSummary])) ? cached : null
}

export async function writeAnnualSummary(userId: string, cached: CachedAnnualSummary) {
  await accessIndexedCache('next-expense-annual-summaries', 'summaries', 'readwrite', (store) => store.put(cached, userId))
}

export async function clearAnnualSummary(userId: string) {
  await accessIndexedCache('next-expense-annual-summaries', 'summaries', 'readwrite', (store) => store.delete(userId))
}
