import type { TimeEntry } from '../../types'

export function revenueYearForDate(date: string) {
  return Number(date.slice(0, 4)) + (date.slice(5, 7) === '12' ? 1 : 0)
}

export function replaceYearEntry(entries: TimeEntry[], saved: TimeEntry) {
  const remaining = entries.filter((entry) => entry.codeId !== saved.codeId || entry.date !== saved.date)
  return saved.hours > 0 ? [...remaining, saved] : remaining
}

export function createTimesheetYearCache(fetch: (workspaceId: string, year: number) => Promise<TimeEntry[]>) {
  type Record = { entries?: TimeEntry[]; pending?: Promise<TimeEntry[]>; saved: Map<string, TimeEntry> }
  const records = new Map<string, Record>()
  const key = (workspaceId: string, year: number) => JSON.stringify([workspaceId, year])
  return {
    async load(workspaceId: string, year: number) {
      const id = key(workspaceId, year)
      let record = records.get(id)
      if (!record) { record = { saved: new Map() }; records.set(id, record) }
      if (record.entries) return record.entries
      if (record.pending) return record.pending
      const target = record
      const pending = fetch(workspaceId, year).then((entries) => {
        for (const saved of target.saved.values()) entries = replaceYearEntry(entries, saved)
        target.entries = entries
        return entries
      }).finally(() => { target.pending = undefined })
      target.pending = pending
      return pending
    },
    saved(workspaceId: string, entry: TimeEntry) {
      const record = records.get(key(workspaceId, revenueYearForDate(entry.date)))
      if (!record) return
      record.saved.set(JSON.stringify([entry.codeId, entry.date]), entry)
      if (record.entries) record.entries = replaceYearEntry(record.entries, entry)
    },
    invalidate(workspaceId: string, year: number) { records.delete(key(workspaceId, year)) },
  }
}
