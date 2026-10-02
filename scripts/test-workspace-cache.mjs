import assert from 'node:assert/strict'
import { acceptWorkspaceRefresh, assessWorkspaceSnapshot, refreshWasOvertaken, shouldReloadWorkspace, validWorkspaceCache, workspaceCacheVersion, writeWorkspaceCache } from '../src/workspace-cache.ts'
import { bankQueueView } from '../src/bank-queue-state.ts'

const workspace = { workspaceId: 'workspace', loadedMonthKey: '2026-09', snapshotCountsAuthoritative: true, data: { accounts: [{ id: 'account' }], payees: [{ id: 'payee' }], categories: [{ id: 'category' }], timeCodes: [{ id: 'code' }], bankImportCandidates: [] } }
const cache = { version: workspaceCacheVersion, userId: 'alice', workspaceId: 'workspace', parisDate: '2026-10-01', revision: 42, workspace }

const full = { ...workspace, snapshotRevision: 79, candidateQueueByAccount: { account: 'pending' }, data: {
  accounts: [{ id: 'account', providerAccountId: 'bank-account' }], payees: [{ id: 'payee' }], categories: [{ id: 'category' }],
  timeCodes: [{ id: 'code' }], bankImportCandidates: [{ id: 'one', accountId: 'account' }, { id: 'two', accountId: 'account' }, { id: 'three', accountId: 'account' }],
} }
const partial = { ...full, data: { ...full.data, payees: [], categories: [], timeCodes: [], bankImportCandidates: [] } }
const trusted = { ...cache, revision: 79, workspace: full }
const poisoned = { ...trusted, workspace: partial }
assert.equal(assessWorkspaceSnapshot(partial, full).trusted, false, 'same-revision partial refresh must leave candidate rows and picker state mounted')
const pickerChoices = { one: { payeeId: 'payee', categoryId: 'category', memo: 'unsaved' } }
let displayed = full
await assert.rejects(async () => { displayed = acceptWorkspaceRefresh(displayed, await Promise.resolve(partial)) }, /refresh returned fewer rows|could not be verified|could not verify/)
assert.equal(displayed, full, 'the candidate list retains its object identity, so its keyed picker is not unmounted')
assert.deepEqual(pickerChoices, { one: { payeeId: 'payee', categoryId: 'category', memo: 'unsaved' } })
assert.equal(validWorkspaceCache(poisoned, 'alice'), false, 'partial refresh cannot poison a matching-revision cache')
globalThis.indexedDB = { open: () => { throw new Error('untrusted snapshot attempted persistence') } }
await writeWorkspaceCache(poisoned)
delete globalThis.indexedDB
assert.equal(shouldReloadWorkspace(poisoned, '2026-10-01', 79), true)
assert.equal(assessWorkspaceSnapshot(partial).trusted, false, 'first load with accounts but missing registries must show retry')
assert.equal(assessWorkspaceSnapshot({ ...full, data: { ...full.data, payees: [] } }).trusted, false, 'first load with only payees missing is incomplete')
assert.equal(assessWorkspaceSnapshot({ ...full, data: { ...full.data, categories: [] } }).trusted, false, 'first load with only categories missing is incomplete')
assert.equal(assessWorkspaceSnapshot({ ...partial, data: { ...partial.data, accounts: [] } }).trusted, true, 'new empty workspace is valid')
assert.equal(assessWorkspaceSnapshot({ ...full, snapshotRevision: 80, data: { ...full.data, bankImportCandidates: [] } }, full).trusted, true, 'revision advance allows a real queue deletion')
assert.equal(assessWorkspaceSnapshot({ ...full, snapshotRevision: 80, data: { ...full.data, payees: [] } }, full).trusted, false, 'revision advance cannot authenticate loss of a populated register')
assert.equal(assessWorkspaceSnapshot({ ...full, data: { ...full.data, bankImportCandidates: [] } }, full).trusted, false, 'candidate-only loss at the same revision is uncertain')
assert.equal(assessWorkspaceSnapshot({ ...full, data: { ...full.data, accounts: [{ id: 'account' }] } }, full).trusted, false, 'connection loss at the same revision is uncertain')
assert.equal(assessWorkspaceSnapshot({ ...full, data: { ...full.data, timeCodes: [] } }, full).trusted, false, 'time-code loss at the same revision is uncertain')
assert.equal(assessWorkspaceSnapshot({ ...full, snapshotRevision: 80, data: { ...full.data, accounts: [] } }, full).trusted, false, 'revision advance cannot confirm loss of accounts')
assert.equal(assessWorkspaceSnapshot({ ...full, snapshotRevision: 80, data: { ...full.data, timeCodes: [] } }, full).trusted, false, 'revision advance cannot confirm loss of time codes')
assert.equal(assessWorkspaceSnapshot({ ...full, snapshotRevision: 80, data: { ...full.data, accounts: [{ id: 'account' }] } }, full).trusted, false, 'revision advance cannot confirm loss of a bank connection')
assert.equal(assessWorkspaceSnapshot({ ...full, snapshotRevision: 80, bankConnectionCount: 1 }, { ...full, bankConnectionCount: 3 }).trusted, false, 'revision advance cannot confirm loss of connection rows even when the account view stays populated')
const provisional = { ...trusted, workspace: { ...full, candidateQueueVerified: false, data: { ...full.data, bankImportCandidates: [] } } }
assert.equal(validWorkspaceCache(provisional, 'alice'), false, 'connected empty queue must never enter the same-day cache')
assert.equal(shouldReloadWorkspace(provisional, '2026-10-01', 79), true)
const checkedEmpty = { ...trusted, workspace: { ...full, candidateQueueByAccount: { account: 'empty' }, data: { ...full.data, bankImportCandidates: [] } } }
assert.equal(validWorkspaceCache(checkedEmpty, 'alice'), true, 'twice-read zero remains a usable display cache')
assert.equal(shouldReloadWorkspace(checkedEmpty, '2026-10-01', 79), true, 'a cached false-zero must revalidate on every open')
assert.equal(shouldReloadWorkspace(checkedEmpty, '2026-10-01', 79), true, 'the same revision never makes a zero queue sticky')
const candidateOnlyLoss = { ...full, data: { ...full.data, bankImportCandidates: full.data.bankImportCandidates.slice(0, 1) } }
assert.equal(assessWorkspaceSnapshot(candidateOnlyLoss, full).trusted, false, 'same-revision candidate loss cannot replace known rows')
await assert.rejects(async () => { displayed = acceptWorkspaceRefresh(displayed, candidateOnlyLoss) }, /fewer rows/)
assert.equal(displayed, full, 'rejected candidate loss leaves in-flight picker choices mounted')
assert.deepEqual(pickerChoices, { one: { payeeId: 'payee', categoryId: 'category', memo: 'unsaved' } })
assert.equal(bankQueueView('empty', 0, 'idle'), 'empty', 'ordinary zero is not a permanent warning')
assert.equal(bankQueueView('unknown', 0, 'idle'), 'unknown')
assert.equal(bankQueueView('pending', 0, 'idle'), 'unknown', 'a locally cleared queue needs a recheck')
assert.equal(bankQueueView('empty', 0, 'refreshing'), 'checking')
assert.equal(bankQueueView('empty', 0, 'failed'), 'failed', 'a failed refresh is distinct from a successful zero')
assert.equal(bankQueueView('pending', 1, 'failed'), 'pending', 'a failed refresh preserves the prior good queue')
const mixed = { ...full, candidateQueueByAccount: { account: 'pending', other: 'empty', third: 'empty' }, data: { ...full.data, accounts: [...full.data.accounts, { id: 'other', providerAccountId: 'other-bank' }, { id: 'third', providerAccountId: 'third-bank' }] } }
assert.equal(bankQueueView(mixed.candidateQueueByAccount.account, 3, 'idle'), 'pending')
assert.equal(bankQueueView(mixed.candidateQueueByAccount.other, 0, 'idle'), 'empty')
const mixedCache = { ...trusted, workspace: mixed }
assert.equal(validWorkspaceCache(mixedCache, 'alice'), true, 'three connected accounts with one pending queue can display from cache')
assert.equal(shouldReloadWorkspace(mixedCache, '2026-10-01', 79), true, 'empty queues require a network refresh even at the same revision')
assert.equal(validWorkspaceCache({ ...mixedCache, workspace: { ...mixed, candidateQueueByAccount: { account: 'pending', other: 'empty' } } }, 'alice'), false, 'missing per-account queue status is incomplete')
const unknownCache = { ...mixedCache, workspace: { ...mixed, candidateQueueByAccount: { ...mixed.candidateQueueByAccount, third: 'unknown' } } }
assert.equal(validWorkspaceCache(unknownCache, 'alice'), true, 'a shaped unknown queue can display while it is checked')
assert.equal(shouldReloadWorkspace(unknownCache, '2026-10-01', 79), true)
const allPending = { ...mixedCache, workspace: { ...mixed, candidateQueueByAccount: { account: 'pending', other: 'pending', third: 'pending' }, data: { ...mixed.data, bankImportCandidates: [...mixed.data.bankImportCandidates, { id: 'four', accountId: 'other' }, { id: 'five', accountId: 'third' }] } } }
assert.equal(validWorkspaceCache(allPending, 'alice'), true)
assert.equal(shouldReloadWorkspace(allPending, '2026-10-01', 79), false, 'complete all-pending queues can skip the network refresh')
for (const incomplete of [
  { ...mixed, snapshotCountsAuthoritative: false, data: { ...mixed.data, accounts: mixed.data.accounts.slice(0, 2) } },
  { ...mixed, snapshotCountsAuthoritative: false, bankConnectionCount: 0 },
  { ...mixed, snapshotCountsAuthoritative: false, data: { ...mixed.data, timeCodes: [] } },
]) assert.equal(validWorkspaceCache({ ...trusted, workspace: incomplete }, 'alice'), false, 'known incomplete account, connection, or time-code data cannot enter the cache')
const deletedRegister = { ...full, snapshotRevision: 80, data: { ...full.data, payees: [], categories: [] } }
assert.equal(assessWorkspaceSnapshot(deletedRegister, full).trusted, false)
assert.equal(validWorkspaceCache({ ...trusted, revision: 80, workspace: deletedRegister }, 'alice'), false, 'revision-advanced register loss cannot poison the cache')
assert.equal(validWorkspaceCache({ ...trusted, workspace: { ...full, snapshotCountsAuthoritative: false } }, 'alice'), false, 'null or ambiguous independent counts prevent same-day cache')
assert.equal(validWorkspaceCache({ ...cache, workspace: { ...workspace, data: { ...workspace.data, accounts: [] } } }, 'alice'), false, 'an empty workspace cannot enter the same-day cache')
assert.equal(full.data.bankImportCandidates.length, 3, 'validation does not approve or remove candidates')

assert.equal(validWorkspaceCache(cache, 'alice'), true)
assert.equal(validWorkspaceCache(cache, 'bob'), false)
assert.equal(validWorkspaceCache({ ...cache, version: workspaceCacheVersion - 1 }, 'alice'), false)
assert.equal(validWorkspaceCache({ ...cache, version: 1 }, 'alice'), false, 'a V1 snapshot must be reloaded under the new policy')
assert.equal(validWorkspaceCache({ ...cache, workspaceId: 'other' }, 'alice'), false)
assert.equal(shouldReloadWorkspace(cache, '2026-10-01', 42), false)
assert.equal(shouldReloadWorkspace(cache, '2026-10-02', 42), true)
assert.equal(shouldReloadWorkspace(cache, '2026-10-01', 43), true)
assert.equal(shouldReloadWorkspace(cache, '2026-10-01', null), true)
assert.equal(shouldReloadWorkspace({ ...cache, revision: null }, '2026-10-01', 42), true)
assert.equal(refreshWasOvertaken(2, 2), false)
assert.equal(refreshWasOvertaken(2, 3), true)

console.log('Workspace cache decisions passed')
