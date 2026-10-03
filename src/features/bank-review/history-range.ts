import type { BankImportCandidate } from '../../types'

export function bankReviewHistoryRange(accountId: string, candidates: Pick<BankImportCandidate, 'accountId' | 'date'>[]) {
  const dates = candidates.filter((candidate) => candidate.accountId === accountId).map((candidate) => candidate.date).sort()
  if (!dates.length) return null
  const shift = (date: string, days: number) => {
    const value = new Date(`${date}T12:00:00Z`)
    value.setUTCDate(value.getUTCDate() + days)
    return value.toISOString().slice(0, 10)
  }
  // endDate is exclusive. Include all three days after the newest candidate.
  return { accountId, startDate: shift(dates[0], -3), endDate: shift(dates.at(-1)!, 4) }
}
