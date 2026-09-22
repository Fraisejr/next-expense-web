import { neon } from '@neondatabase/serverless'

export type CronAccountResult = {
  accountId: string
  accountName: string
  status: 'completed' | 'failed' | 'skipped'
  imported?: number
  warnings?: string[]
  error?: string
}

export type CronRunCheckpoint = {
  phase: 'received' | 'authenticating' | 'authenticated' | 'enumerated' | 'syncing' | 'completed' | 'failed'
  status?: 'running' | 'completed' | 'failed'
  workspaceIds?: string[]
  eligible?: number
  results?: CronAccountResult[]
  error?: string
  responseStatus?: number
}

type CronRunContext = {
  runDate: string
  dryRun: boolean
  deploymentId?: string
  deploymentUrl?: string
  gitCommitSha?: string
  requestId?: string
  userAgent?: string
}

export type CronRunReporter = {
  id: string
  start: () => Promise<void>
  checkpoint: (checkpoint: CronRunCheckpoint) => Promise<void>
}

const clipped = (value: string | undefined, length: number) => value?.slice(0, length) || null

export function createCronRunReporter(databaseUrl: string | undefined, context: CronRunContext): CronRunReporter {
  const id = crypto.randomUUID()
  const sql = databaseUrl ? neon(databaseUrl) : null

  async function safely(operation: () => Promise<unknown>) {
    if (!sql) return
    try {
      await operation()
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : 'unknown error'
      console.error(`Could not persist bank sync cron diagnostics: ${message.slice(0, 300)}`)
    }
  }

  return {
    id,
    start: () => safely(() => sql!`
      insert into public.bank_sync_cron_runs (
        id, run_date, dry_run, deployment_id, deployment_url, git_commit_sha, request_id, user_agent
      ) values (
        ${id}::uuid,
        ${context.runDate}::date,
        ${context.dryRun},
        ${clipped(context.deploymentId, 200)},
        ${clipped(context.deploymentUrl, 500)},
        ${clipped(context.gitCommitSha, 200)},
        ${clipped(context.requestId, 500)},
        ${clipped(context.userAgent, 500)}
      )
    `),
    checkpoint: (checkpoint) => {
      const results = checkpoint.results
      const attempted = results?.filter((result) => result.status !== 'skipped').length ?? null
      const completed = results?.filter((result) => result.status === 'completed').length ?? null
      const failed = results?.filter((result) => result.status === 'failed').length ?? null
      const skipped = results?.filter((result) => result.status === 'skipped').length ?? null
      const terminal = checkpoint.status === 'completed' || checkpoint.status === 'failed'
      const workspaceIds = checkpoint.workspaceIds ? JSON.stringify(checkpoint.workspaceIds) : null
      return safely(() => sql!`
        update public.bank_sync_cron_runs
        set phase = ${checkpoint.phase},
            status = ${checkpoint.status ?? 'running'},
            workspace_ids = case
              when ${workspaceIds}::jsonb is null then workspace_ids
              else array(select jsonb_array_elements_text(${workspaceIds}::jsonb)::uuid)
            end,
            eligible_count = coalesce(${checkpoint.eligible ?? null}, eligible_count),
            attempted_count = coalesce(${attempted}, attempted_count),
            completed_count = coalesce(${completed}, completed_count),
            failed_count = coalesce(${failed}, failed_count),
            skipped_count = coalesce(${skipped}, skipped_count),
            account_results = coalesce(${results ? JSON.stringify(results) : null}::jsonb, account_results),
            error_message = coalesce(${clipped(checkpoint.error, 500)}, error_message),
            response_status = coalesce(${checkpoint.responseStatus ?? null}, response_status),
            completed_at = case when ${terminal} then now() else completed_at end
        where id = ${id}::uuid
      `)
    },
  }
}
