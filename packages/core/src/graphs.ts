/** Durable cards and bounded lead-to-lead orchestration; no side effect is replayed after restart. */
import { randomUUID } from 'node:crypto'
import { type Domain } from './dsh.ts'
import type { Card, CardId, CardInput, CardRoute, Graph, GraphId, GraphNode, GraphTarget } from './graph-types.ts'
import { cardInputSchema, graphSchema, graphsDomain } from './graph-schema.ts'
import { productionWrite, routeCard, type RouterCaller, type RouterConfig } from './graph-router.ts'

/** Lead capabilities supplied only to the owning scoped agent. */
export interface LeadActions {
  dispatch(nodeId: string, input: Record<string, import('./types.ts').InputValue>): Promise<string>
  askNode(graphId: GraphId, question: string): Promise<string>
  bounce(reason: string): Promise<string>
  done(summary: string): Promise<string>
}
/** Host policy for routing and bounded card execution. */
export interface GraphConfig extends RouterConfig {
  /** Cumulative card token ceiling, including routing and delegated work. */
  graphMaxCostTokens: number
  /** Active card deadline in milliseconds. */
  graphTimeoutMs: number
}
/** External operations await charge checkpoints before subsequent work.
 * Logging and cleanup must retain usage and budget failures.
 */
export interface GraphEnvironment extends RouterCaller {
  config: GraphConfig
  lead(
    this: void, graph: Graph, question: string, actions: LeadActions, signal: AbortSignal, charge: (tokens: number) => void | Promise<void>,
  ): Promise<void>
  dispatch(
    this: void, node: GraphNode, input: Record<string, import('./types.ts').InputValue>,
    workspace: string, budget: number, signal: AbortSignal, charge: (tokens: number) => void | Promise<void>,
  ): Promise<string>
  council(this: void, question: string, signal: AbortSignal, charge: (tokens: number) => void | Promise<void>): Promise<string>
}
interface Active { card: Card; controller: AbortController; done: Promise<void>; checkpoint: Promise<void> }

/** Owns card mutations, background tasks, and their shutdown drainage. */
export class GraphEngine {
  private readonly active = new Map<CardId, Active>()
  private readonly changing = new Set<CardId>()
  private closing = false
  /** @param domain - caller-owned graph storage.
   * @param environment - logged model and scoped execution operations.
   */
  constructor(private readonly domain: Domain<typeof graphsDomain>, readonly environment: GraphEnvironment) {}

  /** List detached saved graphs.
   * @returns current graph catalog.
   */
  listGraphs(): Graph[] { return [...this.domain.table('graphs').entries()].map(([, graph]) => structuredClone(graph)) }
  /** Read a graph without sharing storage objects.
   * @param id - graph identity.
   * @returns graph or undefined.
   */
  getGraph(id: GraphId): Graph | undefined { return structuredClone(this.domain.table('graphs').get(id)) }
  /** Save a validated graph; referenced flows and edges must exist when executed.
   * @param candidate - untrusted graph JSON.
   * @returns detached saved graph.
   */
  async saveGraph(candidate: Graph): Promise<Graph> {
    this.assertOpen()
    const graph = graphSchema.parse(candidate)
    await this.domain.table('graphs').put(graph.id, graph)
    return structuredClone(graph)
  }
  /** Delete a graph only when no active card or saved edge uses it.
   * @param id - graph identity.
   */
  async deleteGraph(id: GraphId): Promise<void> {
    this.assertOpen()
    if (this.active.size || this.listGraphs().some(graph => graph.id !== id && graph.edges.includes(id))) throw new Error('Remove incoming edges and wait for active cards before deleting a graph')
    await this.domain.table('graphs').delete(id)
  }
  /** List durable cards newest first.
   * @returns detached board records.
   */
  listCards(): Card[] { return [...this.domain.table('cards').entries()].map(([, card]) => structuredClone(card)).sort((a, b) => (b.timeline[0]?.at ?? '').localeCompare(a.timeline[0]?.at ?? '')) }
  /** Read a durable card.
   * @param id - card identity.
   * @returns detached card; unknown ids throw.
   */
  getCard(id: CardId): Card {
    const card = this.domain.table('cards').get(id)
    if (!card) throw new Error(`Unknown card ${id}`)
    return structuredClone(card)
  }
  /** Mark interrupted work for human inspection, without replaying dispatches.
   */
  async recover(): Promise<void> {
    for (const card of this.listCards()) if (['new', 'routing', 'running'].includes(card.state)) {
      card.state = 'needs-you'
      await this.commit(card, 'host', 'interrupted', 'Host stopped; inspect node runs before rerouting.')
    }
  }
  /** Persist a new card before starting routing independently of browser lifetime.
   * @param input - validated title, body, origin, and optional workspace.
   * @returns initial durable card.
   */
  async create(input: CardInput): Promise<Card> {
    this.assertOpen()
    const card: Card = { ...cardInputSchema.parse(input), id: randomUUID() as CardId, state: 'new', hops: 0, costTokens: 0, maxCostTokens: this.environment.config.graphMaxCostTokens, timeline: [] }
    const accepted = this.commit(card, 'inbox', 'created', card.title)
    const initial = structuredClone(card)
    this.launch(card, undefined, accepted)
    await accepted
    return initial
  }
  /** Preview routing without creating a card; model requests are still logged and may consume tokens.
   * @param text - inbox text.
   * @param signal - caller lifetime.
   * @returns preview decision.
   */
  test(text: string, signal: AbortSignal): Promise<CardRoute> {
    return routeCard(text, this.listGraphs(), this.environment.config, this.environment, signal, () => {})
  }
  /** Acknowledge human completion or rejection; never grants production-write authority.
   * @param id - inactive Needs you or failed card.
   * @param approve - true acknowledges human resolution, false rejects.
   * @returns committed board record.
   */
  async decide(id: CardId, approve: boolean): Promise<Card> {
    const card = this.reserve(id)
    try {
      card.state = approve ? 'done' : 'failed'
      card.result = approve ? 'Resolved by You' : 'Rejected by You'
      await this.commit(card, 'you', approve ? 'approved' : 'rejected', card.result)
      return structuredClone(card)
    } finally { this.changing.delete(id) }
  }
  /** Start an explicit route without resetting cumulative hops or cost.
   * @param id - inactive card requiring human review.
   * @param target - known graph, Council, or You.
   * @returns durable queued route.
   */
  async reroute(id: CardId, target: GraphTarget): Promise<Card> {
    const card = this.reserve(id)
    try {
      if (target !== 'you' && target !== 'council' && !this.getGraph(target)) throw new Error(`Unknown graph ${target}`)
      card.route = { target, confidence: 1, reason: 'Explicit human reroute', router: 'rule' }
      card.state = 'new'
      delete card.result
      const accepted = this.commit(card, 'you', 'reroute', target)
      const initial = structuredClone(card)
      this.launch(card, target, accepted)
      await accepted
      return initial
    } finally { this.changing.delete(id) }
  }
  /** Await a card's owned work; does not acknowledge or restart it.
   * @param id - card identity.
   * @returns last durable snapshot.
   */
  async settled(id: CardId): Promise<Card> { await this.active.get(id)?.done; return this.getCard(id) }
  /** Reject new work, cancel active work, and drain before storage closes. */
  async dispose(): Promise<void> {
    this.closing = true
    for (const active of this.active.values()) active.controller.abort(new Error('Host stopping; inspect node runs before rerouting'))
    await Promise.all([...this.active.values()].map(active => active.done))
  }

  private assertOpen(): void { if (this.closing) throw new Error('Graphs is stopping') }
  private reserve(id: CardId): Card {
    this.assertOpen()
    if (this.active.has(id) || this.changing.has(id)) throw new Error('Card is still running or a decision is pending')
    const card = this.getCard(id)
    if (!['needs-you', 'failed'].includes(card.state)) throw new Error('Card does not require a human decision')
    this.changing.add(id)
    return card
  }
  private async commit(card: Card, actor: string, kind: string, text: string): Promise<void> {
    card.timeline.push({ at: new Date().toISOString(), actor, kind, text })
    await this.active.get(card.id)?.checkpoint
    await this.domain.table('cards').put(card.id, structuredClone(card))
  }
  private launch(card: Card, target: GraphTarget | undefined, accepted: Promise<void>): void {
    const active: Active = { card, controller: new AbortController(), done: Promise.resolve(), checkpoint: Promise.resolve() }
    this.active.set(card.id, active)
    if (this.closing) active.controller.abort(new Error('Host stopping'))
    active.done = accepted.then(() => this.execute(active, target)).finally(() => { this.active.delete(card.id) })
    void active.done.catch((error: unknown) => { console.error('Graph card persistence failed', error) })
  }
  private charge(active: Active, tokens: number): Promise<void> {
    active.card.costTokens += tokens
    if (active.card.costTokens >= active.card.maxCostTokens) active.controller.abort(new Error('Card token cap reached'))
    const snapshot = structuredClone(active.card)
    active.checkpoint = active.checkpoint.then(() => this.domain.table('cards').put(snapshot.id, snapshot)).catch((error: unknown) => {
      active.controller.abort(error)
      throw active.controller.signal.reason
    })
    return active.checkpoint
  }
  private async hop(active: Active, actor: string, kind: string, text: string): Promise<void> {
    active.controller.signal.throwIfAborted()
    if (active.card.hops >= 5) { active.controller.abort(new Error('Card hop limit reached (5)')); active.controller.signal.throwIfAborted() }
    active.card.hops++
    await this.commit(active.card, actor, kind, text)
    active.controller.signal.throwIfAborted()
  }
  private async lead(active: Active, graph: Graph, question: string): Promise<{ kind: 'done' | 'bounce'; text: string }> {
    const { card, controller } = active
    card.maxCostTokens = Math.min(card.maxCostTokens, graph.rules.maxCostTokens)
    await this.charge(active, 0)
    controller.signal.throwIfAborted()
    let outcome: { kind: 'done' | 'bounce'; text: string } | undefined
    const check = (): void => { controller.signal.throwIfAborted(); if (outcome) throw new Error('Lead already finished') }
    await this.environment.lead(graph, question, {
      dispatch: async (nodeId, input) => {
        check()
        const node = graph.nodes.find(value => value.id === nodeId)
        if (!node) throw new Error(`Unknown node ${nodeId}`)
        if (!card.workspace) throw new Error('Card workspace is required before dispatch')
        if (productionWrite(JSON.stringify(input), this.environment.config)) throw new Error('Production writes are prohibited')
        await this.hop(active, graph.id, 'dispatch', nodeId)
        let result: string
        try {
          result = await this.environment.dispatch(node, input, card.workspace, card.maxCostTokens - card.costTokens,
            controller.signal, tokens => this.charge(active, tokens))
        }
        catch (error) { controller.abort(error); throw error }
        controller.signal.throwIfAborted()
        await this.commit(card, nodeId, 'result', result)
        return result
      },
      askNode: async (id, prompt) => {
        check()
        if (!graph.edges.includes(id)) throw new Error(`ask_node denied: ${id} is not an edge of ${graph.id}`)
        if (productionWrite(prompt, this.environment.config)) throw new Error('Production writes are prohibited')
        const other = this.getGraph(id)
        if (!other) throw new Error(`Unknown adjacent graph ${id}`)
        await this.hop(active, graph.id, 'ask_node', `${id}: ${prompt}`)
        const result = await this.lead(active, other, prompt)
        if (result.kind === 'bounce') outcome = result
        await this.commit(card, other.id, result.kind, result.text)
        return result.text
      },
      bounce: async (reason) => { check(); await this.hop(active, graph.id, 'bounce', reason); outcome = { kind: 'bounce', text: reason }; return 'Returned to Jev' },
      done: (summary) => { check(); outcome = { kind: 'done', text: summary }; return Promise.resolve('Summary accepted') },
    }, controller.signal, tokens => this.charge(active, tokens))
    controller.signal.throwIfAborted()
    if (!outcome) throw new Error('Lead ended without done or bounce; inspect its session before retrying')
    return outcome
  }
  private async execute(active: Active, explicit?: GraphTarget): Promise<void> {
    const { card, controller } = active
    const timer = setTimeout(() => { controller.abort(new Error('Card deadline reached')) }, this.environment.config.graphTimeoutMs)
    const signal = controller.signal
    try {
      await this.charge(active, 0)
      signal.throwIfAborted()
      const text = `${card.title}\n${card.body}`
      let bounce = ''
      for (;;) {
        signal.throwIfAborted()
        card.state = 'routing'
        await this.commit(card, 'jev', 'routing', bounce || 'Selecting a target')
        card.route = explicit && !productionWrite(text, this.environment.config)
          ? { target: explicit, confidence: 1, reason: 'Explicit human reroute', router: 'rule' }
          : await routeCard(text + (bounce ? `\nLead returned this card: ${bounce}` : ''), this.listGraphs(), this.environment.config, this.environment, signal, tokens => this.charge(active, tokens), card.id)
        explicit = undefined
        signal.throwIfAborted()
        await this.commit(card, card.route.router, 'route', `${card.route.target} (${card.route.confidence}): ${card.route.reason}`)
        if (card.route.target === 'you') { card.state = 'needs-you'; await this.commit(card, 'you', 'waiting', card.route.reason); return }
        card.state = 'running'
        await this.commit(card, card.route.target, 'running', 'Work started')
        if (card.route.target === 'council') {
          card.result = await this.environment.council(text, signal, tokens => this.charge(active, tokens))
        } else {
          const graph = this.getGraph(card.route.target)
          if (!graph) throw new Error(`Graph ${card.route.target} was removed`)
          const result = await this.lead(active, graph, text)
          if (result.kind === 'bounce') { bounce = result.text; continue }
          card.result = result.text
        }
        signal.throwIfAborted()
        card.state = 'done'
        await this.commit(card, card.route.target, 'done', card.result)
        return
      }
    } catch (error) {
      card.state = 'needs-you'
      const reason = String(/usage unavailable/i.test(String(error)) ? error : signal.aborted ? signal.reason : error)
      if (/usage unavailable/i.test(reason)) card.usageUnavailable = true
      if (/council not installed/.test(reason)) card.route = { target: 'you', confidence: 0, reason: 'council not installed', router: 'rule' }
      try { await this.commit(card, 'host', 'needs-you', reason) }
      catch (loggingError) { throw new Error(reason, { cause: loggingError }) }
    } finally { clearTimeout(timer) }
  }
}
