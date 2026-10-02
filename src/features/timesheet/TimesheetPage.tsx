import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, BriefcaseBusiness, CalendarDays, Check, ChevronDown, CircleAlert, Clock3, Eye, EyeOff, GripVertical, LoaderCircle, MessageSquareText, Minus, Plus } from 'lucide-react'
import { loadRevenueRecognitionEntries, loadTimeComments, loadTimeEntries, saveTimeComment, saveTimeEntry } from './api'
import { formatMoney, fromMonthKey, getErrorMessage, monthName, parseMoneyToMinor } from '../../app-utils'
import { todayInParis } from '../../../shared/bank-data.ts'
import { calculateRevenueForecast, type RevenueForecast } from '../../revenue'
import { formatEarnedTimesheetPeriod } from './period'
import { buildClientHoursReport, canCopyClientHoursReport, copyClientHoursReport, reportHours } from '../../client-hours-report'
import type { FxRate, TimeCode, TimeComment, TimeEntry, TimesheetClient, TimesheetClientForecast, TimesheetClientRate } from '../../types'
export function TimesheetPage({ workspaceId, month, defaultCurrency, codes, clients, rates, forecasts, fxRates, onAddCode, onUpdateCode, onReorderCodes, onAddClient, onUpdateClient, onSaveRate, onSaveForecast }: {
  workspaceId: string
  month: string
  defaultCurrency: string
  codes: TimeCode[]
  clients: TimesheetClient[]
  rates: TimesheetClientRate[]
  forecasts: TimesheetClientForecast[]
  fxRates: FxRate[]
  onAddCode: (name: string, clientId: string) => Promise<void>
  onUpdateCode: (code: TimeCode) => Promise<void>
  onReorderCodes: (timeCodeIds: string[]) => Promise<void>
  onAddClient: (name: string, currency: string, hourlyRateMinor: number) => Promise<void>
  onUpdateClient: (client: TimesheetClient) => Promise<void>
  onSaveRate: (rate: TimesheetClientRate) => Promise<void>
  onSaveForecast: (forecast: TimesheetClientForecast) => Promise<void>
}) {
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [yearEntries, setYearEntries] = useState<TimeEntry[]>([])
  const [comments, setComments] = useState<TimeComment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadedMonthKey, setLoadedMonthKey] = useState('')
  const [selectedReportClientId, setSelectedReportClientId] = useState('')
  const [reportStatus, setReportStatus] = useState('')
  const [copyingReport, setCopyingReport] = useState(false)
  const [pendingSaves, setPendingSaves] = useState(0)
  const [newCodeName, setNewCodeName] = useState('')
  const [newCodeClientId, setNewCodeClientId] = useState('')
  const [addingCode, setAddingCode] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [orderedIds, setOrderedIds] = useState<string[]>([])
  const [draggedId, setDraggedId] = useState('')
  const [savingOrder, setSavingOrder] = useState(false)
  const saveQueue = useRef(new Map<string, Promise<void>>())
  const reportContextRef = useRef({ workspaceId, month, selectedReportClientId, codes })
  reportContextRef.current = { workspaceId, month, selectedReportClientId, codes }
  const tableWrapRef = useRef<HTMLDivElement>(null)
  const todayColumnRef = useRef<HTMLTableCellElement>(null)
  const monthDate = useMemo(() => fromMonthKey(month) ?? new Date(), [month])
  const selectedYear = monthDate.getFullYear()
  const dayCount = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate()
  const now = new Date()
  const todayDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const days = useMemo(() => Array.from({ length: dayCount }, (_, index) => {
    const day = index + 1
    const date = `${month}-${String(day).padStart(2, '0')}`
    const value = new Date(`${date}T12:00:00`)
    const week = isoWeekForDate(date)
    return { day, date, label: new Intl.DateTimeFormat('en', { weekday: 'short' }).format(value).slice(0, 2), weekend: value.getDay() === 0 || value.getDay() === 6, isToday: date === todayDate, ...week }
  }), [dayCount, month, todayDate])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setLoadedMonthKey('')
    setReportStatus('')
    Promise.all([loadTimeEntries(workspaceId, month), loadTimeComments(workspaceId, month), loadRevenueRecognitionEntries(workspaceId, selectedYear)])
      .then(([loadedEntries, loadedComments, loadedYearEntries]) => {
        if (cancelled) return
        setEntries(loadedEntries)
        setLoadedMonthKey(`${workspaceId}:${month}`)
        setComments(loadedComments)
        setYearEntries(loadedYearEntries)
      })
      .catch((cause) => { if (!cancelled) setError(getErrorMessage(cause, 'Could not load this timesheet.')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [month, selectedYear, workspaceId])

  const entryMap = useMemo(() => new Map(entries.map((entry) => [`${entry.codeId}:${entry.date}`, entry.hours])), [entries])
  const commentMap = useMemo(() => new Map(comments.map((comment) => [comment.codeId, comment.comment])), [comments])
  const visibleCodes = codes.filter((code) => !code.hiddenFromMonth || code.hiddenFromMonth > month).sort((a, b) => a.sortOrder - b.sortOrder)
  const hiddenCodes = codes.filter((code) => code.hiddenFromMonth && code.hiddenFromMonth <= month).sort((a, b) => a.sortOrder - b.sortOrder)
  const displayedCodes = reordering ? orderedIds.flatMap((id) => {
    const code = visibleCodes.find((item) => item.id === id)
    return code ? [code] : []
  }) : visibleCodes
  const groupedCodes = useMemo(() => {
    const orderedClients = [...clients].sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
    const groups = orderedClients.map((client) => ({ client, codes: displayedCodes.filter((code) => code.clientId === client.id) })).filter((group) => group.codes.length > 0)
    const unassigned = displayedCodes.filter((code) => !code.clientId || !clients.some((client) => client.id === code.clientId))
    return unassigned.length ? [...groups, { client: null, codes: unassigned }] : groups
  }, [clients, displayedCodes])
  const totalForCode = (codeId: string) => entries.filter((entry) => entry.codeId === codeId).reduce((sum, entry) => sum + entry.hours, 0)
  const totalForDate = (date: string) => entries.reduce((sum, entry) => sum + (entry.date === date ? entry.hours : 0), 0)
  const monthTotal = entries.reduce((sum, entry) => sum + entry.hours, 0)
  const selectedReportClient = clients.find((client) => client.id === selectedReportClientId)
  const reportReady = !loading && loadedMonthKey === `${workspaceId}:${month}` && !error && pendingSaves === 0
  const clientHoursReport = buildClientHoursReport(month, selectedReportClientId, codes, reportReady ? entries : [])
  const weeklyTotals = useMemo(() => {
    const totals = new Map<string, { weekNumber: number; weekYear: number; startDay: number; endDay: number; hours: number }>()
    for (const day of days) {
      const current = totals.get(day.weekKey) ?? { weekNumber: day.weekNumber, weekYear: day.weekYear, startDay: day.day, endDay: day.day, hours: 0 }
      current.endDay = day.day
      current.hours += entries.reduce((sum, entry) => sum + (entry.date === day.date ? entry.hours : 0), 0)
      totals.set(day.weekKey, current)
    }
    return [...totals.values()]
  }, [days, entries])
  const today = todayInParis()
  const revenueForecast = useMemo(() => calculateRevenueForecast({
    clients,
    rates,
    forecasts,
    timeCodes: codes,
    entries: yearEntries,
    fxRates,
    defaultCurrency,
    today,
    year: selectedYear,
  }), [clients, codes, defaultCurrency, forecasts, fxRates, rates, selectedYear, today, yearEntries])

  useEffect(() => {
    if (loading || !todayColumnRef.current || !tableWrapRef.current) return
    const wrap = tableWrapRef.current
    const todayColumn = todayColumnRef.current
    const stickyColumnWidth = 210
    const stickyTotalWidth = 80
    const visibleDayWidth = Math.max(0, wrap.clientWidth - stickyColumnWidth - stickyTotalWidth)
    const centeredScrollLeft = todayColumn.offsetLeft - stickyColumnWidth - ((visibleDayWidth - todayColumn.offsetWidth) / 2)
    wrap.scrollLeft = Math.max(0, Math.min(centeredScrollLeft, wrap.scrollWidth - wrap.clientWidth))
  }, [loading, month])

  function beginReordering() {
    setOrderedIds(visibleCodes.map((code) => code.id))
    setReordering(true)
  }

  function moveCode(codeId: string, offset: number) {
    setOrderedIds((current) => {
      const from = current.indexOf(codeId)
      const to = from + offset
      if (from < 0 || to < 0 || to >= current.length) return current
      const next = [...current]
      next.splice(from, 1)
      next.splice(to, 0, codeId)
      return next
    })
  }

  function dropCode(targetId: string) {
    if (!draggedId || draggedId === targetId) return
    setOrderedIds((current) => {
      const from = current.indexOf(draggedId)
      const to = current.indexOf(targetId)
      if (from < 0 || to < 0) return current
      const next = [...current]
      next.splice(from, 1)
      next.splice(to, 0, draggedId)
      return next
    })
    setDraggedId('')
  }

  async function saveOrder() {
    setSavingOrder(true)
    setError('')
    try {
      await onReorderCodes(orderedIds)
      setReordering(false)
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not save the time code order.'))
    } finally {
      setSavingOrder(false)
    }
  }

  function changeEntry(codeId: string, date: string, rawHours: number) {
    const hours = Math.min(24, Math.max(0, Math.round(rawHours)))
    const key = `${workspaceId}:${codeId}:${date}`
    setError('')
    setReportStatus('')
    setEntries((current) => hours === 0
      ? current.filter((entry) => entry.codeId !== codeId || entry.date !== date)
      : [...current.filter((entry) => entry.codeId !== codeId || entry.date !== date), { codeId, date, hours }])
    setYearEntries((current) => hours === 0
      ? current.filter((entry) => entry.codeId !== codeId || entry.date !== date)
      : [...current.filter((entry) => entry.codeId !== codeId || entry.date !== date), { codeId, date, hours }])
    const previous = saveQueue.current.get(key) ?? Promise.resolve()
    const request = previous.catch(() => undefined).then(() => saveTimeEntry(workspaceId, { codeId, date, hours }))
      .catch(async (cause) => {
        if (reportContextRef.current.workspaceId === workspaceId && reportContextRef.current.month === month) {
          setError(getErrorMessage(cause, 'Could not save these hours.'))
          try {
            const refreshed = await loadTimeEntries(workspaceId, month)
            if (reportContextRef.current.workspaceId === workspaceId && reportContextRef.current.month === month) setEntries(refreshed)
          } catch { /* Keep the original save error visible. */ }
        }
      })
      .finally(() => { if (saveQueue.current.get(key) === request) saveQueue.current.delete(key); setPendingSaves(saveQueue.current.size) })
    saveQueue.current.set(key, request)
    setPendingSaves(saveQueue.current.size)
  }

  async function copyReport() {
    const preview = { workspaceId, month, clientId: selectedReportClientId }
    const context = reportContextRef.current
    if (!selectedReportClient || copyingReport || !canCopyClientHoursReport(preview, { workspaceId: context.workspaceId, month: context.month, clientId: context.selectedReportClientId }, reportReady, saveQueue.current.size, clientHoursReport.rows.length) || context.codes !== codes) return
    setCopyingReport(true)
    setReportStatus('')
    try {
      const format = await copyClientHoursReport(clientHoursReport)
      if (reportContextRef.current.workspaceId === context.workspaceId && reportContextRef.current.month === context.month && reportContextRef.current.selectedReportClientId === context.selectedReportClientId) {
        setReportStatus(format === 'rich' ? 'Table copied with HTML and tab-delimited text. Paste into Outlook and review it.' : 'Plain tab-delimited text copied. Outlook may paste it as text; you can also paste it into Excel as two columns.')
      }
    } catch (cause) {
      if (reportContextRef.current.workspaceId === context.workspaceId && reportContextRef.current.month === context.month && reportContextRef.current.selectedReportClientId === context.selectedReportClientId) setReportStatus(`Could not copy the table: ${getErrorMessage(cause, 'Clipboard access failed.')} Select and copy the preview manually.`)
    } finally {
      setCopyingReport(false)
    }
  }

  async function addCode(event: FormEvent) {
    event.preventDefault()
    const name = newCodeName.trim()
    if (!name || !newCodeClientId) return
    setAddingCode(true)
    setError('')
    try {
      await onAddCode(name, newCodeClientId)
      setNewCodeName('')
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not add the time code.'))
    } finally {
      setAddingCode(false)
    }
  }

  async function updateCode(code: TimeCode) {
    setError('')
    try { await onUpdateCode(code) } catch (cause) {
      setError(getErrorMessage(cause, 'Could not update the time code.'))
      throw cause
    }
  }

  async function changeComment(codeId: string, comment: string) {
    const normalized = comment.normalize('NFKC').trim()
    setError('')
    try {
      await saveTimeComment(workspaceId, { codeId, month, comment: normalized })
      setComments((current) => normalized
        ? [...current.filter((item) => item.codeId !== codeId), { codeId, month, comment: normalized }]
        : current.filter((item) => item.codeId !== codeId))
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not save the monthly comment.'))
      throw cause
    }
  }

  return <div className="page-content timesheet-page">
    <ClientRevenuePanel year={selectedYear} defaultCurrency={defaultCurrency} clients={clients} rates={rates} forecasts={forecasts} revenue={revenueForecast} onAddClient={onAddClient} onUpdateClient={onUpdateClient} onSaveRate={onSaveRate} onSaveForecast={onSaveForecast} />

    <section className="timesheet-summary">
      <div><span className="eyebrow">Month total</span><strong>{formatHours(monthTotal)}</strong><small>across {visibleCodes.length} visible {visibleCodes.length === 1 ? 'item' : 'items'}</small></div>
      <div className="timesheet-item-totals">{groupedCodes.map((group) => <div key={group.client?.id ?? 'unassigned'}><span>{group.client?.name ?? 'Unassigned'}</span><strong>{formatHours(group.codes.reduce((sum, code) => sum + totalForCode(code.id), 0))}</strong></div>)}</div>
    </section>

    <section className="panel client-hours-report" aria-label="Client hours table for email">
      <div className="client-hours-report-heading"><div><span className="eyebrow">Share monthly hours</span><h2>Client hours table</h2><p>Review {monthName.format(monthDate)} hours, then copy the table into an Outlook email.</p></div><div className="client-hours-report-actions"><label htmlFor="report-client">Client</label><select id="report-client" value={selectedReportClientId} onChange={(event) => { setSelectedReportClientId(event.target.value); setReportStatus('') }}><option value="">Select client…</option>{[...clients].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).map((client) => <option key={client.id} value={client.id}>{client.name}{client.active ? '' : ' (inactive)'}</option>)}</select><button type="button" className="primary-button" disabled={!selectedReportClient || !reportReady || !clientHoursReport.rows.length || copyingReport} onClick={() => void copyReport()}>{copyingReport ? 'Copying…' : 'Copy table'}</button></div></div>
      {!selectedReportClient ? <p className="client-hours-report-empty">Select one client to preview their hours.</p> : !reportReady ? <p className="client-hours-report-empty">{pendingSaves ? 'Saving hours… Copy is available once the save finishes.' : loading || loadedMonthKey !== `${workspaceId}:${month}` && !error ? 'Loading the selected month…' : 'Hours are unavailable. Resolve the timesheet error before copying.'}</p> : clientHoursReport.rows.length === 0 ? <p className="client-hours-report-empty">No hours recorded for {selectedReportClient.name} in {monthName.format(monthDate)}.</p> : <table className="client-hours-preview"><thead><tr><th>Code</th><th>Hours</th></tr></thead><tbody>{clientHoursReport.rows.map((row, index) => <tr key={index}><td>{row.code}</td><td>{reportHours(row.hours)}</td></tr>)}</tbody><tfoot><tr><th>Total</th><th>{reportHours(clientHoursReport.total)}</th></tr></tfoot></table>}
      {reportStatus && <p className="client-hours-report-status" role="status">{reportStatus}</p>}
      <p className="client-hours-report-steps">In Outlook: create an email, paste the table, review the recipient and hours, then send it yourself.</p>
    </section>

    <section className="timesheet-weekly-summary" aria-label="Weekly hour totals">
      <div className="timesheet-weekly-heading"><CalendarDays size={17} /><div><span className="eyebrow">Weekly totals</span><small>Monday–Sunday · selected month only</small></div></div>
      <div className="timesheet-weekly-totals">{weeklyTotals.map((week) => <div key={`${week.weekYear}-${week.weekNumber}`}><span>Week {week.weekNumber}</span><small>{week.startDay === week.endDay ? week.startDay : `${week.startDay}–${week.endDay}`} {new Intl.DateTimeFormat('en', { month: 'short' }).format(monthDate)}</small><strong>{formatHours(week.hours)}</strong></div>)}</div>
    </section>

    <section className="panel timesheet-panel">
      <div className="timesheet-heading">
        <div><span className="eyebrow">Daily hours</span><h2>{monthName.format(monthDate)}</h2><p>Enter whole hours directly, or use − and + to adjust one hour at a time. Weekends are shaded.</p></div>
        <div className="timesheet-heading-actions">
          <form className="time-code-add" onSubmit={(event) => void addCode(event)}><select required aria-label="Client for new time code" value={newCodeClientId} onChange={(event) => setNewCodeClientId(event.target.value)}><option value="" disabled>Select client…</option>{clients.filter((client) => client.active).map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select><input required aria-label="New time code name" value={newCodeName} onChange={(event) => setNewCodeName(event.target.value)} placeholder="Add a code…" /><button className="primary-button" disabled={addingCode || !newCodeName.trim() || !newCodeClientId}><Plus size={16} />{addingCode ? 'Adding…' : 'Add code'}</button></form>
          {!reordering && visibleCodes.length > 1 && <button type="button" className="secondary-button timesheet-reorder-button" onClick={beginReordering}><GripVertical size={16} />Reorder</button>}
        </div>
      </div>

      {reordering && <div className="time-code-reorder-panel">
        <div className="time-code-reorder-heading"><p><GripVertical size={15} />Drag items into place, or use the arrow buttons.</p><div><button type="button" className="secondary-button" disabled={savingOrder} onClick={() => { setReordering(false); setDraggedId('') }}>Cancel</button><button type="button" className="primary-button" disabled={savingOrder} onClick={() => void saveOrder()}><Check size={16} />{savingOrder ? 'Saving…' : 'Save order'}</button></div></div>
        <div className="time-code-reorder-list">{displayedCodes.map((code, index) => <div key={code.id} className={draggedId === code.id ? 'dragging' : ''} draggable onDragStart={() => setDraggedId(code.id)} onDragEnd={() => setDraggedId('')} onDragOver={(event) => event.preventDefault()} onDrop={() => dropCode(code.id)}><GripVertical size={17} aria-hidden="true" /><strong>{code.name}</strong><button type="button" className="icon-button" disabled={index === 0 || savingOrder} onClick={() => moveCode(code.id, -1)} aria-label={`Move ${code.name} earlier`}><ArrowUp size={14} /></button><button type="button" className="icon-button" disabled={index === displayedCodes.length - 1 || savingOrder} onClick={() => moveCode(code.id, 1)} aria-label={`Move ${code.name} later`}><ArrowDown size={14} /></button></div>)}</div>
      </div>}

      {loading ? <div className="timesheet-loading"><LoaderCircle size={18} />Loading hours…</div> : visibleCodes.length === 0 ? <div className="timesheet-empty"><Clock3 size={25} /><strong>No visible time codes</strong><span>Add your first code above to start reporting hours.</span></div> : <div className="timesheet-table-wrap" ref={tableWrapRef}>
        <table className="timesheet-table">
          <thead><tr><th className="time-code-column">Item</th>{days.map((day) => <th key={day.date} ref={day.isToday ? todayColumnRef : undefined} className={`${day.weekend ? 'weekend ' : ''}${day.isToday ? 'today' : ''}`} aria-current={day.isToday ? 'date' : undefined}><span>{day.isToday ? 'Today' : day.label}</span><b>{day.day}</b></th>)}<th className="time-total-column">Total</th></tr></thead>
          <tbody>
            {groupedCodes.map((group) => <Fragment key={group.client?.id ?? 'unassigned'}><tr className="time-client-row"><th>{group.client?.name ?? 'No client'}</th><td colSpan={days.length + 1}>{group.client ? `${group.client.currency} billing` : 'Non-billable or not assigned'}</td></tr>{group.codes.map((code) => <tr key={code.id}><th><TimeCodeEditor code={code} month={month} onSave={updateCode} /></th>{days.map((day) => <td key={day.date} className={`${day.weekend ? 'weekend ' : ''}${day.isToday ? 'today' : ''}`}><TimeEntryCell codeName={code.name} date={day.date} value={entryMap.get(`${code.id}:${day.date}`) ?? 0} disabled={copyingReport} onChange={(hours) => changeEntry(code.id, day.date, hours)} /></td>)}<td className="time-row-total">{formatHours(totalForCode(code.id))}</td></tr>)}</Fragment>)}
          </tbody>
          <tfoot><tr><th>Daily total</th>{days.map((day) => <td key={day.date} className={`${day.weekend ? 'weekend ' : ''}${day.isToday ? 'today' : ''}`}>{formatHours(totalForDate(day.date), true)}</td>)}<td>{formatHours(monthTotal)}</td></tr></tfoot>
        </table>
      </div>}

      {!loading && displayedCodes.length > 0 && <section className="time-comments">
        <div className="time-comments-heading"><MessageSquareText size={18} /><div><span className="eyebrow">Monthly comments</span><h3>What did you work on?</h3><p>These notes belong only to this item in {monthName.format(monthDate)}.</p></div></div>
        <div className="time-comment-list">{displayedCodes.map((code) => <TimeCommentField key={code.id} code={code} value={commentMap.get(code.id) ?? ''} onSave={(comment) => changeComment(code.id, comment)} />)}</div>
      </section>}

      {hiddenCodes.length > 0 && <div className="hidden-time-codes"><button type="button" onClick={() => setShowHidden((current) => !current)}><EyeOff size={15} />{hiddenCodes.length} hidden {hiddenCodes.length === 1 ? 'code' : 'codes'}<ChevronDown className={showHidden ? 'expanded' : ''} size={15} /></button>{showHidden && <div>{hiddenCodes.map((code) => <TimeCodeEditor key={code.id} code={code} month={month} hidden onSave={updateCode} />)}</div>}</div>}
      {error && <p className="timesheet-error" role="alert">{error}</p>}
    </section>
  </div>
}

function ClientRevenuePanel({ year, defaultCurrency, clients, rates, forecasts, revenue, onAddClient, onUpdateClient, onSaveRate, onSaveForecast }: {
  year: number
  defaultCurrency: string
  clients: TimesheetClient[]
  rates: TimesheetClientRate[]
  forecasts: TimesheetClientForecast[]
  revenue: RevenueForecast
  onAddClient: (name: string, currency: string, hourlyRateMinor: number) => Promise<void>
  onUpdateClient: (client: TimesheetClient) => Promise<void>
  onSaveRate: (rate: TimesheetClientRate) => Promise<void>
  onSaveForecast: (forecast: TimesheetClientForecast) => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [showAddClient, setShowAddClient] = useState(false)
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState(defaultCurrency)
  const [rate, setRate] = useState('')
  const [error, setError] = useState('')
  const earnedPeriod = formatEarnedTimesheetPeriod(todayInParis(), year)

  async function addClient(event: FormEvent) {
    event.preventDefault()
    const rateMinor = parseMoneyToMinor(rate)
    if (!name.trim() || !/^[A-Za-z]{3}$/.test(currency) || rateMinor === null) {
      setError('Enter a client name, three-letter currency, and valid hourly rate.')
      return
    }
    setAdding(true)
    setError('')
    try {
      await onAddClient(name.trim(), currency.toUpperCase(), rateMinor)
      setName('')
      setRate('')
      setShowAddClient(false)
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not add the client.'))
    } finally {
      setAdding(false)
    }
  }

  return <section className="panel client-revenue-panel">
    <div className="client-revenue-heading"><div><span className="eyebrow">Earned revenue · {year}</span><h2>Client revenue forecast</h2><p>Timesheet hours through today are earned. The forecast starts tomorrow and uses hours per weekday after remaining vacation days.</p></div><div className="client-revenue-total"><span>Full-year forecast</span><strong>{formatMoney(revenue.fullYearRevenueMinor, defaultCurrency)}</strong><small>{formatMoney(revenue.actualRevenueMinor, defaultCurrency)} earned · {formatMoney(revenue.remainingRevenueMinor, defaultCurrency)} remaining</small></div></div>
    {(revenue.missingFx || revenue.missingRate) && <p className="client-revenue-warning"><CircleAlert size={15} />{revenue.missingRate ? 'A billable period is missing a client rate. ' : ''}{revenue.missingFx ? `Add the required exchange rate in Settings to complete the ${defaultCurrency} forecast.` : ''}</p>}
    <div className="client-revenue-list">{clients.filter((client) => client.active).sort((left, right) => left.sortOrder - right.sortOrder).map((client) => <ClientRevenueCard key={client.id} year={year} defaultCurrency={defaultCurrency} client={client} rates={rates.filter((item) => item.clientId === client.id)} forecast={forecasts.find((item) => item.clientId === client.id && item.year === year)} revenue={revenue.clients.find((item) => item.client.id === client.id)} earnedPeriod={earnedPeriod} onUpdateClient={onUpdateClient} onSaveRate={onSaveRate} onSaveForecast={onSaveForecast} />)}</div>
    {clients.some((client) => !client.active) && <div className="inactive-client-list"><span>Inactive clients</span>{clients.filter((client) => !client.active).map((client) => <button type="button" key={client.id} onClick={() => void onUpdateClient({ ...client, active: true })}><Eye size={13} />{client.name}<b>{formatMoney(revenue.clients.find((item) => item.client.id === client.id)?.actualRevenueMinor ?? 0, defaultCurrency)} earned</b></button>)}</div>}
    {!clients.some((client) => client.active) && <div className="client-revenue-empty"><BriefcaseBusiness size={21} /><strong>Add the first client</strong><span>Client rates turn recorded hours into earned revenue.</span></div>}
    {!showAddClient && <button type="button" className="secondary-button client-add-toggle" aria-expanded="false" onClick={() => { setShowAddClient(true); setError('') }}><Plus size={13} />New client</button>}
    {showAddClient && <form className="client-add-form" onSubmit={(event) => void addClient(event)}><label><span>Client</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Client name" /></label><label><span>Currency</span><input value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} /></label><label><span>Hourly rate</span><input type="number" min="0" step="0.01" value={rate} onChange={(event) => setRate(event.target.value)} placeholder="0.00" /></label><div className="client-add-actions"><button type="button" className="secondary-button" disabled={adding} onClick={() => { setShowAddClient(false); setError('') }}>Cancel</button><button type="submit" className="primary-button" disabled={adding}><Plus size={15} />{adding ? 'Adding…' : 'Add client'}</button></div></form>}
    {error && <p className="timesheet-error" role="alert">{error}</p>}
  </section>
}

function ClientRevenueCard({ year, defaultCurrency, client, rates, forecast, revenue, earnedPeriod, onUpdateClient, onSaveRate, onSaveForecast }: {
  year: number
  defaultCurrency: string
  client: TimesheetClient
  rates: TimesheetClientRate[]
  forecast?: TimesheetClientForecast
  revenue?: RevenueForecast['clients'][number]
  earnedPeriod: string
  onUpdateClient: (client: TimesheetClient) => Promise<void>
  onSaveRate: (rate: TimesheetClientRate) => Promise<void>
  onSaveForecast: (forecast: TimesheetClientForecast) => Promise<void>
}) {
  const currentRate = rates.filter((item) => item.effectiveFrom <= todayInParis()).sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0]
  const [rateInput, setRateInput] = useState(currentRate ? (currentRate.hourlyRateMinor / 100).toFixed(2) : '')
  const [hoursPerDay, setHoursPerDay] = useState(String(forecast?.hoursPerDay ?? 0))
  const [vacationDaysRemaining, setVacationDaysRemaining] = useState(String(forecast?.vacationDaysRemaining ?? 0))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => setRateInput(currentRate ? (currentRate.hourlyRateMinor / 100).toFixed(2) : ''), [currentRate])
  useEffect(() => { setHoursPerDay(String(forecast?.hoursPerDay ?? 0)); setVacationDaysRemaining(String(forecast?.vacationDaysRemaining ?? 0)) }, [forecast?.hoursPerDay, forecast?.vacationDaysRemaining])

  async function save() {
    const rateMinor = parseMoneyToMinor(rateInput)
    const hours = Number(hoursPerDay)
    const vacation = Number(vacationDaysRemaining)
    if (rateMinor === null || !Number.isFinite(hours) || hours < 0 || hours > 24 || !Number.isFinite(vacation) || vacation < 0 || vacation > 366) {
      setError('Check the hourly rate, forecast hours per day, and vacation days remaining.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const effectiveFrom = currentRate?.hourlyRateMinor === rateMinor ? currentRate.effectiveFrom : todayInParis()
      await Promise.all([
        onSaveRate({ clientId: client.id, effectiveFrom, hourlyRateMinor: rateMinor }),
        onSaveForecast({ clientId: client.id, year, hoursPerDay: hours, vacationDaysRemaining: vacation }),
      ])
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not save the client forecast.'))
    } finally {
      setSaving(false)
    }
  }

  return <article className="client-revenue-card">
    <div className="client-revenue-card-heading"><div><strong>{client.name}</strong><span>{client.currency} · {currentRate ? `${formatMoney(currentRate.hourlyRateMinor, client.currency)}/hour` : 'Rate missing'}</span></div><button type="button" title="Deactivate client" aria-label={`Deactivate ${client.name}`} disabled={saving} onClick={() => void onUpdateClient({ ...client, active: false })}><EyeOff size={14} /></button></div>
    <div className="client-revenue-metrics"><div><span>Earned YTD</span><strong>{formatMoney(revenue?.actualRevenueMinor ?? 0, defaultCurrency)}</strong><small>{formatHours(revenue?.actualHours ?? 0)} · {earnedPeriod}</small></div><div><span>Remaining</span><strong>{formatMoney(revenue?.remainingRevenueMinor ?? 0, defaultCurrency)}</strong><small>{(revenue?.workDaysRemaining ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} work days forecast</small></div><div><span>Full year</span><strong>{formatMoney(revenue?.fullYearRevenueMinor ?? 0, defaultCurrency)}</strong><small>{formatHours((revenue?.actualHours ?? 0) + (revenue?.forecastHours ?? 0))}</small></div></div>
    <div className="client-revenue-inputs"><label><span>Rate</span><div><b>{client.currency}</b><input type="number" min="0" step="0.01" value={rateInput} onChange={(event) => setRateInput(event.target.value)} /></div></label><label><span>Forecast hours / day</span><input type="number" min="0" max="24" step="0.5" value={hoursPerDay} onChange={(event) => setHoursPerDay(event.target.value)} /></label><label><span>Vacation days remaining</span><input type="number" min="0" max="366" step="0.5" value={vacationDaysRemaining} onChange={(event) => setVacationDaysRemaining(event.target.value)} /></label><button type="button" className="secondary-button" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button></div>
    {error && <p className="client-card-error" role="alert">{error}</p>}
  </article>
}

function formatHours(hours: number, compact = false) {
  if (compact && hours === 0) return '—'
  return `${hours.toLocaleString(undefined, { maximumFractionDigits: 2 })}h`
}

function isoWeekForDate(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day))
  const weekday = value.getUTCDay() || 7
  value.setUTCDate(value.getUTCDate() + 4 - weekday)
  const weekYear = value.getUTCFullYear()
  const yearStart = new Date(Date.UTC(weekYear, 0, 1))
  const weekNumber = Math.ceil((((value.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
  return { weekKey: `${weekYear}-W${String(weekNumber).padStart(2, '0')}`, weekNumber, weekYear }
}

function TimeEntryCell({ codeName, date, value, disabled = false, onChange }: { codeName: string; date: string; value: number; disabled?: boolean; onChange: (hours: number) => void }) {
  const [draft, setDraft] = useState(value === 0 ? '' : String(value))
  useEffect(() => setDraft(value === 0 ? '' : String(value)), [value])
  const commit = () => {
    if (disabled) return
    const parsed = Number(draft.replace(',', '.'))
    if (draft.trim() === '' || !Number.isFinite(parsed)) { setDraft(value === 0 ? '' : String(value)); return }
    onChange(parsed)
  }
  return <div className="time-entry-cell">
    <button type="button" aria-label={`Subtract one hour from ${codeName} on ${date}`} disabled={disabled || value === 0} onClick={() => onChange(value - 1)}><Minus size={11} /></button>
    <input aria-label={`${codeName} hours on ${date}`} inputMode="numeric" min="0" max="24" step="1" value={draft} placeholder="0" disabled={disabled} onChange={(event) => setDraft(event.target.value.replace(/\D/g, ''))} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
    <button type="button" aria-label={`Add one hour to ${codeName} on ${date}`} disabled={disabled || value >= 24} onClick={() => onChange(value + 1)}><Plus size={11} /></button>
  </div>
}

function TimeCodeEditor({ code, month, hidden = false, onSave }: { code: TimeCode; month: string; hidden?: boolean; onSave: (code: TimeCode) => Promise<void> }) {
  const [name, setName] = useState(code.name)
  const [saving, setSaving] = useState(false)
  useEffect(() => setName(code.name), [code.name])
  const saveName = async () => {
    const normalized = name.trim()
    if (!normalized || normalized === code.name) { setName(code.name); return }
    setSaving(true)
    try { await onSave({ ...code, name: normalized }) } catch { setName(code.name) } finally { setSaving(false) }
  }
  const setHidden = async () => {
    setSaving(true)
    try { await onSave({ ...code, hiddenFromMonth: hidden ? undefined : month }) } finally { setSaving(false) }
  }
  return <div className={`time-code-editor${hidden ? ' hidden' : ''}`}>
    <input aria-label={`Rename ${code.name}`} value={name} disabled={saving} onChange={(event) => setName(event.target.value)} onBlur={() => void saveName()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
    <button type="button" disabled={saving} onClick={() => void setHidden()} title={hidden ? 'Show this code again' : `Hide from ${month} onward`}>{hidden ? <Eye size={14} /> : <EyeOff size={14} />}<span>{hidden ? 'Restore' : 'Hide'}</span></button>
  </div>
}

function TimeCommentField({ code, value, onSave }: { code: TimeCode; value: string; onSave: (comment: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value)
  const [status, setStatus] = useState<'saving' | 'saved' | ''>('')
  useEffect(() => setDraft(value), [value])

  async function commit() {
    const normalized = draft.normalize('NFKC').trim()
    if (normalized === value) return
    setStatus('saving')
    try {
      await onSave(normalized)
      setDraft(normalized)
      setStatus('saved')
      window.setTimeout(() => setStatus(''), 1400)
    } catch {
      setStatus('')
    }
  }

  return <label className="time-comment-field"><span><strong>{code.name}</strong><small>{status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : `${draft.length}/5000`}</small></span><textarea maxLength={5000} value={draft} onChange={(event) => { setDraft(event.target.value); setStatus('') }} onBlur={() => void commit()} placeholder="DevOps codes, tickets, or a short summary…" /></label>
}
