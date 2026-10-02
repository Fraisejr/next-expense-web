import { useEffect, useState, type FormEvent } from 'react'
import { ArrowLeftRight, Download, FileCheck2, LoaderCircle, Plus, Trash2, Upload } from 'lucide-react'
import { exportWorkspaceBackup, isWorkspaceBackup, restoreWorkspaceBackup, type WorkspaceBackup } from '../../database'
import { getErrorMessage, toMonthKey, uid } from '../../app-utils'
import type { Account, FxRate } from '../../types'

function backupFilename(backup: WorkspaceBackup, prefix = 'next-expense-backup') {
  const createdAt = new Date(backup.createdAt)
  const timestamp = Number.isNaN(createdAt.getTime())
    ? new Date().toISOString()
    : createdAt.toISOString()
  return `${prefix}-${timestamp.slice(0, 16).replace('T', '-').replace(':', '')}.json`
}

function downloadWorkspaceBackup(backup: WorkspaceBackup, prefix?: string) {
  const file = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = backupFilename(backup, prefix)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function SettingsPage({ workspaceId, workspaceName, defaultCurrency, accounts, fxRates, onSaveFxRate, onDeleteFxRate }: {
  workspaceId: string
  workspaceName: string
  defaultCurrency: string
  accounts: Account[]
  fxRates: FxRate[]
  onSaveFxRate: (rate: FxRate) => Promise<void>
  onDeleteFxRate: (rateId: string) => Promise<void>
}) {
  const [exporting, setExporting] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [backup, setBackup] = useState<WorkspaceBackup | null>(null)
  const [backupFileName, setBackupFileName] = useState('')
  const [backupFileSize, setBackupFileSize] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [rateMonth, setRateMonth] = useState(toMonthKey(new Date()))
  const availableCurrencies = [...new Set([
    ...accounts.map((account) => account.currency),
    ...fxRates.flatMap((rate) => [rate.baseCurrency, rate.quoteCurrency]),
  ])].filter((currency) => currency !== defaultCurrency).sort()
  const [rateCurrency, setRateCurrency] = useState(availableCurrencies[0] ?? 'USD')
  const [rateValue, setRateValue] = useState('')
  const [savingRateId, setSavingRateId] = useState('')
  const [confirmingDeleteRateId, setConfirmingDeleteRateId] = useState('')

  async function saveRate(rate: FxRate) {
    setSavingRateId(rate.id)
    setError('')
    setNotice('')
    try {
      await onSaveFxRate(rate)
      setNotice('Exchange rate saved. Combined balances and reports have been updated.')
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not save the exchange rate.'))
      throw cause
    } finally {
      setSavingRateId('')
    }
  }

  async function addRate(event: FormEvent) {
    event.preventDefault()
    const parsed = Number(rateValue.trim().replace(',', '.'))
    const rateHundredths = Math.round(parsed * 100)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(rateMonth) || !Number.isFinite(parsed) || rateHundredths <= 0) {
      setError('Choose a month and enter a positive exchange rate.')
      return
    }
    try {
      await saveRate({ id: uid(), baseCurrency: defaultCurrency, quoteCurrency: rateCurrency, rateHundredths, date: `${rateMonth}-01` })
      setRateValue('')
    } catch {
      // saveRate has already exposed the database error.
    }
  }

  async function removeRate(rateId: string) {
    setSavingRateId(rateId)
    setError('')
    setNotice('')
    try {
      await onDeleteFxRate(rateId)
      setConfirmingDeleteRateId('')
      setNotice('Exchange rate deleted.')
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not delete the exchange rate.'))
    } finally {
      setSavingRateId('')
    }
  }

  async function exportBackup() {
    setExporting(true)
    setError('')
    setNotice('')
    try {
      const exported = await exportWorkspaceBackup(workspaceId)
      downloadWorkspaceBackup(exported)
      setNotice('Backup downloaded. Keep it somewhere you can find again.')
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not create the backup.'))
    } finally {
      setExporting(false)
    }
  }

  async function chooseBackup(file?: File) {
    setBackup(null)
    setBackupFileName('')
    setBackupFileSize(0)
    setConfirmed(false)
    setNotice('')
    setError('')
    if (!file) return
    if (file.size > 100 * 1024 * 1024) {
      setError('This backup is larger than 100 MB and cannot be restored here.')
      return
    }
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!isWorkspaceBackup(parsed)) throw new Error('This is not a complete Next Expense backup.')
      setBackup(parsed)
      setBackupFileName(file.name)
      setBackupFileSize(file.size)
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not read this backup file.'))
    }
  }

  async function restoreBackup() {
    if (!backup || !confirmed) return
    setRestoring(true)
    setError('')
    setNotice('')
    try {
      const safetyBackup = await exportWorkspaceBackup(workspaceId)
      downloadWorkspaceBackup(safetyBackup, 'next-expense-before-restore')
      await restoreWorkspaceBackup(workspaceId, backup)
      window.location.reload()
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not restore the backup. Your existing workspace was left unchanged.'))
      setRestoring(false)
    }
  }

  const keyCounts = backup ? [
    ['Accounts', backup.tables.accounts.length],
    ['Transactions', backup.tables.transactions.length],
    ['Categories', backup.tables.categories.length],
    ['Budgets', backup.tables.budgets.length],
    ['Payees', backup.tables.payees.length],
  ] as const : []
  const createdAt = backup ? new Date(backup.createdAt) : null

  return <div className="page-content narrow-page settings-page">
    <section className="panel settings-intro">
      <span className="eyebrow">Your data</span>
      <h2>Backup and restore</h2>
      <p>Save a complete copy of {workspaceName} to this computer. The file contains your financial data, so keep it somewhere private.</p>
    </section>

    <section className="panel fx-settings">
      <div className="fx-settings-heading">
        <div className="settings-card-icon"><ArrowLeftRight size={21} /></div>
        <div><span className="eyebrow">Reporting currency · {defaultCurrency}</span><h2>Exchange rates</h2><p>A saved rate remains in effect until a newer one is entered. Rates use the format “1 {defaultCurrency} equals foreign currency”.</p></div>
      </div>

      <form className="fx-rate-add" onSubmit={(event) => void addRate(event)}>
        <label><span>Month</span><input required type="month" value={rateMonth} onChange={(event) => setRateMonth(event.target.value)} /></label>
        <label><span>Currency</span><select value={rateCurrency} onChange={(event) => setRateCurrency(event.target.value)}>{availableCurrencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label>
        <label><span>1 {defaultCurrency} equals</span><div className="fx-rate-value"><input required min="0.01" step="0.01" inputMode="decimal" type="number" value={rateValue} onChange={(event) => setRateValue(event.target.value)} placeholder="0.00" /><b>{rateCurrency}</b></div></label>
        <button className="primary-button" disabled={Boolean(savingRateId)}><Plus size={17} />Add rate</button>
      </form>

      <div className="fx-rate-table">
        <div className="fx-rate-table-header"><span>Month</span><span>Pair</span><span>Rate</span><span /></div>
        {[...fxRates].sort((left, right) => right.date.localeCompare(left.date) || left.quoteCurrency.localeCompare(right.quoteCurrency)).map((rate) => (
          <ExchangeRateRow
            key={rate.id}
            rate={rate}
            saving={savingRateId === rate.id}
            confirmingDelete={confirmingDeleteRateId === rate.id}
            onSave={async (nextRate) => { try { await saveRate(nextRate) } catch { /* Error is displayed by SettingsPage. */ } }}
            onAskDelete={() => setConfirmingDeleteRateId(rate.id)}
            onCancelDelete={() => setConfirmingDeleteRateId('')}
            onDelete={() => void removeRate(rate.id)}
          />
        ))}
      </div>
      {fxRates.length === 0 && <p className="fx-rate-empty">No exchange rates have been saved yet.</p>}
    </section>

    <div className="settings-backup-grid">
      <section className="panel settings-card">
        <div className="settings-card-icon"><Download size={21} /></div>
        <div>
          <h2>Create a backup</h2>
          <p>Downloads accounts, transactions, budgets, categories, payees, exchange rates, and bank import history. Login details and bank credentials are not included.</p>
        </div>
        <button type="button" className="primary-button settings-action" disabled={exporting || restoring} onClick={() => void exportBackup()}>{exporting ? <LoaderCircle className="spin-icon" size={17} /> : <Download size={17} />}{exporting ? 'Preparing backup…' : 'Download backup'}</button>
      </section>

      <section className="panel settings-card restore-card">
        <div className="settings-card-icon rust"><Upload size={21} /></div>
        <div>
          <h2>Restore from a backup</h2>
          <p>Choose a Next Expense backup file. You can review its date and contents before anything changes.</p>
        </div>
        <label className="secondary-button settings-file-button">
          <Upload size={17} />Choose backup file
          <input type="file" accept=".json,application/json" disabled={restoring} onChange={(event) => { void chooseBackup(event.target.files?.[0]); event.currentTarget.value = '' }} />
        </label>

        {backup && <div className="backup-preview">
          <div className="backup-preview-heading">
            <FileCheck2 size={20} />
            <div><strong>{backup.workspace.name}</strong><span>{Number.isNaN(createdAt?.getTime() ?? NaN) ? 'Date unavailable' : createdAt?.toLocaleString()} · {(backupFileSize / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB</span><small>{backupFileName}</small></div>
          </div>
          <div className="backup-counts">{keyCounts.map(([label, count]) => <div key={label}><strong>{count.toLocaleString()}</strong><span>{label}</span></div>)}</div>
          <label className="restore-confirmation"><input type="checkbox" checked={confirmed} disabled={restoring} onChange={(event) => setConfirmed(event.target.checked)} /><span>I understand this will replace all data in the current workspace.</span></label>
          <button type="button" className="danger-button settings-action" disabled={!confirmed || restoring} onClick={() => void restoreBackup()}>{restoring ? <LoaderCircle className="spin-icon" size={17} /> : <Upload size={17} />}{restoring ? 'Restoring…' : 'Restore this backup'}</button>
          <p className="restore-safety-note">A fresh backup of the current workspace will download automatically before the restore starts.</p>
        </div>}
      </section>
    </div>

    {notice && <div className="settings-notice" role="status">{notice}</div>}
    {error && <div className="settings-error" role="alert">{error}</div>}
  </div>
}

function ExchangeRateRow({ rate, saving, confirmingDelete, onSave, onAskDelete, onCancelDelete, onDelete }: {
  rate: FxRate
  saving: boolean
  confirmingDelete: boolean
  onSave: (rate: FxRate) => Promise<void>
  onAskDelete: () => void
  onCancelDelete: () => void
  onDelete: () => void
}) {
  const [month, setMonth] = useState(rate.date.slice(0, 7))
  const [value, setValue] = useState((rate.rateHundredths / 100).toFixed(2))
  const parsedHundredths = Math.round(Number(value.trim().replace(',', '.')) * 100)
  const changed = month !== rate.date.slice(0, 7) || parsedHundredths !== rate.rateHundredths

  useEffect(() => {
    setMonth(rate.date.slice(0, 7))
    setValue((rate.rateHundredths / 100).toFixed(2))
  }, [rate.date, rate.rateHundredths])

  return <form className="fx-rate-row" onSubmit={(event) => {
    event.preventDefault()
    if (!Number.isSafeInteger(parsedHundredths) || parsedHundredths <= 0) return
    void onSave({ ...rate, date: `${month}-01`, rateHundredths: parsedHundredths })
  }}>
    <input aria-label={`Month for ${rate.baseCurrency}/${rate.quoteCurrency}`} required type="month" value={month} onChange={(event) => setMonth(event.target.value)} disabled={saving} />
    <strong>{rate.baseCurrency}/{rate.quoteCurrency}</strong>
    <div className="fx-rate-value"><input aria-label={`${rate.baseCurrency}/${rate.quoteCurrency} rate`} required min="0.01" step="0.01" inputMode="decimal" type="number" value={value} onChange={(event) => setValue(event.target.value)} disabled={saving} /><b>{rate.quoteCurrency}</b></div>
    <div className="fx-rate-actions">
      {confirmingDelete ? <><button type="button" className="fx-cancel-delete" onClick={onCancelDelete} disabled={saving}>Cancel</button><button type="button" className="fx-confirm-delete" onClick={onDelete} disabled={saving}>{saving ? 'Deleting…' : 'Delete'}</button></> : <>
        <button type="submit" className="secondary-button" disabled={!changed || saving}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" className="icon-button" aria-label={`Delete ${rate.baseCurrency}/${rate.quoteCurrency} rate for ${month}`} onClick={onAskDelete} disabled={saving}><Trash2 size={15} /></button>
      </>}
    </div>
  </form>
}
