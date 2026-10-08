/** Graph settings editor with saved Flow selection and explicit agent scopes. */
import { useState, type ReactNode } from 'react'
import { Button } from './dsh.ts'
import { type PropsLocale } from './dsh.ts'
import type { AgentBlock, Flow, Graph, GraphId, GraphNode } from '@switchboard/core/types'
import styles from './GraphsPage.module.css'

type Props = PropsLocale<'switchboardGraphs'> & { graph: Graph; graphs: Graph[]; flows: Flow[]; save: (graph: Graph) => Promise<void>; cancel: () => void; remove: () => Promise<void> }
/** Edit a detached draft; errors leave all unsaved input intact.
 * @param props - draft, catalog, localized copy, and durable mutation callbacks.
 * @returns graph settings form.
 */
export function GraphEditor({ graph, graphs, flows, save, cancel, remove, t }: Props): ReactNode {
  const [draft, setDraft] = useState(graph)
  const [agents, setAgents] = useState<Record<string, string>>(() => Object.fromEntries(graph.nodes.flatMap(node => node.kind === 'agent' ? [[node.id, JSON.stringify(node.agent, null, 2)]] : [])))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const lead = (field: keyof Graph['lead'], value: string): void => { setDraft(valueDraft => ({ ...valueDraft, lead: { ...valueDraft.lead, [field]: value } })) }
  const node = (index: number, value: GraphNode): void => {
    setDraft(valueDraft => ({ ...valueDraft, nodes: valueDraft.nodes.map((old, i) => i === index ? value : old) }))
  }
  const newNodeId = (kind: string): string => {
    let index = 1
    while (draft.nodes.some(value => value.id === `${kind}-${index}`)) index++
    return `${kind}-${index}`
  }
  async function submit(deleting = false): Promise<void> {
    setPending(true); setError('')
    try {
      if (deleting) await remove()
      else {
        // The Host validates the complete JSON and every scope before accepting it.
        const nodes = draft.nodes.map(value => value.kind === 'agent' ? { ...value, agent: JSON.parse(agents[value.id] ?? '') as AgentBlock } : value)
        await save({ ...draft, nodes })
      }
    } catch (error) { setError(String(error)) }
    finally { setPending(false) }
  }
  return <form className={styles.editor} aria-label={t('editGraph')} onSubmit={(event) => { event.preventDefault(); if (!pending) void submit() }}>
    <h2>{t('editGraph')}</h2>
    <div className={styles.fields}>
      <label>{t('graphId')}<input required value={draft.id} disabled={graphs.some(value => value.id === graph.id)} onChange={(event) => { setDraft({ ...draft, id: event.target.value as GraphId }) }} /></label>
      <label>{t('name')}<input required value={draft.name} onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }} /></label>
      <label>{t('description')}<input required value={draft.description} onChange={(event) => { setDraft({ ...draft, description: event.target.value }) }} /></label>
      <label>{t('color')}<input type="color" value={draft.color} onChange={(event) => { setDraft({ ...draft, color: event.target.value }) }} /></label>
    </div>
    <fieldset><legend>{t('lead')}</legend><div className={styles.fields}>
      <label>{t('harness')}<select value={draft.lead.harness} onChange={(event) => { lead('harness', event.target.value) }}><option value="dsh">{t('dsh')}</option><option value="claude-code" disabled>{t('claude')}</option></select></label>
      <label>{t('provider')}<input value={draft.lead.provider ?? ''} onChange={(event) => { lead('provider', event.target.value) }} /></label>
      <label>{t('model')}<input value={draft.lead.model ?? ''} onChange={(event) => { lead('model', event.target.value) }} /></label>
      <label>{t('memory')}<input required value={draft.lead.memoryDir} onChange={(event) => { lead('memoryDir', event.target.value) }} /></label>
    </div><label>{t('instructions')}<textarea required value={draft.lead.instructions} onChange={(event) => { lead('instructions', event.target.value) }} /></label></fieldset>
    <fieldset><legend>{t('nodes')}</legend>
      {draft.nodes.map((value, index) => <div className={styles.nodeEditor} key={index}>
        <label>{t('nodeId')}<input required value={value.id} onChange={(event) => { if (value.kind === 'agent') setAgents({ ...agents, [event.target.value]: agents[value.id] ?? '' }); node(index, { ...value, id: event.target.value }) }} /></label>
        <label>{t('nodeDescription')}<input required value={value.description} onChange={(event) => { node(index, { ...value, description: event.target.value }) }} /></label>
        {value.kind === 'flow' ? <label>{t('flow')}<select value={value.flowId} onChange={(event) => { const flow = flows.find(flow => flow.id === event.target.value); if (flow) node(index, { ...value, flowId: flow.id }) }}>
          {!flows.some(flow => flow.id === value.flowId) && <option value={value.flowId}>{value.flowId}</option>}
          {flows.map(flow => <option key={flow.id} value={flow.id}>{flow.name}</option>)}
        </select></label> : <label>{t('agentSpec')}<textarea value={agents[value.id] ?? ''} onChange={(event) => { setAgents({ ...agents, [value.id]: event.target.value }) }} /></label>}
        <Button variant="outline" onClick={() => { setDraft({ ...draft, nodes: draft.nodes.filter((_, i) => i !== index) }) }}>{t('remove')}</Button>
      </div>)}
      <div className={styles.actions}>
        <Button variant="outline" disabled={!flows.length} onClick={() => { const flow = flows[0]; if (flow) setDraft({ ...draft, nodes: [...draft.nodes, { id: newNodeId('flow'), kind: 'flow', flowId: flow.id, description: flow.name }] }) }}>{t('addFlow')}</Button>
        <Button variant="outline" onClick={() => {
          const id = newNodeId('agent')
          const value: GraphNode = { id, kind: 'agent', description: t('readOnly'), agent: { id, kind: 'agent', label: t('readOnly'), harness: 'dsh', prompt: '{{inputs.task}}', scope: { cwd: '{{inputs.workspace}}', read: ['.'], write: [], commands: [], web: false, sandbox: 'read-only' } } }
          setDraft({ ...draft, nodes: [...draft.nodes, value] }); setAgents({ ...agents, [id]: JSON.stringify(value.agent, null, 2) })
        }}>{t('addAgent')}</Button>
      </div>
    </fieldset>
    <fieldset><legend>{t('edges')}</legend>{graphs.filter(value => value.id !== draft.id).map(value => <label key={value.id} className={styles.check}><input type="checkbox" checked={draft.edges.includes(value.id)} onChange={(event) => { setDraft({ ...draft, edges: event.target.checked ? [...draft.edges, value.id] : draft.edges.filter(id => id !== value.id) }) }} />{value.name}</label>)}</fieldset>
    <label>{t('tokenCap')}<input type="number" min={1} required value={draft.rules.maxCostTokens} onChange={(event) => { setDraft({ ...draft, rules: { ...draft.rules, maxCostTokens: Number(event.target.value) } }) }} /></label>
    <p>{t('productionRule')}</p>
    {error && <p role="alert">{t('actionError')} {error}</p>}
    <div className={styles.actions}><Button type="submit" disabled={pending}>{t('save')}</Button><Button variant="outline" disabled={pending} onClick={cancel}>{t('cancel')}</Button>{graphs.some(value => value.id === graph.id) && <Button variant="outline" disabled={pending} onClick={() => { void submit(true) }}>{t('deleteGraph')}</Button>}</div>
  </form>
}
