/** Inbox canvas, card board, routing log, and graph drill-down over generated Remote data. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, StateDot } from './dsh.ts'
import { type PropsLocale } from './dsh.ts'
import type { Card, CardId, CardRoute, Flow, Graph, GraphId, GraphTarget } from '@switchboard/core/types'
import type { GraphsFace } from './graphs-presentation.ts'
import { GraphEditor } from './GraphEditor.tsx'
import styles from './GraphsPage.module.css'

type Locale = PropsLocale<'switchboardGraphs'>
type Props = Locale & { api: GraphsFace }

/** Render Graphs without launching models on page load; followers are disposed on unmount.
 * @param props - generated API and translator.
 * @returns inbox workspace.
 */
export function GraphsPage({ api, t }: Props): ReactNode {
  const [graphs, setGraphs] = useState<Graph[]>([])
  const [flows, setFlows] = useState<Flow[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<GraphId>()
  const [cardId, setCardId] = useState<CardId>()
  const [tab, setTab] = useState<'board' | 'routing' | 'timeline'>('board')
  const [draft, setDraft] = useState<Graph>()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [pending, setPending] = useState(false)
  const [preview, setPreview] = useState<CardRoute>()
  const [memory, setMemory] = useState('')
  useEffect(() => {
    const lifetime = new AbortController()
    setMemory('')
    if (selected) void api['graphs.memory'](selected).then((result) => {
      if (lifetime.signal.aborted) return
      if (result.ok) setMemory(result.value)
      else setError(result.error.message)
    }).catch((error: unknown) => { if (!lifetime.signal.aborted) setError(String(error)) })
    return () => { lifetime.abort() }
  }, [api, selected, graphs])
  useEffect(() => {
    const lifetime = new AbortController()
    const stream = api.followCards()
    setError('')
    void Promise.all([api['graphs.list'](), api['flows.list']()]).then(([g, f]) => {
      if (lifetime.signal.aborted) return
      if (!g.ok) throw g.error
      if (!f.ok) throw f.error
      setGraphs(g.value); setFlows(f.value); setLoaded(true)
    }).catch((error: unknown) => { if (!lifetime.signal.aborted) setError(String(error)) })
    void (async () => {
      try {
        for await (const frame of stream) { if (!lifetime.signal.aborted) setCards(frame.cards) }
        if (!lifetime.signal.aborted) setError(t('loadError'))
      } catch (error) { if (!lifetime.signal.aborted) setError(String(error)) }
      finally { stream.dispose() }
    })()
    return () => { lifetime.abort(); stream.dispose() }
  }, [api, attempt, t])
  const graph = graphs.find(value => value.id === selected)
  const card = cards.find(value => value.id === cardId)
  async function mutate(action: () => Promise<{ ok: boolean; error?: { message: string } }>): Promise<void> {
    setPending(true); setError('')
    try { const result = await action(); if (!result.ok) throw new Error(result.error?.message ?? t('actionError')) }
    catch (error) { setError(String(error)) }
    finally { setPending(false) }
  }
  async function save(value: Graph): Promise<void> {
    const result = await api['graphs.save'](value)
    if (!result.ok) throw result.error
    setGraphs(values => [...values.filter(other => other.id !== result.value.id), result.value]); setDraft(undefined)
  }
  return <main className={styles.page}>
    <header className={styles.heading}><div><h1>{graph?.name ?? t('title')}</h1><p>{t('intro')}</p></div><div className={styles.actions}>
      {graph && <Button variant="outline" onClick={() => { setSelected(undefined) }}>{t('top')}</Button>}
      <Button variant="outline" onClick={() => { setDraft(graph ?? { id: '' as GraphId, name: '', description: '', color: '#6ea8fe', lead: { harness: 'dsh', provider: 'deepseek-official', model: 'deepseek-v4-flash', memoryDir: '', instructions: '' }, nodes: [], edges: [], rules: { maxCostTokens: 100000, prodWrites: 'never' } }) }}>{graph ? t('editGraph') : t('newGraph')}</Button>
    </div></header>
    {error && <div role="alert" className={styles.notice}>{error} <Button variant="outline" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button></div>}
    {!loaded && !error && <div className={styles.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>}
    {draft ? <GraphEditor key={draft.id} graph={draft} graphs={graphs} flows={flows} t={t} save={save}
      cancel={() => { setDraft(undefined) }} remove={async () => {
        const result = await api['graphs.delete'](draft.id)
        if (!result.ok) throw result.error
        setGraphs(values => values.filter(value => value.id !== draft.id))
        setSelected(undefined); setDraft(undefined)
      }} /> : loaded && <>
      <div className={styles.layout}>
        <section className={styles.canvas} aria-label={graph?.name ?? t('title')}>
          <GraphCanvas graphs={graphs} graph={graph} flows={flows} t={t} select={(id) => { setSelected(id); setTab('timeline'); setCardId(cards.find(card => card.route?.target === id)?.id) }} />
          {graph && <div className={styles.memory}><h2>{t('memory')}</h2><code>{graph.lead.memoryDir}</code><p>{t('memoryHint')}</p><pre>{memory}</pre><p>{graph.lead.instructions}</p></div>}
          <div className={styles.rules}><h2>{t('rules')}</h2><p>{t('confidenceRule')}</p><p>{t('hopsRule')}</p><p>{t('productionRule')}</p><p>{t('fallbackRule')}</p></div>
        </section>
        <aside className={styles.dock} aria-label={t('routing')}>
          <nav className={styles.tabs} aria-label={t('board')}>{(['routing', 'board', ...(graph ? ['timeline'] as const : [])] as const).map(value => <button key={value} type="button" aria-pressed={tab === value} onClick={() => { setTab(value) }}>{t(value)}</button>)}</nav>
          {tab === 'routing' ? <RoutingLog cards={cards} graphs={graphs} t={t} select={(id) => { setCardId(id); setTab('timeline') }} />
            : tab === 'timeline' ? <div className={styles.timeline}>
              <label>{t('timeline')}<select value={cardId ?? ''} onChange={(event) => { setCardId(event.target.value as CardId) }}><option value="">{t('noTimeline')}</option>{cards.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</select></label>
              {card && <><h2>{card.title}</h2>{card.timeline.map((event, index) => <article key={index}>
                <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time>
                <div><strong>{event.actor} · {event.kind}</strong><p>{event.text}</p></div>
              </article>)}{card.result && <p>{card.result}</p>}</>}
            </div> : <div className={styles.dockSummary}>
              <h2>{t('board')}</h2>{(['new', 'running', 'needs-you', 'done'] as const).map(state => <div key={state}>
                <span>{t(state)}</span><strong>{cards.filter(card => column(card) === state).length}</strong>
              </div>)}<p>{t('approveHint')}</p>
            </div>}
        </aside>
      </div>
      <section className={styles.boardSection} aria-label={t('board')}>
        <h2>{t('board')}</h2>
        <form className={styles.newCard} onSubmit={(event) => { event.preventDefault(); if (pending) return; void mutate(async () => {
          const result = await api['cards.create']({ title, body, source: 'manual', ...(workspace ? { workspace } : {}) }); if (result.ok) { setTitle(''); setBody(''); setPreview(undefined) } return result
        }) }}>
          <label>{t('newCard')}<input required maxLength={200} value={title} placeholder={t('cardTitle')} onChange={(event) => { setTitle(event.target.value) }} /></label>
          <label>{t('cardBody')}<textarea value={body} maxLength={32768} onChange={(event) => { setBody(event.target.value) }} /></label>
          <label>{t('workspace')}<input value={workspace} placeholder={t('workspaceHint')} onChange={(event) => { setWorkspace(event.target.value) }} /></label>
          <div className={styles.actions}><Button type="submit" disabled={pending || !title.trim()}>{t('create')}</Button><Button variant="outline" disabled={pending || !title.trim()} onClick={() => { void mutate(async () => { const result = await api['router.test'](`${title}\n${body}`); if (result.ok) setPreview(result.value); return result }) }}>{t('preview')}</Button></div>
        </form>
        {preview && <p role="status">{preview.target} · {t('confidence', { value: Math.round(preview.confidence * 100) })} · {preview.reason}</p>}
        <CardBoard cards={cards} graphs={graphs} t={t} pending={pending} select={(id) => { setCardId(id); setTab('timeline') }} approve={(id) => { void mutate(() => api['cards.approve'](id)) }} reject={(id) => { void mutate(() => api['cards.reject'](id)) }} reroute={(id, target) => { void mutate(() => api['cards.reroute'](id, target)) }} />
      </section>
    </>}
  </main>
}
function column(card: Card): 'new' | 'running' | 'needs-you' | 'done' { return card.state === 'routing' ? 'new' : card.state === 'failed' ? 'needs-you' : card.state }
function targetName(route: CardRoute, graphs: Graph[], t: Locale['t']): string { return route.target === 'you' ? t('you') : route.target === 'council' ? t('council') : graphs.find(value => value.id === route.target)?.name ?? route.target }

/** Fixture-friendly routing decisions; data is never replaced by illustration cards.
 * @param props - committed cards, catalog, selection, and locale.
 * @returns routing log.
 */
export function RoutingLog(
  { cards, graphs, t, select }: Locale & { cards: Card[]; graphs: Graph[]; select: (id: CardId) => void },
): ReactNode {
  return <div className={styles.routing} aria-label={t('routing')}>{!cards.some(card => card.route) && <p>{t('noRoutes')}</p>}{cards.filter(card => card.route).map(card => <article key={card.id}>
    <button type="button" onClick={() => { select(card.id) }}>{card.title}</button><small>{card.source}</small>
    {card.route && <><div className={styles.routeTarget}><span>→ {targetName(card.route, graphs, t)}</span><span className={styles.chip}>{t('confidence', { value: Math.round(card.route.confidence * 100) })}</span></div><p>{card.route.reason}</p></>}
  </article>)}</div>
}

/** Four-column board with explicit, non-drag human actions.
 * @param props - authoritative cards and action callbacks.
 * @returns accessible board columns.
 */
export function CardBoard({ cards, graphs, t, pending, select, approve, reject, reroute }: Locale & {
  cards: Card[]
  graphs: Graph[]
  pending: boolean
  select: (id: CardId) => void
  approve: (id: CardId) => void
  reject: (id: CardId) => void
  reroute: (id: CardId, target: GraphTarget) => void
}): ReactNode {
  return <div className={styles.board}>{(['new', 'running', 'needs-you', 'done'] as const).map(state => <section key={state} aria-label={t(state)} data-state={state} className={styles.column}>
    <h3>{t(state)} <span>{cards.filter(card => column(card) === state).length}</span></h3>
    {cards.filter(card => column(card) === state).map(card => <article key={card.id} className={styles.card}>
      <button type="button" onClick={() => { select(card.id) }}>{card.title}</button>
      <small>{card.source} · {t(card.state === 'routing' ? 'routingState' : card.state)}</small>
      {card.route && <p>{targetName(card.route, graphs, t)} · {card.route.reason}</p>}
      <div className={styles.badges}><span className={styles.chip}>{t('tokens', { count: card.costTokens })}</span><span>{t('hops', { count: card.hops })}</span>{card.usageUnavailable && <span>{t('usageUnavailable')}</span>}</div>
      {state === 'needs-you' && <><div className={styles.actions}><Button variant="outline" disabled={pending} onClick={() => { approve(card.id) }}>{t('approve')}</Button><Button variant="outline" disabled={pending} onClick={() => { reject(card.id) }}>{t('reject')}</Button></div><Reroute card={card} graphs={graphs} pending={pending} reroute={reroute} t={t} /></>}
    </article>)}
    {!cards.length && state === 'new' && <p>{t('noCards')}</p>}
  </section>)}</div>
}
function Reroute({ card, graphs, pending, reroute, t }: Locale & {
  card: Card
  graphs: Graph[]
  pending: boolean
  reroute: (id: CardId, target: GraphTarget) => void
}): ReactNode {
  const [target, setTarget] = useState<GraphTarget>('you')
  return <div className={styles.actions}><select aria-label={t('destination')} value={target} onChange={(event) => { setTarget(event.target.value as GraphTarget) }}><option value="you">{t('you')}</option><option value="council">{t('council')}</option>{graphs.map(graph => <option key={graph.id} value={graph.id}>{graph.name}</option>)}</select><Button variant="outline" disabled={pending} onClick={() => { reroute(card.id, target) }}>{t('reroute')}</Button></div>
}
function GraphCanvas({ graphs, graph, flows, t, select }: Locale & {
  graphs: Graph[]
  graph: Graph | undefined
  flows: Flow[]
  select: (id: GraphId) => void
}): ReactNode {
  if (graph) return <div className={styles.inside}>
    <p>{t('fromJev')}</p><div className={styles.lead} style={{ borderColor: graph.color }}><h2>{graph.name} · {t('lead')}</h2><p>{graph.lead.harness} · {graph.lead.model}</p><small>{t('memoryHint')}</small></div>
    <svg viewBox="0 0 600 65" aria-hidden="true" className={styles.branch}>
      {graph.nodes.map((node, i) => <path key={node.id} d={`M300 0 V25 H${600 * (i + 0.5) / graph.nodes.length} V65`} />)}
    </svg>
    <div className={styles.nodes}>{graph.nodes.map((node) => {
      const blocks = node.kind === 'agent' ? [node.agent] : flows.find(flow => flow.id === node.flowId)?.blocks ?? []
      return <article key={node.id}><h3>{node.id}</h3><p>{node.description}</p><span className={styles.chip}>{node.kind === 'flow' ? node.flowId : node.agent.harness}</span>{blocks.flatMap(block => block.kind === 'agent' ? [<div key={block.id} className={styles.scope}><span>{block.label} · {block.scope.sandbox}</span><code>{block.scope.cwd}</code><small>{t('scope')}: {block.scope.read.join(', ')} / {block.scope.write.join(', ') || t('readOnly')}</small><small>{t(block.scope.web ? 'webOn' : 'webOff')}</small></div>] : [])}</article>
    })}</div><div className={styles.edges}><span>{t('edges')}</span>{graph.edges.map(id => <button key={id} type="button" onClick={() => { select(id) }}>{graphs.find(value => value.id === id)?.name ?? id}</button>)}</div>
  </div>
  const targets = [...graphs.map(graph => ({ id: graph.id, name: graph.name, detail: t('graphSummary', { count: graph.nodes.length }), color: graph.color })), { id: 'council', name: t('council'), detail: t('councilHint'), color: 'var(--dsw-alias-border-l2)' }, { id: 'you', name: t('you'), detail: t('youHint'), color: 'var(--dsw-alias-border-l2)' }]
  const height = Math.max(400, targets.length * 76 + 35)
  return <svg className={styles.graphSvg} viewBox={`0 0 660 ${height}`} role="img" aria-label={t('title')}>
    <text x={22} y={24}>{t('inbox')}</text>
    {(['chatVoice', 'manual', 'failedRuns', 'webhook'] as const).map((key, i) => <g key={key}><rect x={20} y={40 + i * 54} width={150} height={38} rx={8} /><text x={33} y={64 + i * 54}>{t(key)}</text><path d={`M170 ${59 + i * 54} Q210 ${59 + i * 54} 240 158`} /></g>)}
    <polygon className={styles.diamond} points="300,106 360,158 300,210 240,158" /><text x={287} y={155}>{t('jev')}</text><text x={278} y={176} className={styles.svgSmall}>{t('router')}</text>
    {targets.map((target, i) => <g key={target.id}><path d={`M360 158 Q400 ${48 + i * 76} 446 ${48 + i * 76}`} />
      <g role={graphs.some(graph => graph.id === target.id) ? 'button' : undefined} tabIndex={graphs.some(graph => graph.id === target.id) ? 0 : undefined} aria-label={target.name} className={styles.svgNode} onClick={() => { const graph = graphs.find(graph => graph.id === target.id); if (graph) select(graph.id) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); const graph = graphs.find(graph => graph.id === target.id); if (graph) select(graph.id) } }}>
        <rect x={452} y={26 + i * 76} width={190} height={54} rx={8} style={{ stroke: target.color }} />
        <rect x={446} y={20 + i * 76} width={190} height={54} rx={8} style={{ stroke: target.color }} />
        <text x={460} y={43 + i * 76}>{target.name}</text>
        <text x={460} y={62 + i * 76} className={styles.svgSmall}>{target.detail}</text>
      </g></g>)}
    {graphs.flatMap((graph, index) => graph.edges.map((id) => {
      const other = graphs.findIndex(graph => graph.id === id)
      return other < 0 ? null : <path key={`${graph.id}-${id}`} className={styles.askEdge}
        d={`M642 ${48 + index * 76} Q668 ${(index + other) * 38 + 48} 642 ${48 + other * 76}`} />
    }))}
  </svg>
}
