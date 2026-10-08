/** Durable run summary and read-only graph in the existing right dock. */
import { useEffect, useState } from 'react'
import { Button, StateDot, IconBranchOutlineRegular } from './dsh.ts'
import { type InjectFace, type PropsLocale, type PropsRuntime } from './dsh.ts'
import type { FlowRun, RunId } from '@switchboard/core/types'

import { FlowCanvas } from './FlowCanvas.tsx'
import type { Copy, RunFace } from './flow-types.ts'
import { blockState } from './run-state.ts'
import type { RunModel } from './run-model.ts'
import styles from './Flows.module.css'

/** Shared observable seat bound by Slots. */
export interface RunInjection extends RunFace { hooks: { runs: RunModel['source'] } }
type LiveProps = InjectFace<RunInjection> & PropsLocale<'switchboard'>
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { 'switchboard-flow': { runId: RunId } }
}

/** Compact progress used by both chat and dock.
 * @param props - durable run and localized copy.
 * @returns state, progress and observed usage.
 */
export function RunSummary({ run, t }: { run: FlowRun; t: Copy }) {
  const done = run.flow.blocks.filter(block => blockState(run, block.id).state === 'succeeded').length
  return <div className={styles.summary}>
    <strong>{run.flow.name}</strong><span data-state={run.state}>{t(run.state)}</span>
    <span>{t('progress', { done, total: run.flow.blocks.length })}</span>
    <progress aria-label={t('progress', { done, total: run.flow.blocks.length })} max={run.flow.blocks.length || 1} value={done} />
    <small>{t('tokens')} {run.tokens}</small>
    {run.attempts.some(attempt => run.flow.blocks.find(block => block.id === attempt.blockId)?.kind === 'agent' && !attempt.usage) && <small>{t('usageUnavailable')}</small>}
  </div>
}

/** Subscribe through the registration-owned model and render its latest snapshot.
 * @param props - run identity, framework live seat and commands.
 * @returns live graph, errors and checkpoint controls.
 */
export function RunView({ id, ...props }: LiveProps & { id: RunId }) {
  const { t, watch, useRuns } = props
  const [retry, setRetry] = useState(0)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  useEffect(() => watch(id), [watch, id, retry])
  const view = useRuns(state => state[id])
  const run = view?.run
  const perform = async (action: () => Promise<unknown>): Promise<void> => {
    setPending(true); setError('')
    try { await action() } catch (reason) { setError(String(reason)) } finally { setPending(false) }
  }
  const waiting = run?.attempts.findLast(attempt => attempt.state === 'needs-you')
  return <section className={styles.runPanel}>
    {(error || view?.error) && <div role="alert">{error || view?.error}<Button size="sm" onClick={() =>{  setRetry(value => value + 1) }}>{t('retry')}</Button></div>}
    {run ? <>
      <RunSummary run={run} t={t} />
      <FlowCanvas flow={run.flow} layout={{ positions: [] }} run={run} t={t} />
      {run.error && <p role="alert">{run.error}</p>}
      <div className={styles.runActions}>
        {run.state === 'needs-you' && waiting && <div className={styles.gate}>
          <strong>{run.flow.blocks.find(block => block.id === waiting.blockId)?.label}</strong>
          <Button size="sm" variant="primary" disabled={pending || !!view.error} onClick={() => { void perform(async () => { if (!await props.approve(id, waiting.blockId, true)) throw new Error(t('failed')) }) }}>{t('approve')}</Button>
          <Button size="sm" variant="outline" disabled={pending || !!view.error} onClick={() => { void perform(async () => { if (!await props.approve(id, waiting.blockId, false)) throw new Error(t('failed')) }) }}>{t('deny')}</Button>
        </div>}
        {!['succeeded', 'failed', 'cancelled'].includes(run.state) && <Button size="sm" variant="outline" disabled={pending} onClick={() => { void perform(() => props.cancel(id)) }}>{t('runCancel')}</Button>}
      </div>
    </> : <div className={styles.loading}><StateDot state="ongoing" /></div>}
  </section>
}

/** Localized dock title with its shared branch glyph.
 * @param props - dock title and locale seats.
 * @returns tab icon and label.
 */
export function FlowTitle({ t }: PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'switchboard'>) {
  return <span className={styles.tabTitle}><IconBranchOutlineRegular size={14} />{t('flow')}</span>
}

/** Dock body reads the run identity from its typed navigation.
 * @param props - dock and run seats.
 * @returns selected live run, or an empty state.
 */
export function RunPanel(props: PropsRuntime<'sidebar.right.pane.tab'> & LiveProps) {
  const params = props.useTabInfo().tab.navigation.params
  return params && 'runId' in params ? <RunView key={params.runId} {...props} id={params.runId} /> : <p>{props.t('noRuns')}</p>
}
