import assert from 'node:assert/strict'
import { buildClientHoursReport, canCopyClientHoursReport, copyClientHoursReport, reportClipboardFormats, reportHours } from '../src/client-hours-report.ts'

const codes = [
  { id: 'a', clientId: 'one', name: 'Design & <review>', sortOrder: 2 },
  { id: 'hidden', clientId: 'one', name: '=Hidden\twork', sortOrder: 1, hiddenFromMonth: '2026-01' },
  { id: 'zero', clientId: 'one', name: 'No hours', sortOrder: 3 },
  { id: 'other', clientId: 'two', name: 'Other client', sortOrder: 0 },
  { id: 'unassigned', name: 'Unassigned', sortOrder: 0 },
]
const entries = [
  { codeId: 'a', date: '2026-10-01', hours: 1.25 },
  { codeId: 'a', date: '2026-10-02', hours: 2 },
  { codeId: 'a', date: '2026-09-30', hours: 99 },
  { codeId: 'hidden', date: '2026-10-04', hours: 3.5 },
  { codeId: 'zero', date: '2026-10-05', hours: 0 },
  { codeId: 'other', date: '2026-10-05', hours: 20 },
  { codeId: 'unassigned', date: '2026-10-05', hours: 10 },
]
const report = buildClientHoursReport('2026-10', 'one', codes, entries)
assert.deepEqual(report, { rows: [{ code: '=Hidden\twork', hours: 3.5 }, { code: 'Design & <review>', hours: 3.25 }], total: 6.75 })
assert.deepEqual(buildClientHoursReport('2026-11', 'one', codes, entries), { rows: [], total: 0 })
assert.deepEqual(buildClientHoursReport('2026-10', 'two', codes, entries), { rows: [{ code: 'Other client', hours: 20 }], total: 20 })
assert.equal(reportHours(1234.5), '1234.5')

const { html, tsv } = reportClipboardFormats(report)
assert.equal(tsv, "Code\tHours\n'=Hidden work\t3.5\nDesign & <review>\t3.25\nTotal\t6.75")
assert.match(html, /Design &amp; &lt;review&gt;/)
assert.match(html, /<td[^>]*>=Hidden\twork<\/td>/)
assert.doesNotMatch(html, /Other client|<review>/)
assert.match(html, /<table style="border-collapse:collapse;">/)
for (const prefix of ['=', '+', '-', '@']) {
  const unsafe = buildClientHoursReport('2026-10', 'one', [{ id: 'x', clientId: 'one', name: `\n${prefix}SUM(1)`, sortOrder: 0 }], [{ codeId: 'x', date: '2026-10-01', hours: 1 }])
  assert.equal(reportClipboardFormats(unsafe).tsv, `Code\tHours\n'${prefix}SUM(1)\t1\nTotal\t1`)
}

const empty = reportClipboardFormats(buildClientHoursReport('2026-11', 'one', codes, entries))
assert.equal(empty.tsv, 'Code\tHours\nTotal\t0')

const preview = { workspaceId: 'workspace', month: '2026-10', clientId: 'one' }
assert.equal(canCopyClientHoursReport(preview, preview, true, 0, report.rows.length), true)
assert.equal(canCopyClientHoursReport(preview, { ...preview, month: '2026-11' }, true, 0, report.rows.length), false)
assert.equal(canCopyClientHoursReport(preview, { ...preview, clientId: 'two' }, true, 0, report.rows.length), false)
assert.equal(canCopyClientHoursReport(preview, preview, true, 1, report.rows.length), false)
assert.equal(canCopyClientHoursReport(preview, preview, false, 0, report.rows.length), false)

const copied = []
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: {
  write: async (items) => copied.push(items),
  writeText: async (value) => copied.push(value),
} } })
globalThis.ClipboardItem = class { constructor(parts) { this.parts = parts } }
const richCopy = copyClientHoursReport(report)
assert.equal(copied.length, 1, 'clipboard write starts synchronously in the click path')
assert.equal(await richCopy, 'rich')
assert.equal(await copied[0][0].parts['text/plain'].text(), tsv)
assert.equal(await copied[0][0].parts['text/html'].text(), html)
delete globalThis.ClipboardItem
assert.equal(await copyClientHoursReport(report), 'plain')
assert.equal(copied[1], tsv)
globalThis.ClipboardItem = class { constructor() { throw new DOMException('unsupported', 'NotSupportedError') } }
assert.equal(await copyClientHoursReport(report), 'plain')
assert.equal(copied[2], tsv)
globalThis.ClipboardItem = class { constructor(parts) { this.parts = parts } }
navigator.clipboard.write = async () => { throw new DOMException('denied', 'NotAllowedError') }
await assert.rejects(copyClientHoursReport(report), { name: 'NotAllowedError' })
assert.equal(copied.length, 3)

console.log('Client hours report passed')
