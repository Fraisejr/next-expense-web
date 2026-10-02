import type { AppData } from './types'
import type { LoadedWorkspace } from './database'

export function dataFromWorkspaceRefresh(current: AppData, loaded: LoadedWorkspace, selectedMonthKey: string, fullHistoryLoaded: boolean): AppData {
  return {
    ...loaded.data,
    transactions: fullHistoryLoaded || selectedMonthKey !== loaded.loadedMonthKey
      ? current.transactions
      : loaded.data.transactions,
  }
}
