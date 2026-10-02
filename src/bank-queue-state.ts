export type BankQueueStatus = 'pending' | 'empty' | 'unknown'
export type BankQueueView = BankQueueStatus | 'checking' | 'failed'

export function bankQueueView(status: BankQueueStatus | undefined, candidateCount: number, refreshState: 'idle' | 'refreshing' | 'failed'): BankQueueView {
  if (candidateCount > 0) return 'pending'
  if (refreshState === 'refreshing') return 'checking'
  if (refreshState === 'failed') return 'failed'
  return status === 'empty' ? 'empty' : 'unknown'
}
