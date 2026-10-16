import { useState, type FormEvent } from 'react'
import type { TimeCode } from '../../types'
import { getErrorMessage } from '../../app-utils'

export function KleerMappings({ codes, onSave }: { codes: TimeCode[]; onSave: (code: TimeCode) => Promise<void> }) {
  return <details className="kleer-mappings">
    <summary>Kleer reporting mappings</summary>
    <p>Keep your short item names here. Choose the exact Kleer project and activity for weekly copying. Selecting a project in Kleer also selects its customer.</p>
    {codes.map(code => <MappingRow key={`${code.id}:${JSON.stringify(code.kleerMapping)}`} code={code} onSave={onSave} />)}
  </details>
}
function MappingRow({ code, onSave }: { code: TimeCode; onSave: (code: TimeCode) => Promise<void> }) {
  const [project, setProject] = useState(code.kleerMapping?.project || '')
  const [activity, setActivity] = useState(code.kleerMapping?.activity || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = { project: project.trim(), activity: activity.trim() }
    if (Boolean(value.project) !== Boolean(value.activity)) { setError('Fill in both project and activity, or clear both to remove the mapping.'); return }
    setSaving(true); setError('')
    try {
      await onSave({ ...code, kleerMapping: value.project ? value : undefined })
      setSaved(true)
    } catch (cause) { setError(getErrorMessage(cause, 'Could not save this mapping.')) }
    finally { setSaving(false) }
  }
  return <form className="kleer-mapping-row" onSubmit={event => void submit(event)}>
    <div><strong>{code.name}</strong><span>{code.kleerMapping ? 'Mapped' : 'Not mapped'}</span></div>
    <label>Project<input aria-label={`Kleer project for ${code.name}`} maxLength={500} value={project} disabled={saving} onChange={event => { setProject(event.target.value); setSaved(false) }} /></label>
    <label>Activity<input aria-label={`Kleer activity for ${code.name}`} maxLength={200} value={activity} disabled={saving} onChange={event => { setActivity(event.target.value); setSaved(false) }} /></label>
    <button className="secondary-button" disabled={saving}>{saving ? 'Saving…' : 'Save mapping'}</button>
    {saved && <span role="status">Saved</span>}
    {error && <p role="alert">{error}</p>}
  </form>
}
