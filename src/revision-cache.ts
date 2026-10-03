export type RevisionCached<T> = { revision: number; value: T }

// A revision is a data version, not a time-to-live. Check it before reusing data
// and again after a fetch so an overlapping write cannot stamp old rows as new.
export async function loadRevisionCached<T>({ revision, read, load, write }: {
  revision: () => Promise<number>
  read: () => Promise<RevisionCached<T> | null>
  load: () => Promise<T>
  write: (cached: RevisionCached<T>) => Promise<void>
}): Promise<T> {
  const [cached, initialRevision] = await Promise.all([read(), revision()])
  if (cached?.revision === initialRevision) return cached.value
  let startedAt = initialRevision
  for (let attempt = 0; attempt < 2; attempt++) {
    const value = await load()
    const finishedAt = await revision()
    if (startedAt === finishedAt) {
      await write({ revision: finishedAt, value })
      return value
    }
    startedAt = finishedAt
  }
  throw new Error('Transactions changed while loading. Please retry.')
}
