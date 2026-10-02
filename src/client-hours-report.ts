import type { TimeCode, TimeEntry } from './types.ts'

export type ClientHoursRow = { code: string; hours: number }
export type ClientHoursReport = { rows: ClientHoursRow[]; total: number }
export type ClientHoursContext = { workspaceId: string; month: string; clientId: string }

export function canCopyClientHoursReport(preview: ClientHoursContext, current: ClientHoursContext, ready: boolean, pendingWrites: number, rowCount: number): boolean {
  return ready && pendingWrites === 0 && rowCount > 0 && !!preview.clientId &&
    preview.workspaceId === current.workspaceId && preview.month === current.month && preview.clientId === current.clientId
}

export function buildClientHoursReport(month: string, clientId: string, codes: TimeCode[], entries: TimeEntry[]): ClientHoursReport {
  const totals = new Map<string, number>()
  for (const entry of entries) {
    if (entry.date.slice(0, 7) !== month) continue
    totals.set(entry.codeId, (totals.get(entry.codeId) ?? 0) + entry.hours)
  }
  const rows = codes
    .filter((code) => code.clientId === clientId && (totals.get(code.id) ?? 0) > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((code) => ({ code: code.name, hours: totals.get(code.id)! }))
  return { rows, total: rows.reduce((sum, row) => sum + row.hours, 0) }
}

export function reportHours(hours: number): string {
  return Number(hours.toFixed(2)).toString()
}

function spreadsheetName(name: string): string {
  const clean = Array.from(name, (char) => char.charCodeAt(0) < 32 ? ' ' : char).join('').replace(/\s+/g, ' ').trim()
  return /^[=+\-@]/.test(clean) ? `'${clean}` : clean
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

export function reportClipboardFormats(report: ClientHoursReport): { html: string; tsv: string } {
  const rows = report.rows.map((row) => [row.code, reportHours(row.hours)] as const)
  const tsvRows = rows.map(([code, hours]) => [spreadsheetName(code), hours])
  const tsv = [['Code', 'Hours'], ...tsvRows, ['Total', reportHours(report.total)]].map((row) => row.join('\t')).join('\n')
  const cell = 'border:1px solid #cbd5cf;padding:6px 10px;font-family:Arial,sans-serif;font-size:12px;'
  const htmlRows = rows.map(([code, hours]) => `<tr><td style="${cell}">${escapeHtml(code)}</td><td style="${cell}text-align:right;">${hours}</td></tr>`).join('')
  const html = `<table style="border-collapse:collapse;"><thead><tr><th style="${cell}text-align:left;">Code</th><th style="${cell}text-align:right;">Hours</th></tr></thead><tbody>${htmlRows}<tr><th style="${cell}text-align:left;">Total</th><th style="${cell}text-align:right;">${reportHours(report.total)}</th></tr></tbody></table>`
  return { html, tsv }
}

export async function copyClientHoursReport(report: ClientHoursReport): Promise<'rich' | 'plain'> {
  const { html, tsv } = reportClipboardFormats(report)
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([tsv], { type: 'text/plain' }) })])
      return 'rich'
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'NotSupportedError')) throw cause
    }
  }
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable. Select and copy the preview table manually.')
  await navigator.clipboard.writeText(tsv)
  return 'plain'
}
