/** Modal-layer drawer for saved Flow schedules. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Input, Modal, Switch } from './dsh.ts'
import { type PropsLocale } from './dsh.ts'
import type { Automation, AutomationDraft, AutomationSchedule, Flow, FlowId, InputValue, PreflightResult } from '@switchboard/core/types'
import type { AutomationsFace } from './automation-presentation.tsx'
import styles from './AutomationsPage.module.css'

type Copy = PropsLocale<'switchboardAutomations'>

function inputDefaults(flow?: Flow): string {
  return JSON.stringify(Object.fromEntries(flow?.inputs.map(input => [input.name, input.default ?? (input.type === 'number' ? 0 : input.type === 'boolean' ? false : '')]) ?? []), null, 2)
}

function parseInputs(text: string): Record<string, InputValue> {
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
  const values: Record<string, InputValue> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error('primitive required')
    values[key] = value
  }
  return values
}

/** Human preview for daily rules; other expressions retain their exact fields and zone.
 * @param schedule - saved or draft timing rule.
 * @param t - locale dictionary.
 * @returns localized preview, without implying validation of the expression.
 */
export function scheduleText(schedule: AutomationSchedule, t: Copy['t']): string {
  if (schedule.kind === 'manual') return t('manual')
  const parts = schedule.expr.trim().split(/\s+/)
  if (/^\d+$/.test(parts[0] ?? '') && /^\d+$/.test(parts[1] ?? '') && parts.slice(2).join(' ') === '* * *' && Number(parts[0]) < 60 && Number(parts[1]) < 24) {
    return `${t('daily', { time: `${parts[1]?.padStart(2, '0')}:${parts[0]?.padStart(2, '0')}` })} · ${schedule.tz}`
  }
  return t('cronRule', { expr: schedule.expr, tz: schedule.tz })
}

/** Edit configuration without exposing Host timestamps or firing history.
 * @param props - available flows, optional existing schedule and save callbacks.
 * @returns focus-trapped drawer; failed saves keep the draft visible.
 */
export function AutomationEditor({ automation, flows, api, onClose, onSaved, t }: {
  automation?: Automation
  flows: Flow[]
  api: Pick<AutomationsFace['api'], 'automations.save' | 'flows.preflight'>
  onClose: () => void
  onSaved: (automation: Automation) => void
} & Copy): ReactNode {
  const [name, setName] = useState(automation?.name ?? '')
  const [flowId, setFlowId] = useState(automation?.flowId ?? flows[0]?.id ?? '' as FlowId)
  const [inputs, setInputs] = useState(automation ? JSON.stringify(automation.inputs, null, 2) : inputDefaults(flows[0]))
  const [kind, setKind] = useState<AutomationSchedule['kind']>(automation?.schedule.kind ?? 'cron')
  const [expr, setExpr] = useState(automation?.schedule.kind === 'cron' ? automation.schedule.expr : '0 2 * * *')
  const [tz, setTz] = useState(automation?.schedule.kind === 'cron' ? automation.schedule.tz : Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [enabled, setEnabled] = useState(automation?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [check, setCheck] = useState<PreflightResult>()
  const [checkFailed, setCheckFailed] = useState(false)
  const flow = flows.find(item => item.id === flowId)
  useEffect(() => {
    const controller = new AbortController()
    setCheck(undefined); setCheckFailed(false)
    void (async () => {
      try {
        const values = parseInputs(inputs)
        if (!flow) return
        const result = await api['flows.preflight'](flow, values)
        if (!controller.signal.aborted) {
          if (result.ok) setCheck(result.value)
          else setCheckFailed(true)
        }
      } catch { if (!controller.signal.aborted) setCheckFailed(true) }
    })()
    return () => { controller.abort() }
  }, [api, flow, inputs])
  const schedule: AutomationSchedule = kind === 'manual' ? { kind } : { kind, expr, tz }
  const save = async (): Promise<void> => {
    setError('')
    let values: Record<string, InputValue>
    try { values = parseInputs(inputs) } catch { setError(t('invalidInputs')); return }
    setBusy(true)
    try {
      if (!flow) { setError(t('missingFlow')); return }
      const admission = await api['flows.preflight'](flow, values)
      if (!admission.ok) { setError(t('failedPreflight')); return }
      setCheck(admission.value)
      if (enabled && !admission.value.ok) return
      const draft: AutomationDraft = { ...(automation ? { id: automation.id } : {}), name, flowId, inputs: values, schedule, enabled }
      const result = await api['automations.save'](draft)
      if (!result.ok) { setError(t('failedSave')); return }
      onSaved(result.value)
    } catch { setError(t('failedSave')) } finally { setBusy(false) }
  }
  return <Modal open title={t(automation ? 'edit' : 'create')} closeLabel={t('close')} onClose={() => { if (!busy) onClose() }} className={styles.drawer ?? ''} contentClassName={styles.drawerContent ?? ''}>
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void save() }}>
      <label>{t('name')}<Input data-modal-autofocus required value={name} onChange={(event) => { setName(event.target.value) }} disabled={busy} /></label>
      <label>{t('flow')}<select value={flowId} required disabled={busy} onChange={(event) => { setFlowId(event.target.value as FlowId); setInputs(inputDefaults(flows.find(item => item.id === event.target.value))) }}>
        {flows.map(flow => <option value={flow.id} key={flow.id}>{flow.name}</option>)}
      </select></label>
      <label>{t('inputs')}<textarea value={inputs} onChange={(event) => { setInputs(event.target.value) }} disabled={busy} rows={5} /></label>
      <label>{t('schedule')}<select value={kind} disabled={busy} onChange={(event) => { setKind(event.target.value as AutomationSchedule['kind']) }}><option value="cron">{t('cron')}</option><option value="manual">{t('manual')}</option></select></label>
      {kind === 'cron' && <><label>{t('cron')}<Input required value={expr} disabled={busy} onChange={(event) => { setExpr(event.target.value) }} /></label>
        <label>{t('timezone')}<Input required value={tz} disabled={busy} onChange={(event) => { setTz(event.target.value) }} /></label></>}
      <p className={styles.muted}>{scheduleText(schedule, t)}</p>
      <Switch label={t('enabled')} checked={enabled} onChange={setEnabled} disabled={busy} />
      <section aria-label={t('preflight')}>
        {check ? check.items.map((item, index) => <p key={index} role={item.level === 'error' ? 'alert' : 'status'}>{item.message}</p>) : <p>{t(checkFailed ? 'failedPreflight' : 'checking')}</p>}
      </section>
      {error && <p role="alert">{error}</p>}
      <Button variant="primary" type="submit" disabled={busy || !flows.length || (enabled && check?.ok === false)}>{t('save')}</Button>
    </form>
  </Modal>
}
