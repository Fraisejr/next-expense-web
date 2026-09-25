import type { PostgrestClient } from '@supabase/postgrest-js'
import type { Payee } from '../src/types.ts'
type Row = Record<string, unknown>
const syncHistoryWindowMs = 24 * 60 * 60 * 1000
export type BankDatabase = Pick<PostgrestClient, 'from' | 'rpc'>

export function normalizedPayeeName(value: string) {
  const decoded = value.replace(/&#(x[\da-f]+|\d+);/gi, (entity, code: string) => {
    const point = code.toLocaleLowerCase('en').startsWith('x') ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10)
    try { return Number.isFinite(point) ? String.fromCodePoint(point) : entity } catch { return entity }
  }).replace(/&(amp|quot|apos|lt|gt);/gi, (entity) => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }[entity.toLocaleLowerCase('en')] ?? entity))
  return decoded.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
}

export function prefixMappingMatches(sourceName: string, mappingName: string) {
  if (!sourceName.startsWith(mappingName) || sourceName.length === mappingName.length) return false
  return !/[\p{L}\p{N}]/u.test(sourceName.slice(mappingName.length, mappingName.length + 1))
}

export function daysApart(left: unknown, right: string) {
  const leftTime = Date.parse(`${String(left)}T12:00:00Z`)
  const rightTime = Date.parse(`${right}T12:00:00Z`)
  return Number.isFinite(leftTime) && Number.isFinite(rightTime)
    ? Math.abs(leftTime - rightTime) / (24 * 60 * 60 * 1000)
    : Number.POSITIVE_INFINITY
}

export function shiftedDate(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function recentSyncRuns(metadata: Row | undefined, lastSyncedAt?: unknown, now = Date.now()) {
  const cutoff = now - syncHistoryWindowMs
  const storedRuns = Array.isArray(metadata?.sync_history) ? metadata.sync_history : []
  const runs = storedRuns
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => {
      const timestamp = Date.parse(value)
      return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now
    })

  if (!runs.length && typeof lastSyncedAt === 'string') {
    const timestamp = Date.parse(lastSyncedAt)
    if (Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now) runs.push(lastSyncedAt)
  }
  return [...new Set(runs)].sort()
}

export function amountToMinor(value: string, currency: string) {
  let fractionDigits = 2
  try {
    fractionDigits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    // Unknown currencies fall back to the standard two decimal places.
  }
  const amount = Number(value)
  const minor = Math.round(Math.abs(amount) * 10 ** fractionDigits)
  if (!Number.isSafeInteger(minor)) throw new Error(`The bank returned an invalid ${currency} amount.`)
  return minor
}

export function todayInParis() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function bankData(neon: BankDatabase) {
  async function resolvePayees(workspaceId: string, sourceNames: string[], createMissing: boolean): Promise<Array<Payee | undefined>> {
    const names = [...new Set(sourceNames.map((name) => name.normalize('NFKC').trim()).filter(Boolean))]
    if (!names.length) return []

    const [payeeResult, mappingResult] = await Promise.all([
      neon.from('payees').select('id,name,default_category_id').eq('workspace_id', workspaceId).order('id', { ascending: true }),
      neon.from('payee_mappings').select('normalized_name,payee_id,match_type').eq('workspace_id', workspaceId).order('id', { ascending: true }),
    ])
    if (payeeResult.error) throw payeeResult.error
    if (mappingResult.error) throw mappingResult.error

    const payees: Payee[] = (payeeResult.data ?? []).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      defaultCategoryId: row.default_category_id ? String(row.default_category_id) : undefined,
    }))
    const payeeById = new Map(payees.map((payee) => [payee.id, payee]))
    const payeeByName = new Map<string, Payee>()
    const prefixMappings: { normalizedName: string; payee: Payee }[] = []
    for (const row of mappingResult.data ?? []) {
      const payee = payeeById.get(String(row.payee_id))
      const normalized = String(row.normalized_name)
      if (payee && row.match_type === 'starts_with') prefixMappings.push({ normalizedName: normalized, payee })
      else if (payee && !payeeByName.has(normalized)) payeeByName.set(normalized, payee)
    }
    for (const payee of payees) {
      const normalized = normalizedPayeeName(payee.name)
      if (!payeeByName.has(normalized)) payeeByName.set(normalized, payee)
    }
    const prefixPayeeFor = (normalized: string) => {
      const matches = prefixMappings.filter((mapping) => prefixMappingMatches(normalized, mapping.normalizedName)).sort((left, right) => right.normalizedName.length - left.normalizedName.length)
      if (!matches.length) return undefined
      const longestLength = matches[0].normalizedName.length
      const longestPayees = new Map(matches.filter((mapping) => mapping.normalizedName.length === longestLength).map((mapping) => [mapping.payee.id, mapping.payee]))
      return longestPayees.size === 1 ? [...longestPayees.values()][0] : undefined
    }

    if (createMissing) {
      for (const name of names) {
        const normalized = normalizedPayeeName(name)
        if (payeeByName.has(normalized) || prefixPayeeFor(normalized)) continue
        const payee: Payee = { id: crypto.randomUUID(), name }
        const { error } = await neon.from('payees').insert({
          id: payee.id,
          workspace_id: workspaceId,
          name: payee.name,
        })
        if (error) throw error
        payeeByName.set(normalized, payee)
        payeeById.set(payee.id, payee)
        payees.push(payee)
      }
    }

    return names.map((name) => {
      const normalized = normalizedPayeeName(name)
      return payeeByName.get(normalized) ?? prefixPayeeFor(normalized)
    })
  }
  async function findPayees(workspaceId: string, sourceNames: string[]) {
    return resolvePayees(workspaceId, sourceNames, false)
  }
  async function ensurePeriod(workspaceId: string, monthKey: string) {
    const [year, month] = monthKey.split('-').map(Number)
    const existing = await neon.from('periods').select('id').eq('workspace_id', workspaceId).eq('year', year).eq('month', month).limit(1)
    if (existing.error) throw existing.error
    if (existing.data?.[0]) return (existing.data[0] as Row).id as string

    const id = crypto.randomUUID()
    const { error } = await neon.from('periods').insert({
      id,
      workspace_id: workspaceId,
      year,
      month,
      month_label: new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1)),
      period_start_date: `${monthKey}-01`,
      source_start_at: `${monthKey}-01T12:00:00Z`,
    })
    if (error) throw error
    return id
  }
  return { resolvePayees, findPayees, ensurePeriod }
}

export async function rematchPendingBankImportPayees(neon: BankDatabase, workspaceId: string, accountId: string) {
  const { data, error } = await neon.from('bank_import_candidates')
    .select('id,payee_name,bank_memo')
    .eq('workspace_id', workspaceId)
    .eq('account_id', accountId)
    .eq('status', 'pending')
    .is('payee_id', null)
  if (error) throw error

  const candidates = (data ?? []) as unknown as Row[]
  const sourceNames = [...new Set(candidates.flatMap((candidate) => [candidate.payee_name, candidate.bank_memo])
    .map((value) => String(value ?? '').normalize('NFKC').trim())
    .filter(Boolean))]
  const resolvedPayees = await bankData(neon).findPayees(workspaceId, sourceNames)
  const payeeBySource = new Map(sourceNames.flatMap((sourceName, index) => {
    const payee = resolvedPayees[index]
    return payee ? [[normalizedPayeeName(sourceName), payee] as const] : []
  }))

  let matched = 0
  for (const candidate of candidates) {
    const payee = payeeBySource.get(normalizedPayeeName(String(candidate.payee_name ?? '')))
      ?? payeeBySource.get(normalizedPayeeName(String(candidate.bank_memo ?? '')))
    if (!payee) continue
    const update = await neon.from('bank_import_candidates')
      .update({
        payee_id: payee.id,
        ...(payee.defaultCategoryId ? { category_id: payee.defaultCategoryId } : {}),
      })
      .eq('workspace_id', workspaceId)
      .eq('id', candidate.id)
      .eq('status', 'pending')
      .is('payee_id', null)
      .select('id')
    if (update.error) throw update.error
    matched += update.data?.length ?? 0
  }
  return matched
}
