// A background refresh can overtake history loading. Retry with the current
// snapshot rather than applying old transactions or leaving the check incomplete.
export async function loadCurrentTransactionHistory<T>({ load, generation, apply, timeoutMs = 30_000 }: {
  load: (revalidate: boolean) => Promise<T>
  generation: () => number
  apply: (value: T) => void
  timeoutMs?: number
}): Promise<void> {
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const request = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const startedAt = generation()
      const value = await load(attempt > 0)
      if (!active) return
      if (startedAt !== generation()) continue
      apply(value)
      return
    }
    throw new Error('Transaction history changed during the check. Please retry the history check.')
  }
  try {
    await Promise.race([
      request(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          active = false
          reject(new Error('Transaction history took too long to load. Please retry the history check.'))
        }, timeoutMs)
      }),
    ])
  } finally {
    active = false
    clearTimeout(timer)
  }
}
