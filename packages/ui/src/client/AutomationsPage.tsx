/** Automation list, editor and durable run summaries; no dependency on the Flows page. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal, StateDot, Tag } from './dsh.ts'
import { type PropsLocale } from './dsh.ts'
import type { Automation, AutomationId, AutomationStats, Flow, PreflightResult, RunId } from '@switchboard/core/types'
import type { AutomationsFace } from './automation-presentation.tsx'
import { AutomationCharts } from './AutomationCharts.tsx'
import { AutomationEditor, scheduleText } from './AutomationEditor.tsx'
import styles from './AutomationsPage.module.css'

type Data = {
  automations: Automation[]
  flows: Flow[]
  stats: Map<AutomationId, AutomationStats>
  preflights: Map<AutomationId, PreflightResult>
}

/** Coalesce schedule reads without invalidating in-flight results; retry streams after reads settle.
 * @param props - generated Remote API, app-wide notices and localized copy.
 * @returns list, chart cards and an independently mounted editor drawer.
 */
export function AutomationsPage({ api, notify, t }: AutomationsFace & PropsLocale<'switchboardAutomations'>): ReactNode {
  const [data, setData] = useState<Data>()
  const [selected, setSelected] = useState<AutomationId>()
  const reload = useRef<() => Promise<void>>(async () => {})
  const [connection, setConnection] = useState(0)
  const [error, setError] = useState(false)
  const [editor, setEditor] = useState<Automation | 'new'>()
  const [deleting, setDeleting] = useState<Automation>()
  const [busy, setBusy] = useState(false)
  const refresh = (): void => { void reload.current(); setConnection(value => value + 1) }
  useEffect(() => {
    const controller = new AbortController()
    let inFlight: Promise<void> | undefined
    let requested = false
    const read = async (): Promise<void> => {
      try {
        const [automations, flows] = await Promise.all([api['automations.list'](), api['flows.list']()])
        if (!automations.ok || !flows.ok) throw new Error('list unavailable')
        const stats = new Map<AutomationId, AutomationStats>()
        const preflights = new Map<AutomationId, PreflightResult>()
        for (const automation of automations.value) {
          const result = await api['automations.stats'](automation.id, undefined)
          if (!result.ok) throw new Error('stats unavailable')
          stats.set(automation.id, result.value)
          const flow = flows.value.find(item => item.id === automation.flowId)
          if (flow) {
            const check = await api['flows.preflight'](flow, automation.inputs)
            if (check.ok) preflights.set(automation.id, check.value)
          }
        }
        if (!controller.signal.aborted) {
          setData({ automations: automations.value, flows: flows.value, stats, preflights }); setError(false)
        }
      } catch { if (!controller.signal.aborted) setError(true) }
    }
    reload.current = (): Promise<void> => {
      if (controller.signal.aborted) return Promise.resolve()
      requested = true
      inFlight ??= (async () => {
        while (requested && !controller.signal.aborted) {
          requested = false
          await read()
        }
        inFlight = undefined
      })()
      return inFlight
    }
    void reload.current()
    return () => { controller.abort() }
  }, [api])
  const current = data?.automations.find(item => item.id === selected) ?? data?.automations[0]
  const stats = current && data?.stats.get(current.id)
  const activeIds = JSON.stringify(stats?.runs.filter(run => ['queued', 'running', 'needs-you'].includes(run.state)).map(run => run.id) ?? [])
  const pending = stats?.runs.some(run => run.state === 'pending') ?? false
  const currentId = current?.id
  const check = currentId && data?.preflights.get(currentId)
  const reason = check ? check.items.find(item => item.level === 'error')?.message : t('failedPreflight')
  useEffect(() => {
    const controller = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    const reconnect = (): void => {
      if (controller.signal.aborted || retry !== undefined) return
      retry = setTimeout(() => {
        void reload.current().then(() => { if (!controller.signal.aborted) setConnection(value => value + 1) })
      }, 1000)
    }
    if (pending) reconnect()
    const ids = JSON.parse(activeIds) as RunId[]
    for (const id of ids) {
      void (async () => {
        try {
          for await (const _frame of api.followRuns(id, controller.signal)) {
            if (!controller.signal.aborted) void reload.current()
          }
        } catch { if (!controller.signal.aborted) setError(true) }
        reconnect()
      })()
    }
    return () => { controller.abort(); clearTimeout(retry) }
  }, [api, activeIds, pending, currentId, connection])

  const action = async (kind: 'run' | 'enabled' | 'delete', automation: Automation): Promise<void> => {
    setBusy(true)
    try {
      if (kind === 'run') {
        const result = await api['automations.runNow'](automation.id)
        if (!result.ok) throw new Error('run failed')
        notify(result.value.state === 'started' ? 'started' : result.value.state === 'skipped' ? 'skippedRun' : 'failedRun')
      } else if (kind === 'enabled') {
        if (!automation.enabled) {
          const flow = data?.flows.find(item => item.id === automation.flowId)
          if (!flow) throw new Error('flow unavailable')
          const result = await api['flows.preflight'](flow, automation.inputs)
          if (!result.ok) throw new Error('preflight unavailable')
          if (!result.value.ok) {
            setData(previous => previous && { ...previous, preflights: new Map(previous.preflights).set(automation.id, result.value) })
            return
          }
        }
        const result = await api['automations.setEnabled'](automation.id, !automation.enabled)
        if (!result.ok) throw new Error('update failed')
        notify('updated')
      } else {
        const result = await api['automations.delete'](automation.id)
        if (!result.ok) throw new Error('delete failed')
        setDeleting(undefined)
        notify('deleted')
      }
      refresh()
    } catch { notify('failedAction') } finally { setBusy(false) }
  }
  return <main className={styles.page}>
    <header className={styles.header}><div><h1>{t('title')}</h1><p>{t('intro')}</p></div><div className={styles.actions}>
      <Button onClick={refresh}>{t('refresh')}</Button><Button variant="primary" disabled={!data?.flows.length} onClick={() => { setEditor('new') }}>{t('create')}</Button>
    </div></header>
    {error && <p role="alert">{t('failedLoad')}</p>}
    {!data && !error && <div className={styles.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>}
    {data?.automations.length === 0 && <p>{t('empty')}</p>}
    <div className={styles.list}>
      {data?.automations.map((automation) => {
        const flow = data.flows.find(item => item.id === automation.flowId)
        const last = data.stats.get(automation.id)?.runs[0]
        return <button type="button" key={automation.id} className={styles.row} aria-pressed={automation.id === current?.id} onClick={() => { setSelected(automation.id) }}>
          <span><strong>{automation.name}</strong><small>{flow ? `${flow.name} · ${flow.blocks.map(block => block.label).join(' → ')}` : t('missingFlow')}</small></span>
          <span>{scheduleText(automation.schedule, t)}</span><Tag tone={automation.enabled && automation.schedule.kind === 'cron' ? 'success' : 'neutral'}>{t(automation.schedule.kind === 'manual' ? 'manual' : automation.enabled ? 'on' : 'paused')}</Tag>
          <span className={styles.muted}>{last ? t(last.state) : t('noRuns')}</span>
        </button>
      })}
    </div>
    {current && <><div className={styles.detailHeader}><h2>{current.name}</h2><div className={styles.actions}>
      <Button disabled={busy || !check || !check.ok} aria-describedby="automation-preflight" onClick={() => { void action('run', current) }}>{t('run')}</Button>
      <Button disabled={busy || (!current.enabled && (!check || !check.ok))} aria-describedby="automation-preflight" onClick={() => { void action('enabled', current) }}>{t(current.enabled ? 'pause' : 'enable')}</Button>
      <Button disabled={busy} onClick={() => { setEditor(current) }}>{t('edit')}</Button>
      <Button disabled={busy} onClick={() => { setDeleting(current) }}>{t('delete')}</Button>
    </div></div><p id="automation-preflight" role={reason ? 'alert' : 'status'}>{reason ?? check?.items.map(item => item.message).join(' · ')}</p>{stats && <AutomationCharts stats={stats} t={t} />}</>}
    {editor && data && <AutomationEditor {...(editor === 'new' ? {} : { automation: editor })} flows={data.flows} api={api} t={t} onClose={() => { setEditor(undefined) }} onSaved={(automation) => { setEditor(undefined); setSelected(automation.id); notify('saved'); refresh() }} />}
    {deleting && <Modal open title={t('delete')} closeLabel={t('close')} onClose={() => { if (!busy) setDeleting(undefined) }}>
      <p>{t('confirmDelete')}</p><Button disabled={busy} onClick={() => { void action('delete', deleting) }}>{t('delete')}</Button>
    </Modal>}
  </main>
}
