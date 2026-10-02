import { useCallback, useEffect, useRef, useState } from 'react'
import { todayInParis } from '../shared/bank-data.ts'
import { getErrorMessage } from './app-utils'
import { isExpiredJwtError } from './auth-bootstrap'
import { neon } from './neon'
import { clearTransactionCache, loadWorkspace, workspaceSnapshotRevision, WorkspaceNotLinkedError, type LoadedWorkspace } from './database'
import { acceptWorkspaceRefresh, clearWorkspaceCache, invalidateWorkspaceCache, readWorkspaceCache, refreshWasOvertaken, shouldReloadWorkspace, workspaceCacheVersion, writeWorkspaceCache, type CachedWorkspace } from './workspace-cache'

function isSessionError(error: unknown) {
  const details = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const message = getErrorMessage(error, '').toLowerCase()
  return isExpiredJwtError(error) || details.status === 401 || details.code === 'PGRST301'
    || message.includes('invalid jwt') || message.includes('session expired') || message.includes('no active session')
}

export function useWorkspaceSession(userId: string) {
  const [workspace, setWorkspace] = useState<LoadedWorkspace | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshState, setRefreshState] = useState<'idle' | 'refreshing' | 'failed'>('idle')
  const [refreshStartedMutation, setRefreshStartedMutation] = useState(0)
  const mutationCount = useRef(0)
  const refreshRun = useRef(0)
  const mounted = useRef(true)

  const saveCache = useCallback((loaded: LoadedWorkspace) => writeWorkspaceCache({
    version: workspaceCacheVersion, userId, workspaceId: loaded.workspaceId,
    parisDate: todayInParis(), revision: loaded.snapshotRevision, workspace: loaded,
  }), [userId])

  const backgroundRefresh = useCallback(async (cached: CachedWorkspace, force = false) => {
    const run = ++refreshRun.current
    setRefreshState('refreshing')
    try {
      if (!force && cached.parisDate === todayInParis()) {
        let revision: number | null = null
        try { revision = await workspaceSnapshotRevision(cached.workspaceId) }
        catch (cause) {
          // Older deployments lack migration 071. Session errors need a session check.
          if (isSessionError(cause)) throw cause
        }
        if (!shouldReloadWorkspace(cached, todayInParis(), revision)) {
          if (mounted.current && run === refreshRun.current) setRefreshState('idle')
          return
        }
      }
      while (mounted.current && run === refreshRun.current) {
        const startedAt = mutationCount.current
        const loaded = await loadWorkspace(new URLSearchParams(window.location.search).get('month') ?? undefined, cached.workspace)
        if (refreshWasOvertaken(startedAt, mutationCount.current)) continue
        // ExpenseApp applies this without remounting and confirms after its effect.
        setRefreshStartedMutation(startedAt)
        setWorkspace(acceptWorkspaceRefresh(cached.workspace, loaded))
        return
      }
    } catch (cause) {
      if (!mounted.current || run !== refreshRun.current) return
      if (isSessionError(cause)) {
        let hasNoSession = false
        try {
          const session = await neon.auth.getSession()
          hasNoSession = !session.error && !session.data
        } catch {
          // A failed session check cannot confirm that the session is gone.
        }
        if (!mounted.current || run !== refreshRun.current) return
        if (hasNoSession) {
          try {
            await Promise.all([clearWorkspaceCache(userId), clearTransactionCache(cached.workspaceId)])
            await neon.auth.signOut()
            return
          } catch {
            // Keep the retry control available if the auth flow does not update.
          }
        }
      }
      if (mounted.current && run === refreshRun.current) setRefreshState('failed')
    }
  }, [userId])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    const cached = await readWorkspaceCache(userId)
    if (!mounted.current) return
    if (cached) {
      setWorkspace(cached.workspace)
      setLoading(false)
      void backgroundRefresh(cached)
      return
    }
    try {
      const loaded = await loadWorkspace(new URLSearchParams(window.location.search).get('month') ?? undefined)
      if (!mounted.current) return
      setWorkspace(loaded)
      void saveCache(loaded)
    } catch (caught) {
      if (mounted.current) setError(caught instanceof WorkspaceNotLinkedError ? caught : new Error(getErrorMessage(caught, 'Could not load your workspace.')))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [backgroundRefresh, saveCache, userId])

  useEffect(() => {
    mounted.current = true
    const runCounter = refreshRun
    void refresh()
    return () => { mounted.current = false; runCounter.current++ }
  }, [refresh])

  const onLocalMutation = useCallback(() => {
    mutationCount.current++
    void invalidateWorkspaceCache(userId)
  }, [userId])

  const onRefreshApplied = useCallback((loaded: LoadedWorkspace) => {
    setRefreshState('idle')
    void saveCache(loaded)
  }, [saveCache])

  const onRefreshConflict = useCallback(() => {
    void readWorkspaceCache(userId).then((cached) => {
      if (cached && mounted.current) void backgroundRefresh(cached, true)
    })
  }, [backgroundRefresh, userId])

  const signOut = useCallback(async (workspaceId: string) => {
    mounted.current = false
    refreshRun.current++
    await Promise.all([clearWorkspaceCache(userId), clearTransactionCache(workspaceId)])
    await neon.auth.signOut()
  }, [userId])

  const retryVisibleWorkspace = useCallback(() => {
    if (!workspace) return
    void backgroundRefresh({ version: workspaceCacheVersion, userId, workspaceId: workspace.workspaceId,
      parisDate: todayInParis(), revision: workspace.snapshotRevision, workspace }, true)
  }, [backgroundRefresh, userId, workspace])

  return { workspace, error, loading, refreshState, refreshStartedMutation, refresh, onLocalMutation, onRefreshApplied, onRefreshConflict, signOut, retryVisibleWorkspace }
}
