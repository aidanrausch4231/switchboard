/** Saved recipes, visual editing and launch admission on a global page. */
import { useEffect, useRef, useState } from 'react'
import { randomUUID } from './dsh.ts'
import { Button, Input, Checkbox, Modal, StateDot } from './dsh.ts'
import { type PropsLocale, type PropsRuntime } from './dsh.ts'
import type { Block, Flow, FlowId, FlowLayout, FlowRun, InputValue, PreflightResult } from '@switchboard/core/types'
import { FlowCanvas, positionsFor, type CanvasSelection } from './FlowCanvas.tsx'
import { BlockInspector, EdgeInspector, Field } from './FlowInspector.tsx'
import type { FlowsFace } from './flow-types.ts'
import styles from './Flows.module.css'

type Props = PropsRuntime<'main'> & PropsLocale<'switchboard'> & FlowsFace
const palette = ['dsh', 'claude-code', 'codex', 'fanout', 'checks', 'gate'] as const

/** Global editor; stale reads and preflight responses never replace a newer draft.
 * @param props - framework seats, locale and resolved Remote callbacks.
 * @returns saved-flow list, editor and inspector.
 */
export function FlowsPage(props: Props) {
  const { t } = props
  const [flows, setFlows] = useState<Flow[]>([])
  const [runs, setRuns] = useState<FlowRun[]>([])
  const [draft, setDraft] = useState<Flow>()
  const [layout, setLayout] = useState<FlowLayout>({ positions: [] })
  const [inputs, setInputs] = useState<Record<string, InputValue>>({})
  const [selection, setSelection] = useState<CanvasSelection>()
  const selected = selection?.kind === 'node' ? selection.id : undefined
  const edgeIndex = selection?.kind === 'edge' ? selection.index : undefined
  const [admission, setAdmission] = useState<{ flow: Flow; inputs: Record<string, InputValue>; result: PreflightResult }>()
  const [validation, setValidation] = useState<PreflightResult>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const operation = useRef({ id: 0, busy: false })
  const isCurrent = (id: number): boolean => operation.current.id === id
  useEffect(() => () => { operation.current.id++; operation.current.busy = false }, [])
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<Flow>()
  const [reload, setReload] = useState(0)
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [requested, setRequested] = useState<Flow>()
  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([props.listFlows(), props.listRuns()]).then(([saved, recent]) => {
      if (!active) return
      setFlows(saved); setRuns(recent); setError(''); setRequested(saved[0]); setLoading(false)
    }, (reason: unknown) => { if (active) { setError(String(reason)); setLoading(false) } })
    return () => { active = false }
  }, [props.listFlows, props.listRuns, reload])
  useEffect(() => {
    if (!requested) return
    operation.current.id++; operation.current.busy = false; setBusy(false)
    let active = true
    setLoading(true)
    props.getLayout(requested.id).then((value) => {
      if (!active) return
      setDraft(requested); setLayout(positionsFor(requested, value)); setSelection(undefined)
      const workspace = props.workspace()
      setInputs(Object.fromEntries(requested.inputs.flatMap((input) => {
        const value = input.name === 'workspace' ? workspace ?? input.default : input.default
        return value === undefined ? [] : [[input.name, value]]
      })))
      setDirty(false); setValidation(undefined); setSource(''); setTarget(''); setError(''); setLoading(false)
    }, (reason: unknown) => { if (active) { setError(String(reason)); setLoading(false) } })
    return () => { active = false }
  }, [requested, props.getLayout, props.workspace])
  useEffect(() => {
    if (!draft) return
    let active = true
    const timer = setTimeout(() => {
      props.preflight(draft, inputs).then((result) => {
        if (active) setAdmission({ flow: draft, inputs, result })
      }, (reason: unknown) => { if (active) setAdmission({ flow: draft, inputs, result: { ok: false, items: [{ level: 'error', code: 'remote', message: String(reason) }] } }) })
    }, 300)
    return () => { active = false; clearTimeout(timer) }
  }, [draft, inputs, props.preflight])
  const edit = (flow: Flow): void => { if (!operation.current.busy) { setDraft(flow); setDirty(true); setValidation(undefined) } }
  const selectFlow = (flow: Flow): void => {
    if (operation.current.busy) return
    if (dirty) setPending(flow); else setRequested({ ...flow })
  }
  const newFlow = (): void =>{  selectFlow({ id: `flow-${randomUUID()}` as FlowId, name: t('newFlow'), version: 1, inputs: [], blocks: [], edges: [], limits: {} }) }
  const save = async (id: number): Promise<Flow | undefined> => {
    if (!draft) return undefined
    const checked = await props.validate(draft)
    if (!isCurrent(id)) return undefined
    setValidation(checked)
    if (!checked.ok) return undefined
    const value = await props.saveFlow({ ...draft, version: flows.some(flow => flow.id === draft.id) ? draft.version + 1 : draft.version })
    if (!isCurrent(id)) return undefined
    // Recipe success is retained even if the independently stored layout fails.
    setDraft(value); setFlows(old => [value, ...old.filter(flow => flow.id !== value.id)])
    await props.saveLayout(value.id, layout)
    if (!isCurrent(id)) return undefined
    setDirty(false)
    return value
  }
  const perform = async (action: (id: number) => Promise<unknown>): Promise<void> => {
    if (operation.current.busy) return
    operation.current.busy = true
    const id = ++operation.current.id
    setBusy(true); setError('')
    try { await action(id) } catch (reason) { if (isCurrent(id)) setError(String(reason)) } finally {
      if (isCurrent(id)) { operation.current.busy = false; setBusy(false) }
    }
  }
  const add = (kind: string, position?: { x: number; y: number }): void => {
    if (!draft || busy || !palette.some(value => value === kind)) return
    const id = `block-${randomUUID()}`
    const block: Block = kind === 'gate' ? { id, kind: 'gate', label: t('gate') }
      : kind === 'checks' ? { id, kind: 'checks', label: t('checks'), cwd: '', commands: [] }
        : { id, kind: 'agent', label: t(kind as typeof palette[number]), harness: kind === 'codex' || kind === 'claude-code' ? kind : 'dsh', prompt: '', scope: { cwd: '', read: [], write: [], commands: [], web: false, sandbox: 'read-only' }, ...(kind === 'fanout' ? { copies: 3, concurrency: 3 } : {}) }
    edit({ ...draft, blocks: [...draft.blocks, block] })
    if (position) setLayout(old => ({ positions: [...old.positions, { id, ...position }] }))
    setSelection({ kind: 'node', id })
  }
  const connect = (from: string, to: string): void => {
    if (!draft || !from || !to || draft.edges.some(edge => edge.from === from && edge.to === to)) return
    edit({ ...draft, edges: [...draft.edges, { from, to, kind: 'next' }] })
    setSelection({ kind: 'edge', index: draft.edges.length })
  }
  const remove = (ids: string[], edges: number[]): void => {
    if (!draft) return
    edit({ ...draft, blocks: draft.blocks.filter(block => !ids.includes(block.id)),
      edges: draft.edges.filter((edge, index) => !edges.includes(index) && !ids.includes(edge.from) && !ids.includes(edge.to)) })
    setSelection(undefined)
  }
  const current = admission && admission.flow === draft && admission.inputs === inputs ? admission.result : undefined
  const issues = [...(validation?.items ?? []), ...(current?.items ?? [])].filter((item, index, items) =>
    items.findIndex(other => other.code === item.code && other.blockId === item.blockId
      && other.message === item.message && other.level === item.level) === index)
  const block = draft?.blocks.find(value => value.id === selected)
  const edge = edgeIndex === undefined ? undefined : draft?.edges[edgeIndex]
  return <section className={styles.page}>
    <aside className={styles.saved}>
      <h2>{t('title')}</h2><h3>{t('savedFlows')}</h3>
      <Button size="sm" variant="outline" onClick={newFlow} disabled={busy}>{t('newFlow')}</Button>
      {flows.map(flow => <Button key={flow.id} variant="ghost" size="sm" aria-pressed={draft?.id === flow.id} disabled={busy} onClick={() =>{  selectFlow(flow) }}>{flow.name}</Button>)}
      <h3>{t('runs')}</h3><Button size="sm" variant="ghost" disabled={busy} onClick={() => { void perform(async (id) => { const recent = await props.listRuns(); if (isCurrent(id)) setRuns(recent) }) }}>{t('refresh')}</Button>
      {!runs.length && <p>{t('noRuns')}</p>}
      {runs.map(run => <Button key={run.id} size="sm" variant="ghost" disabled={busy} onClick={() => { void perform(() => props.openRun(run)) }}>
        <span className={styles.runRow}>{run.flow.name}<small>{t(run.state)} · {t('runDuration', { seconds: Math.max(0, Math.round((Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000)) })}</small></span>
      </Button>)}
    </aside>
    <div className={styles.editor}>
      {error && <div role="alert" className={styles.error}>{error}{!draft && <Button size="sm" onClick={() =>{  setReload(value => value + 1) }}>{t('retry')}</Button>}</div>}
      {loading ? <div className={styles.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div> : draft ? <>
        <header className={styles.bar}>
          <Field label={t('name')} value={draft.name} change={(name) =>{  edit({ ...draft, name }) }} />
          <span>{t('version')} {draft.version} · {t(dirty ? 'unsaved' : 'saved')}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void perform(save) }}>{t(busy ? 'saving' : 'save')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void perform(async (id) => { const result = await props.validate(draft); if (isCurrent(id)) setValidation(result) }) }}>{t('validate')}</Button>
          <Button size="sm" variant="primary" disabled={busy || !current?.ok} onClick={() => { void perform(async (id) => {
            const saved = dirty || !flows.some(flow => flow.id === draft.id) ? await save(id) : draft
            if (!saved) return
            const run = await props.start(saved.id, inputs)
            if (!isCurrent(id)) return
            setRuns(old => [run, ...old]); await props.openRun(run)
          }) }}>{t('run')}</Button>
        </header>
        <div className={styles.columns}>
          <aside className={styles.palette}>
            <h3>{t('palette')}</h3><p>{t('harnesses')}</p>
            {palette.map((kind, index) => <div key={kind}>{index === 3 && <p>{t('control')}</p>}
              <Button size="sm" variant="outline" draggable={!busy} disabled={busy} onDragStart={(event) => { event.dataTransfer.setData('application/switchboard-block', kind); event.dataTransfer.effectAllowed = 'move' }} onClick={() =>{  add(kind) }}>{t(kind)}</Button>
            </div>)}
            <Button size="sm" variant="outline" disabled={busy || !edge} onClick={() => {
              if (edge) edit({ ...draft, edges: draft.edges.map((value, index) => index === edgeIndex ? { ...value, kind: 'loop', on: 'refuted', maxRounds: 1 } : value) })
            }}>{t('loop')}</Button>
            <p>{t('loopHint')}</p>
            <label className={styles.field}>{t('source')}<select value={source} onChange={(event) =>{  setSource(event.target.value) }}><option value="">—</option>{draft.blocks.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
            <label className={styles.field}>{t('target')}<select value={target} onChange={(event) =>{  setTarget(event.target.value) }}><option value="">—</option>{draft.blocks.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
            <Button size="sm" disabled={busy || !source || !target} onClick={() =>{  connect(source, target) }}>{t('connect')}</Button>
          </aside>
          <FlowCanvas flow={draft} layout={layout} t={t} issues={issues} selection={selection}
            select={setSelection}
            connect={(connection) =>{  connect(connection.source, connection.target) }} drop={add} remove={remove}
            move={(value) => { if (!operation.current.busy) { setLayout(value); setDirty(true) } }} />
          <aside className={styles.inspector}>
            <h3>{t('inspector')}</h3>
            <fieldset disabled={busy}>
              {block ? <BlockInspector block={block} t={t} change={(value) => {
                edit({ ...draft, blocks: draft.blocks.map(old => old.id === value.id ? value : old) })
              }} />
                : edge ? <EdgeInspector edge={edge} t={t} change={(value) =>{  edit({ ...draft, edges: draft.edges.map((old, index) => index === edgeIndex ? value : old) }) }} /> : <p>{t('selectBlock')}</p>}
              {(block || edge) && <Button size="sm" variant="outline" onClick={() =>{  remove(block ? [block.id] : [], edgeIndex === undefined ? [] : [edgeIndex]) }}>{t('remove')}</Button>}
              {!!draft.inputs.length && <><h3>{t('inputs')}</h3><p>{t('inputHint')}</p>{draft.inputs.map(input => input.type === 'boolean'
                ? <Checkbox key={input.name} label={input.name} checked={inputs[input.name] === true} onChange={(value) => {
                  setInputs(old => ({ ...old, [input.name]: value }))
                }} />
                : <label className={styles.field} key={input.name}>{input.name}<Input type={input.type === 'number' ? 'number' : 'text'} value={String(inputs[input.name] ?? '')} onChange={(event) =>{  setInputs((old) => {
                  if (event.target.value === '') return Object.fromEntries(Object.entries(old).filter(([key]) => key !== input.name))
                  return { ...old, [input.name]: input.type === 'number' ? Number(event.target.value) : event.target.value }
                }) }} /></label>)}</>}
            </fieldset>
            <div className={styles.preflight}><h3>{t('preflight')}</h3>{!current && <p>{t('checking')}</p>}{current?.ok && !issues.length && <p>{t('ok')}</p>}
              {issues.map((item, index) => <p key={index} data-level={item.level}><strong>{t(item.level === 'ok' ? 'ok' : item.level)}</strong> {item.message}</p>)}
            </div>
          </aside>
        </div>
      </> : <p>{t('empty')}</p>}
    </div>
    {pending && <Modal open title={t('discardTitle')} onClose={() =>{  setPending(undefined) }} closeLabel={t('stay')}>
      <Button disabled={busy} onClick={() => { if (operation.current.busy) return; setRequested({ ...pending }); setPending(undefined) }}>{t('discard')}</Button><Button onClick={() =>{  setPending(undefined) }}>{t('stay')}</Button>
    </Modal>}
  </section>
}
