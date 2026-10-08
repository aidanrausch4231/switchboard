/** One chat node from the run_flow tool's durable result metadata. */
import { useEffect, useState } from 'react'
import { Button, StateDot } from './dsh.ts'
import { type ConversationNodeDefinition } from './dsh.ts'
import { type InjectFace, type PropsLocale, type PropsRuntime } from './dsh.ts'
import type { FlowRun, RunId } from '@switchboard/core/types'

import { RunSummary, type RunInjection } from './RunPanel.tsx'
import styles from './Flows.module.css'

interface CardData { runId: RunId; name: string }
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'switchboard-run': CardData }
}
function dataOf(event: Parameters<ConversationNodeDefinition<CardData>['match']>[0]): CardData | undefined {
  if (event.type !== 'tool/result' || event.data.message.isError) return undefined
  const meta = event.data.meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const data = meta.switchboardRun
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.runId !== 'string' || typeof data.name !== 'string') return undefined
  return { runId: data.runId as RunId, name: data.name }
}
/** Result-time identity survives history paging without inventing Session events. */
export const runDefinition: ConversationNodeDefinition<CardData> = {
  kind: 'switchboard-run', target: 'chat',
  match(event) { const data = dataOf(event); return data ? { id: data.runId, role: 'start' } : null },
  start(_context, match) {
    const data = dataOf(match.event)
    if (!data) throw new Error('Flow card requires run result metadata')
    return data
  },
  update(context) { return context.state },
  buildViewNode(context) {
    if (!context.start || !context.state) return null
    return { key: context.key, kind: 'switchboard-run', target: 'chat', id: context.id, anchorSeq: context.start.event.seq, location: context.start.location, visibility: 'visible', data: context.state }
  },
}
/** Live progress for the run named by a replayable tool result.
 * @param props - node payload, framework observation seat and dock action.
 * @returns compact card with a dock link.
 */
export function RunCard(props: PropsRuntime<'conversation.chat.node', 'switchboard-run'> & PropsLocale<'switchboard'> & InjectFace<RunInjection> & { openRun(run: FlowRun): Promise<void> }) {
  const id = props.node.data.runId
  const [error, setError] = useState('')
  useEffect(() => props.watch(id), [props.watch, id])
  const view = props.useRuns(state => state[id])
  return <section className={styles.card}>
    {view?.run ? <><RunSummary run={view.run} t={props.t} /><Button size="sm" variant="outline" onClick={() => { if (view.run) { setError(''); void props.openRun(view.run).catch((reason: unknown) => { setError(String(reason)) }) } }}>{props.t('openDock')}</Button></>
      : <><strong>{props.node.data.name}</strong><StateDot state="ongoing" /></>}
    {(error || view?.error) && <p role="alert">{error || view?.error}</p>}
  </section>
}
