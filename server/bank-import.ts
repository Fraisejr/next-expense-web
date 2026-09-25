import { saveTransferReference } from './bank-reference.ts'
import type { BankSyncPayload, BankSyncSummary } from '../shared/bank-types.ts'
import { zeroAmountAction, zeroAmountReason } from '../src/bank-import-policy.ts'
import { bankData, amountToMinor, todayInParis, recentSyncRuns, normalizedPayeeName, daysApart, shiftedDate, rematchPendingBankImportPayees } from '../shared/bank-data.ts'
import type { BankDatabase } from '../shared/bank-data.ts'
import type { Account, BankSyncDiagnostic } from '../src/types.ts'
type Row = Record<string, unknown>
const number = (value: unknown) => Number(value ?? 0)

type CandidateInsertResult = { inserted: number; conflicts: number }

async function candidateExists(neon: BankDatabase, row: Row) {
  for (const column of ['provider_transaction_id', 'bank_transaction_id'] as const) {
    const value = row[column]
    if (!value) continue
    const existing = await neon.from('bank_import_candidates').select('id')
      .eq('workspace_id', row.workspace_id).eq('account_id', row.account_id)
      .eq('provider', row.provider).eq(column, value).limit(1)
    if (existing.error) throw existing.error
    if (existing.data?.length) return true
  }
  return false
}

// The sync lease prevents normal overlap, but an expired request can still
// finish after a newer web or iOS sync has claimed the lease. Keep bulk writes
// fast, then recover only the conflicting batch row by row. A verified unique
// conflict means the other request already staged that bank transaction.
async function insertBankImportCandidates(neon: BankDatabase, rows: Row[]): Promise<CandidateInsertResult> {
  let inserted = 0
  let conflicts = 0
  for (let start = 0; start < rows.length; start += 500) {
    const batch = rows.slice(start, start + 500)
    const result = await neon.from('bank_import_candidates').insert(batch)
    if (!result.error) {
      inserted += batch.length
      continue
    }
    if (result.error.code !== '23505') throw result.error

    for (const row of batch) {
      const retry = await neon.from('bank_import_candidates').insert(row)
      if (!retry.error) {
        inserted += 1
        continue
      }
      if (retry.error.code !== '23505' || !await candidateExists(neon, row)) throw retry.error
      conflicts += 1
    }
  }
  return { inserted, conflicts }
}

export async function saveBankSync(neon: BankDatabase, workspaceId: string, account: Pick<Account, 'id' | 'currency' | 'providerAccountId' | 'bankImportMode'>, sync: BankSyncPayload): Promise<BankSyncSummary> {
  const { ensurePeriod, findPayees } = bankData(neon)
  if (!account.providerAccountId) throw new Error('This account is not connected to a bank.')

  const connectionResult = await neon.from('bank_connections')
    .select('id,metadata,last_synced_at')
    .eq('workspace_id', workspaceId)
    .eq('account_id', account.id)
    .eq('provider', 'gocardless_bank_account_data')
    .eq('status', 'active')
    .limit(1)
  if (connectionResult.error) throw connectionResult.error
  const connection = connectionResult.data?.[0] as Row | undefined
  if (!connection) throw new Error('Reconnect this account before syncing again.')
  const connectionMetadata = connection?.metadata && typeof connection.metadata === 'object' ? connection.metadata as Row : {}
  const syncHistory = recentSyncRuns(connectionMetadata, connection?.last_synced_at, Date.parse(sync.fetchedAt))
  syncHistory.push(sync.fetchedAt)

  // Historical references and decisions must not be truncated by the API's
  // page limit, or a later sync could offer an old transaction again.
  const readAll = async (table: string, columns: string, filters: Record<string, string>, either?: string) => {
    const rows: Row[] = []
    for (let offset = 0; ; offset += 500) {
      let query = neon.from(table).select(columns).eq('workspace_id', workspaceId).order('id', { ascending: true })
      for (const [column, value] of Object.entries(filters)) query = query.eq(column, value)
      if (either) query = query.or(either)
      const { data, error } = await query.range(offset, offset + 499)
      if (error) throw error
      const page = (data ?? []) as unknown as Row[]
      rows.push(...page)
      if (page.length < 500) return { data: rows, error: null }
    }
  }
  const [aliasResult, referenceResult, transferResult, candidateResult] = await Promise.all([
    readAll('bank_account_aliases', 'account_id,normalized_alias', { provider: 'gocardless_bank_account_data' }),
    readAll('bank_transaction_refs', 'id,transaction_id,provider_transaction_id,bank_transaction_id', { provider: 'gocardless_bank_account_data', account_id: account.id }),
    readAll('transactions', 'id,account_id,destination_account_id,transaction_date,amount_minor,destination_amount_minor,currency,transaction_type', { transaction_type: 'transfer' }, `account_id.eq.${account.id},destination_account_id.eq.${account.id}`),
    readAll('bank_import_candidates', 'id,status,decision_reason,transaction_id,provider_transaction_id,bank_transaction_id,posted', { provider: 'gocardless_bank_account_data', account_id: account.id }),
  ])
  if (aliasResult.error) throw aliasResult.error
  if (referenceResult.error) throw referenceResult.error
  if (transferResult.error) throw transferResult.error
  if (candidateResult.error) throw candidateResult.error

  const aliasAccountIds = new Map(((aliasResult.data ?? []) as unknown as Row[])
    .map((row) => [String(row.normalized_alias), String(row.account_id)]))
  const referenceRows = (referenceResult.data ?? []) as unknown as Row[]
  const referencedProviderIds = new Set(referenceRows.flatMap((row) => row.provider_transaction_id ? [String(row.provider_transaction_id)] : []))
  const referencedBankIds = new Set(referenceRows.flatMap((row) => row.bank_transaction_id ? [String(row.bank_transaction_id)] : []))
  const transferRows = (transferResult.data ?? []) as unknown as Row[]
  const candidateRows = (candidateResult.data ?? []) as unknown as Row[]
  const candidateByProviderId = new Map(candidateRows.flatMap((row) => row.provider_transaction_id ? [[String(row.provider_transaction_id), row] as const] : []))
  const candidateByBankId = new Map(candidateRows.flatMap((row) => row.bank_transaction_id ? [[String(row.bank_transaction_id), row] as const] : []))
  const candidateFor = (transaction: BankSyncPayload['transactions'][number]) => candidateByProviderId.get(transaction.providerTransactionId)
    ?? (transaction.bankTransactionId ? candidateByBankId.get(transaction.bankTransactionId) : undefined)

  const matchingTransfer = (transaction: BankSyncPayload['transactions'][number]) => {
    const aliasAccountId = aliasAccountIds.get(normalizedPayeeName(transaction.payee))
    const counterpartyAccountId = aliasAccountId && aliasAccountId !== account.id ? aliasAccountId : undefined
    if (transaction.currency !== account.currency) return undefined
    const amountMinor = amountToMinor(transaction.amount, transaction.currency)
    const candidates = transferRows.filter((row) => {
      if (daysApart(row.transaction_date, transaction.date) > 3) return false
      if (transaction.type === 'income') {
        return row.destination_account_id === account.id
          && (!counterpartyAccountId || row.account_id === counterpartyAccountId)
          && number(row.destination_amount_minor || row.amount_minor) === amountMinor
      }
      return row.account_id === account.id
        && (!counterpartyAccountId || row.destination_account_id === counterpartyAccountId)
        && number(row.amount_minor) === amountMinor
    })
    if (!candidates.length) return undefined
    const closestDays = Math.min(...candidates.map((row) => daysApart(row.transaction_date, transaction.date)))
    const closest = candidates.filter((row) => daysApart(row.transaction_date, transaction.date) === closestDays)
    return closest.length === 1 ? closest[0] : undefined
  }

  const unique = new Map<string, BankSyncPayload['transactions'][number]>()
  for (const transaction of sync.transactions) {
    const current = unique.get(transaction.providerTransactionId)
    if (!current || transaction.status === 'booked') unique.set(transaction.providerTransactionId, transaction)
  }
  const existingIds = new Set<string>(referencedProviderIds)
  const existingBankIds = new Set<string>(referencedBankIds)
  const existingByProviderId = new Map<string, Row>()
  const existingByBankId = new Map<string, Row>()
  const existingBankFingerprints = new Map<string, Row[]>()
  const existingPendingFingerprints = new Map<string, Row[]>()
  let hasGoCardlessHistory = false
  let latestLedgerDate = ''
  const pageSize = 1000
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await neon.from('transactions')
      .select('id,provider_transaction_id,bank_transaction_id,transaction_date,source,amount_minor,currency,transaction_type,category_id,payee_id,payee_name,memo,bank_memo,posted')
      .eq('workspace_id', workspaceId)
      .eq('account_id', account.id)
      .order('id', { ascending: true })
      .range(start, start + pageSize - 1)
    if (error) throw error
    const page = (data ?? []) as unknown as Row[]
    for (const row of page) {
      if (row.provider_transaction_id) {
        existingIds.add(String(row.provider_transaction_id))
        existingByProviderId.set(String(row.provider_transaction_id), row)
      }
      if (row.bank_transaction_id) {
        existingBankIds.add(String(row.bank_transaction_id))
        existingByBankId.set(String(row.bank_transaction_id), row)
      }
      if (row.source === 'gocardless') {
        hasGoCardlessHistory = true
        const key = `${row.transaction_date}|${row.currency}|${row.transaction_type}|${row.amount_minor}|${String(row.payee_name ?? '').trim().toLocaleLowerCase('en')}`
        existingBankFingerprints.set(key, [...(existingBankFingerprints.get(key) ?? []), row])
        if (row.posted === false) {
          const pendingKey = `${row.currency}|${row.transaction_type}|${row.amount_minor}|${String(row.payee_name ?? '').trim().toLocaleLowerCase('en')}`
          existingPendingFingerprints.set(pendingKey, [...(existingPendingFingerprints.get(pendingKey) ?? []), row])
        }
      }
      if (String(row.transaction_date ?? '') > latestLedgerDate) latestLedgerDate = String(row.transaction_date)
    }
    if (page.length < pageSize) break
  }

  let zeroIgnored = 0
  let zeroReopened = 0
  for (const transaction of unique.values()) {
    const candidate = candidateFor(transaction)
    const action = zeroAmountAction(amountToMinor(transaction.amount, transaction.currency), candidate)
    if (action === 'ignore') {
      // Keep a reversible tombstone with the original provider payload. Never
      // replace a user's rejection, an approved item, or a matched ledger row.
      const values = {
        transaction_date: transaction.date, amount_minor: 0, currency: transaction.currency,
        transaction_type: transaction.type, payee_name: transaction.payee,
        bank_memo: transaction.note || null, posted: transaction.status === 'booked',
        fetched_at: sync.fetchedAt, raw_payload: transaction.rawPayload ?? null,
        provider_transaction_id: transaction.providerTransactionId,
        bank_transaction_id: transaction.bankTransactionId ?? null,
        status: 'rejected', decision_reason: zeroAmountReason, decided_at: sync.fetchedAt,
      }
      if (candidate?.status === 'pending' || (candidate?.status === 'rejected' && candidate.decision_reason === zeroAmountReason)) {
        const result = await neon.from('bank_import_candidates').update(values)
          .eq('workspace_id', workspaceId).eq('id', candidate.id).eq('status', candidate.status)
        if (result.error) throw result.error
      } else if (!candidate && !existingIds.has(transaction.providerTransactionId)
        && (!transaction.bankTransactionId || !existingBankIds.has(transaction.bankTransactionId))) {
        await insertBankImportCandidates(neon, [{
          ...values, memo: null, id: crypto.randomUUID(), workspace_id: workspaceId,
          account_id: account.id, provider: 'gocardless_bank_account_data',
        }])
      }
      unique.delete(transaction.providerTransactionId)
      zeroIgnored += 1
      continue
    }
    if (!candidate || candidate.status === 'approved') continue
    if (candidate.status === 'pending' || action === 'reopen') {
      const candidateUpdate = await neon.from('bank_import_candidates').update({
        ...(action === 'reopen' ? { status: 'pending', decision_reason: null, decided_at: null } : {}),
        transaction_date: transaction.date,
        amount_minor: amountToMinor(transaction.amount, transaction.currency),
        currency: transaction.currency,
        transaction_type: transaction.type,
        payee_name: transaction.payee,
        bank_memo: transaction.note || null,
        posted: transaction.status === 'booked',
        fetched_at: sync.fetchedAt,
        raw_payload: transaction.rawPayload ?? null,
        provider_transaction_id: transaction.providerTransactionId,
        bank_transaction_id: transaction.bankTransactionId ?? null,
      }).eq('workspace_id', workspaceId).eq('id', candidate.id).eq('status', candidate.status)
      if (candidateUpdate.error) throw candidateUpdate.error
      if (action === 'reopen') zeroReopened += 1
    }
    existingIds.add(transaction.providerTransactionId)
    if (transaction.bankTransactionId) existingBankIds.add(transaction.bankTransactionId)
  }

  let pendingPromoted = 0
  let pendingStaged = 0
  let transfersMatched = 0
  let referenceConflicts = 0
  const promotePending = async (row: Row, transaction: BankSyncPayload['transactions'][number]) => {
    if (!row.category_id) {
      const candidate = candidateFor(transaction)
      const candidateValues = {
        transaction_id: row.id,
        transaction_date: transaction.date,
        amount_minor: amountToMinor(transaction.amount, transaction.currency),
        currency: transaction.currency,
        transaction_type: transaction.type,
        payee_id: row.payee_id ?? null,
        payee_name: transaction.payee,
        bank_memo: transaction.note || null,
        posted: true,
        fetched_at: sync.fetchedAt,
        raw_payload: transaction.rawPayload ?? null,
        provider_transaction_id: transaction.providerTransactionId,
        bank_transaction_id: transaction.bankTransactionId ?? null,
      }
      if (candidate) {
        if (candidate.status !== 'pending') return
        const candidateUpdate = await neon.from('bank_import_candidates').update(candidateValues).eq('workspace_id', workspaceId).eq('id', candidate.id)
        if (candidateUpdate.error) throw candidateUpdate.error
        pendingStaged += 1
      } else {
        const candidateInsert = await insertBankImportCandidates(neon, [{
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          account_id: account.id,
          provider: 'gocardless_bank_account_data',
          category_id: null,
          status: 'pending',
          memo: null,
          ...candidateValues,
        }])
        pendingStaged += candidateInsert.inserted
      }
      return
    }
    const periodId = await ensurePeriod(workspaceId, transaction.date.slice(0, 7))
    const promotionResult = await neon.from('transactions').update({
      period_id: periodId,
      transaction_date: transaction.date,
      source_timestamp: `${transaction.date}T12:00:00Z`,
      source_created_at: sync.fetchedAt,
      amount_minor: amountToMinor(transaction.amount, transaction.currency),
      currency: transaction.currency,
      transaction_type: transaction.type,
      payee_name: transaction.payee,
      bank_memo: transaction.note || null,
      provider_transaction_id: transaction.providerTransactionId,
      bank_transaction_id: transaction.bankTransactionId ?? null,
      posted: true,
      reconciled: true,
    }).eq('workspace_id', workspaceId).eq('id', row.id)
    if (promotionResult.error) throw promotionResult.error
    row.posted = true
    existingIds.add(transaction.providerTransactionId)
    existingByProviderId.set(transaction.providerTransactionId, row)
    if (transaction.bankTransactionId) {
      existingBankIds.add(transaction.bankTransactionId)
      existingByBankId.set(transaction.bankTransactionId, row)
    }
    pendingPromoted += 1
  }

  for (const transaction of unique.values()) {
    if (candidateFor(transaction)?.status === 'rejected') continue
    if (referencedProviderIds.has(transaction.providerTransactionId)) continue
    if (transaction.bankTransactionId && referencedBankIds.has(transaction.bankTransactionId)) continue
    const transfer = matchingTransfer(transaction)
    if (!transfer) continue

    const existingReference = referenceRows.find((row) => row.transaction_id === transfer.id
      && (row.provider_transaction_id === transaction.providerTransactionId
        || (transaction.bankTransactionId && row.bank_transaction_id === transaction.bankTransactionId)))
    if (!existingReference) {
      const sameTransfer = await saveTransferReference(neon, {
        workspace_id: workspaceId,
        transaction_id: String(transfer.id),
        account_id: account.id,
        provider: 'gocardless_bank_account_data',
        provider_transaction_id: transaction.providerTransactionId,
        bank_transaction_id: transaction.bankTransactionId ?? null,
      })
      if (!sameTransfer) {
        // Another saved match owns this ID. Preserve both ledger records and
        // exclude it from all remaining promotion/import steps in this run.
        unique.delete(transaction.providerTransactionId)
        referenceConflicts += 1
        continue
      }
    }

    const duplicate = existingByProviderId.get(transaction.providerTransactionId)
      ?? (transaction.bankTransactionId ? existingByBankId.get(transaction.bankTransactionId) : undefined)
    if (duplicate && duplicate.id !== transfer.id) {
      const deleteResult = await neon.from('transactions')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('id', duplicate.id)
      if (deleteResult.error) throw deleteResult.error
    }

    referencedProviderIds.add(transaction.providerTransactionId)
    existingIds.add(transaction.providerTransactionId)
    if (transaction.bankTransactionId) {
      referencedBankIds.add(transaction.bankTransactionId)
      existingBankIds.add(transaction.bankTransactionId)
    }
    const candidate = candidateFor(transaction)
    if (candidate?.status === 'pending') {
      const candidateUpdate = await neon.from('bank_import_candidates').update({
        status: 'matched',
        transaction_id: transfer.id,
        decided_at: new Date().toISOString(),
      }).eq('workspace_id', workspaceId).eq('id', candidate.id)
      if (candidateUpdate.error) throw candidateUpdate.error
    }
    transfersMatched += 1
  }

  for (const transaction of unique.values()) {
    if (transaction.status !== 'booked') continue
    const existing = existingByProviderId.get(transaction.providerTransactionId)
      ?? (transaction.bankTransactionId ? existingByBankId.get(transaction.bankTransactionId) : undefined)
    if (existing?.posted === false) {
      await promotePending(existing, transaction)
    } else if (existing && existing.category_id && String(existing.payee_name ?? '').trim().toLocaleLowerCase('en') === 'bank transaction'
      && (transaction.payee !== 'Bank transaction' || transaction.note)) {
      const repairResult = await neon.from('transactions').update({
        payee_name: transaction.payee,
        bank_memo: transaction.note || existing.bank_memo || existing.memo || null,
      }).eq('workspace_id', workspaceId).eq('id', existing.id)
      if (repairResult.error) throw repairResult.error
      existing.payee_name = transaction.payee
      existing.bank_memo = transaction.note || existing.bank_memo || existing.memo || null
    }
  }

  for (const transaction of unique.values()) {
    if (existingIds.has(transaction.providerTransactionId)) continue
    if (transaction.bankTransactionId && existingBankIds.has(transaction.bankTransactionId)) continue
    const amountMinor = amountToMinor(transaction.amount, transaction.currency)
    const normalizedPayee = transaction.payee.trim().toLocaleLowerCase('en')
    const fingerprint = `${transaction.date}|${transaction.currency}|${transaction.type}|${amountMinor}|${normalizedPayee}`
    let matches = existingBankFingerprints.get(fingerprint) ?? []
    if (matches.length !== 1 && transaction.status === 'booked') {
      const pendingFingerprint = `${transaction.currency}|${transaction.type}|${amountMinor}|${normalizedPayee}`
      const pendingMatches = existingPendingFingerprints.get(pendingFingerprint) ?? []
      if (pendingMatches.length === 1) matches = pendingMatches
    }
    if (matches.length !== 1) continue
    if (transaction.status === 'booked' && matches[0].posted === false) {
      await promotePending(matches[0], transaction)
    } else {
      const repairResult = await neon.from('transactions')
        .update({
          provider_transaction_id: transaction.providerTransactionId,
          bank_transaction_id: transaction.bankTransactionId ?? null,
        })
        .eq('workspace_id', workspaceId)
        .eq('id', matches[0].id)
      if (repairResult.error) throw repairResult.error
    }
    existingIds.add(transaction.providerTransactionId)
    if (transaction.bankTransactionId) existingBankIds.add(transaction.bankTransactionId)
  }

  const legacyCutoff = String(connectionMetadata.legacy_cutoff ?? (!hasGoCardlessHistory ? latestLedgerDate : ''))
  const receivedTransactions = [...unique.values()]
  const unseenTransactions = receivedTransactions
    .filter((transaction) => !existingIds.has(transaction.providerTransactionId))
    .filter((transaction) => !transaction.bankTransactionId || !existingBankIds.has(transaction.bankTransactionId))
  const cutoffIgnored = unseenTransactions.filter((transaction) => Boolean(legacyCutoff) && transaction.date <= legacyCutoff).length
  const afterCutoff = unseenTransactions.filter((transaction) => !legacyCutoff || transaction.date > legacyCutoff)
  const today = todayInParis()
  const futureIgnored = afterCutoff.filter((transaction) => transaction.date > today).length
  const newTransactions = afterCutoff
    // A migrated account may contain the same bank history under provider IDs
    // from an older consent. Establish a clean delta boundary on its first sync.
    .filter((transaction) => transaction.date <= today)
  const duplicates = referenceConflicts + Math.max(0, receivedTransactions.length - unseenTransactions.length - pendingPromoted - transfersMatched)

  const sourcePayeeNames = [...new Set(newTransactions.flatMap((transaction) => [transaction.payee, transaction.note ?? '']).map((name) => name.normalize('NFKC').trim()).filter(Boolean))]
  const [resolvedPayees, categoryResult] = await Promise.all([
    findPayees(workspaceId, sourcePayeeNames),
    neon.from('categories').select('id,hidden').eq('workspace_id', workspaceId),
  ])
  if (categoryResult.error) throw categoryResult.error
  const hiddenCategoryIds = new Set((categoryResult.data ?? []).filter((category) => category.hidden).map((category) => String(category.id)))
  const payeeIdByName = new Map<string, string>()
  const defaultCategoryIdByName = new Map<string, string>()
  sourcePayeeNames.forEach((name, index) => {
    const payee = resolvedPayees[index]
    if (!payee) return
    const normalizedName = normalizedPayeeName(name)
    payeeIdByName.set(normalizedName, payee.id)
    if (payee.defaultCategoryId) defaultCategoryIdByName.set(normalizedName, payee.defaultCategoryId)
  })
  const matchedValueFor = <T,>(values: Map<string, T>, transaction: BankSyncPayload['transactions'][number]) => values.get(normalizedPayeeName(transaction.payee)) ?? (transaction.note ? values.get(normalizedPayeeName(transaction.note)) : undefined)
  const payeeIdFor = (transaction: BankSyncPayload['transactions'][number]) => matchedValueFor(payeeIdByName, transaction)
  const defaultCategoryFor = (transaction: BankSyncPayload['transactions'][number]) => matchedValueFor(defaultCategoryIdByName, transaction)
  const canApplyDefaultCategory = (transaction: BankSyncPayload['transactions'][number]) => {
    const categoryId = defaultCategoryFor(transaction)
    return Boolean(categoryId && !hiddenCategoryIds.has(categoryId))
  }
  const transactionsToInsert = account.bankImportMode === 'automatic'
    ? newTransactions.filter(canApplyDefaultCategory)
    : []
  const transactionsToStage = account.bankImportMode === 'automatic'
    ? newTransactions.filter((transaction) => !canApplyDefaultCategory(transaction))
    : newTransactions

  const periodIds = new Map<string, string>()
  const rows: Row[] = []
  for (const transaction of transactionsToInsert) {
    const month = transaction.date.slice(0, 7)
    let periodId = periodIds.get(month)
    if (!periodId) {
      periodId = await ensurePeriod(workspaceId, month)
      periodIds.set(month, periodId)
    }
    rows.push({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      account_id: account.id,
      period_id: periodId,
      transaction_date: transaction.date,
      source_timestamp: `${transaction.date}T12:00:00Z`,
      source_created_at: sync.fetchedAt,
      amount_minor: amountToMinor(transaction.amount, transaction.currency),
      destination_amount_minor: 0,
      currency: transaction.currency,
      transaction_type: transaction.type,
      category_id: defaultCategoryFor(transaction),
      payee_id: payeeIdFor(transaction) ?? null,
      payee_name: transaction.payee,
      memo: null,
      bank_memo: transaction.note || null,
      provider_transaction_id: transaction.providerTransactionId,
      bank_transaction_id: transaction.bankTransactionId ?? null,
      posted: transaction.status === 'booked',
      reconciled: transaction.status === 'booked',
      source: 'gocardless',
    })
  }
  for (let start = 0; start < rows.length; start += 500) {
    const { error } = await neon.from('transactions').insert(rows.slice(start, start + 500))
    if (error) throw error
  }

  const candidateRowsToInsert = transactionsToStage.map((transaction) => ({
    id: crypto.randomUUID(),
    workspace_id: workspaceId,
    account_id: account.id,
    provider: 'gocardless_bank_account_data',
    provider_transaction_id: transaction.providerTransactionId,
    bank_transaction_id: transaction.bankTransactionId ?? null,
    transaction_date: transaction.date,
    amount_minor: amountToMinor(transaction.amount, transaction.currency),
    currency: transaction.currency,
    transaction_type: transaction.type,
    category_id: defaultCategoryFor(transaction) ?? null,
    payee_id: payeeIdFor(transaction) ?? null,
    payee_name: transaction.payee,
    memo: null,
    bank_memo: transaction.note || null,
    posted: transaction.status === 'booked',
    status: 'pending',
    fetched_at: sync.fetchedAt,
    raw_payload: transaction.rawPayload ?? null,
  }))
  const candidateInsert = await insertBankImportCandidates(neon, candidateRowsToInsert)
  // A pending transaction may have been seen before its bank description or
  // matching rule changed. Apply the same rematch used by Review on every sync.
  await rematchPendingBankImportPayees(neon, workspaceId, account.id)

  const receivedDates = sync.transactions.map((transaction) => transaction.date).sort()
  if (receivedDates.length && aliasAccountIds.size) {
    const candidateResult = await neon.from('transactions')
      .select('id,account_id,transaction_date,amount_minor,currency,transaction_type,payee_name,posted')
      .eq('workspace_id', workspaceId)
      .eq('source', 'gocardless')
      .eq('posted', true)
      .in('transaction_type', ['income', 'expense'])
      .gte('transaction_date', shiftedDate(receivedDates[0], -3))
      .lte('transaction_date', shiftedDate(receivedDates[receivedDates.length - 1], 3))
    if (candidateResult.error) throw candidateResult.error
    const candidates = (candidateResult.data ?? []) as unknown as Row[]
    const incomes = candidates.filter((row) => row.transaction_type === 'income')
    const expenses = candidates.filter((row) => row.transaction_type === 'expense')
    const usedIds = new Set<string>()

    for (const income of incomes) {
      const sourceAccountId = aliasAccountIds.get(normalizedPayeeName(String(income.payee_name ?? '')))
      if (!sourceAccountId || sourceAccountId === income.account_id || usedIds.has(String(income.id))) continue
      const possibleExpenses = expenses.filter((expense) => !usedIds.has(String(expense.id))
        && expense.account_id === sourceAccountId
        && expense.currency === income.currency
        && number(expense.amount_minor) === number(income.amount_minor)
        && daysApart(expense.transaction_date, String(income.transaction_date)) <= 3)
      if (!possibleExpenses.length) continue
      const closestDays = Math.min(...possibleExpenses.map((expense) => daysApart(expense.transaction_date, String(income.transaction_date))))
      const closest = possibleExpenses.filter((expense) => daysApart(expense.transaction_date, String(income.transaction_date)) === closestDays)
      if (closest.length !== 1) continue

      const expense = closest[0]
      const reconciliationResult = await neon.rpc('reconcile_bank_transfer', {
        p_workspace_id: workspaceId,
        p_expense_id: expense.id,
        p_income_id: income.id,
        p_provider: 'gocardless_bank_account_data',
      })
      if (reconciliationResult.error) throw reconciliationResult.error
      usedIds.add(String(expense.id))
      usedIds.add(String(income.id))
      transfersMatched += 1
    }
  }

  const accountUpdate: Row = { last_refresh_at: sync.fetchedAt }
  const bankBalance = sync.balance ? {
    amount_minor: amountToMinor(sync.balance.amount, sync.balance.currency) * (Number(sync.balance.amount) < 0 ? -1 : 1),
    currency: sync.balance.currency,
    type: sync.balance.type,
    fetched_at: sync.fetchedAt,
  } : undefined
  const balanceUpdated = Boolean(bankBalance)
  const accountResult = await neon.from('accounts').update(accountUpdate).eq('workspace_id', workspaceId).eq('id', account.id)
  if (accountResult.error) throw accountResult.error

  const bookedImported = transactionsToInsert.filter((transaction) => transaction.status === 'booked').length
  const pendingImported = transactionsToInsert.filter((transaction) => transaction.status === 'pending').length
  const diagnostic: BankSyncDiagnostic = {
    fetchedAt: sync.fetchedAt,
    bookedReturned: sync.providerDiagnostics?.bookedReturned ?? sync.transactions.filter((transaction) => transaction.status === 'booked').length,
    pendingReturned: sync.providerDiagnostics?.pendingReturned ?? sync.transactions.filter((transaction) => transaction.status === 'pending').length,
    malformedIgnored: sync.providerDiagnostics?.malformedIgnored ?? 0,
    imported: rows.length,
    staged: candidateInsert.inserted + pendingStaged + zeroReopened,
    bookedImported,
    pendingImported,
    duplicates: duplicates + candidateInsert.conflicts,
    transfersMatched,
    pendingPromoted,
    cutoffIgnored,
    zeroIgnored,
    futureIgnored,
    balanceType: sync.balance?.type || undefined,
    transactionError: sync.errors?.transactions || undefined,
    balanceError: sync.errors?.balances || undefined,
  }
  const previousDiagnostics = Array.isArray(connectionMetadata.sync_diagnostics)
    ? connectionMetadata.sync_diagnostics.filter((item) => item && typeof item === 'object').slice(-24)
    : []

  if (connection) {
    const updateResult = await neon.from('bank_connections').update({
      last_synced_at: sync.fetchedAt,
      metadata: {
        ...connectionMetadata,
        legacy_cutoff: legacyCutoff || null,
        rate_limits: sync.rateLimits,
        sync_history: [...new Set(syncHistory)].sort(),
        bank_balance: bankBalance ?? connectionMetadata.bank_balance,
        last_imported: rows.length,
        last_sync_diagnostic: diagnostic,
        sync_diagnostics: [...previousDiagnostics, diagnostic],
        last_provider_response: sync.rawProviderResponse ? {
          fetched_at: sync.fetchedAt,
          ...sync.rawProviderResponse,
        } : connectionMetadata.last_provider_response,
      },
    }).eq('workspace_id', workspaceId).eq('id', connection.id)
    if (updateResult.error) throw updateResult.error
  }

  return {
    imported: rows.length,
    duplicates,
    balanceUpdated,
    rateLimits: sync.rateLimits,
    syncedAt: sync.fetchedAt,
    syncRunsLast24Hours: [...new Set(syncHistory)].length,
    diagnostic,
    warnings: [sync.errors?.transactions, sync.errors?.balances].filter((warning): warning is string => Boolean(warning)),
  }
}
