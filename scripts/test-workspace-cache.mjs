import assert from 'node:assert/strict'
import { refreshWasOvertaken, shouldReloadWorkspace, validWorkspaceCache, workspaceCacheVersion } from '../src/workspace-cache.ts'

const workspace = { workspaceId: 'workspace', loadedMonthKey: '2026-09', data: { accounts: [] } }
const cache = { version: workspaceCacheVersion, userId: 'alice', workspaceId: 'workspace', parisDate: '2026-10-01', revision: 42, workspace }

assert.equal(validWorkspaceCache(cache, 'alice'), true)
assert.equal(validWorkspaceCache(cache, 'bob'), false)
assert.equal(validWorkspaceCache({ ...cache, version: workspaceCacheVersion - 1 }, 'alice'), false)
assert.equal(validWorkspaceCache({ ...cache, workspaceId: 'other' }, 'alice'), false)
assert.equal(shouldReloadWorkspace(cache, '2026-10-01', 42), false)
assert.equal(shouldReloadWorkspace(cache, '2026-10-02', 42), true)
assert.equal(shouldReloadWorkspace(cache, '2026-10-01', 43), true)
assert.equal(shouldReloadWorkspace(cache, '2026-10-01', null), true)
assert.equal(shouldReloadWorkspace({ ...cache, revision: null }, '2026-10-01', 42), true)
assert.equal(refreshWasOvertaken(2, 2), false)
assert.equal(refreshWasOvertaken(2, 3), true)

console.log('Workspace cache decisions passed')
