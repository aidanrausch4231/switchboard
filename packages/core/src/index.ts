/** Switchboard recipes, durable execution, live Remote run updates and credential-isolated speech. */
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { Context, Service } from './dsh.ts'
import { z } from './dsh.ts'
import { Remote, TypertRemoteService } from './dsh.ts'

import { type Domain } from './dsh.ts'
import { layoutDomain, layoutSchema } from './layout.ts'
import { registerRunTool } from './run-tool.ts'
import { FlowEngine } from './engine.ts'
import { Automations } from './automations.ts'
import { exampleFlows } from './examples.ts'
import { switchboardDomain } from './storage.ts'
import { executionEnvironment, type ExecutionConfig } from './runtime.ts'
import { flowSchema, inputsSchema, runIdSchema, validateFlow } from './recipe.ts'
import { preflight } from './preflight.ts'
import type { Automation, AutomationDraft, AutomationEvent, AutomationId, AutomationStats, Flow, FlowId, FlowLayout, FlowRun, InputValue, PingResult, PreflightResult, RunFrame, RunId, VoiceAudio, VoiceResult, VoiceStatus, VoiceTranscript } from './types.ts'
import { VoiceProvider, type VoiceConfig } from './voice.ts'
import { Subscriptions } from './subscriptions.ts'
import { subscriptionAdapter } from './subscriptions-adapter.ts'
import type { SubscriptionFrame, SubscriptionId, SubscriptionList, SubscriptionPromptId, SubscriptionResult } from './subscription-types.ts'
import { GraphEngine, type GraphConfig } from './graphs.ts'
import { graphEnvironment } from './graph-runtime.ts'
import { graphIdSchema, cardIdSchema, graphSchema, graphsDomain, targetSchema } from './graph-schema.ts'
import { exampleGraphs } from './graph-examples.ts'
import { graphMemory } from './graph-memory.ts'
import type { Card, CardFrame, CardId, CardInput, CardRoute, Graph, GraphId, GraphTarget } from './graph-types.ts'

export type * from './types.ts'
export { exampleFlows } from './examples.ts'

const { version } = createRequire(import.meta.url)('@switchboard/core/package.json') as { version: string }

/** Host execution limits and speech defaults, resolved before use. */
export interface Config extends Partial<VoiceConfig>, Partial<GraphConfig> {
  /** Parent folder for newly seeded graph lead memory. */
  graphMemoryRoot?: string
  /** Estimated and actual agent launch ceiling per run. */
  maxAgents?: number
  /** Server calendar polling interval in milliseconds. */
  automationPollMs?: number
  /** Deadline in milliseconds for each check command, Git audit, and Host shutdown wait. */
  commandTimeoutMs?: number
  /** Retained UTF-8 bytes per attempt and combined block, and Git audit output budget. */
  outputBytes?: number
  /** Run deadline in minutes, including human waiting time. */
  maxRunMinutes?: number
  /** Standing composition mounted for each root agent; omission uses the composition default. */
  agentPreset?: string
}

function isAborted(signal: AbortSignal): boolean { return signal.aborted }

declare module '@deepseek-ai/cordis' {
  interface Context { switchboard: Switchboard }
}

/** Host service exposed under the `switchboard` Remote namespace. */
export default class Switchboard extends TypertRemoteService {
  static inject = ['storageDomain', 'timer']
  static Config: z<Config, ExecutionConfig & VoiceConfig & GraphConfig & { automationPollMs: number; graphMemoryRoot: string }> = z.object({
    automationPollMs: z.number().step(1).min(1000).max(60_000).default(15_000),
    routerProvider: z.string().default('openrouter'),
    routerModel: z.string().default('typesafe/jev-router'),
    fallbackRouterProvider: z.string().default('deepseek-official'),
    fallbackRouterModel: z.string().default('deepseek-v4-flash'),
    productionTerms: z.array(z.string()).default(['prod', 'production']),
    productionWriteTerms: z.array(z.string()).default(['write', 'writes', 'migrate', 'migration', 'delete', 'deploy', 'update', 'insert', 'drop', 'apply']),
    graphMaxCostTokens: z.natural().min(1).default(100_000),
    graphTimeoutMs: z.natural().min(1).max(2_147_483_647).default(600_000),
    graphMemoryRoot: z.string().default(resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'switchboard/memory')),
    maxAgents: z.natural().min(1).default(64),
    commandTimeoutMs: z.natural().min(1).default(120_000),
    outputBytes: z.natural().min(32).default(32_768),
    maxRunMinutes: z.number().min(0.001).max(35_000).default(60),
    agentPreset: z.string(),
    sttProvider: z.union(['browser', 'openai']).default('browser'),
    ttsProvider: z.union(['off', 'browser', 'openai']).default('off'),
    transcriptionModel: z.string().default('gpt-4o-transcribe'),
    speechModel: z.string().default('gpt-4o-mini-tts'),
    speechVoice: z.string().default('alloy'),
    maxAudioBytes: z.natural().min(1).max(10 * 1024 * 1024).default(10 * 1024 * 1024),
    maxDurationSeconds: z.number().min(1).max(120).default(60),
    timeoutMs: z.natural().min(1).default(45_000),
  })
  private engine!: FlowEngine
  private automations!: Automations
  private graphs!: GraphEngine
  private readonly config: ExecutionConfig & VoiceConfig & GraphConfig & { automationPollMs: number; graphMemoryRoot: string }
  private readonly voice: VoiceProvider
  private readonly subscriptions: Subscriptions
  private layouts!: Domain<typeof layoutDomain>
  private readonly lifetime = new AbortController()

  /** @param ctx - owning Host context.
   * @param config - deployment execution limits and speech defaults.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'switchboard')
    this.config = Switchboard.Config(config)
    this.voice = new VoiceProvider(this.config)
    this.subscriptions = new Subscriptions(subscriptionAdapter(ctx))
    ctx.effect(() => () => this.subscriptions.dispose(), 'switchboard.subscriptions')
  }

  /** Read subscription credential presence and live route registration, never tokens.
   * @returns safe provider rows or an availability failure.
   */
  @Remote('subscriptions.list')
  listSubscriptions(): Promise<SubscriptionList> { return this.subscriptions.list() }

  /** Run sign-in and enable the catalog route after the grant commits.
   * @param id - subscription provider.
   * @param signal - browser lifetime; closing the stream cancels sign-in.
   * @returns browser links, user codes, questions and safe terminal status.
   */
  @Remote({ mode: 'stream' })
  signInSubscription(id: SubscriptionId, signal: AbortSignal): AsyncIterable<SubscriptionFrame> {
    return this.subscriptions.signIn(id, signal)
  }

  /** Answer a live sign-in question without returning or retaining the answer.
   * @param id - subscription provider.
   * @param promptId - exact live question.
   * @param value - pasted code, redirect URL, domain or offered login method.
   * @returns safe acceptance or refusal.
   */
  @Remote('subscriptions.answer')
  answerSubscription(id: SubscriptionId, promptId: SubscriptionPromptId, value: string): SubscriptionResult {
    return this.subscriptions.answer(id, promptId, value)
  }

  /** Cancel an owned login and delete its stored grant; does not revoke the account at the provider.
   * @param id - subscription provider.
   * @returns safe deletion outcome.
   */
  @Remote('subscriptions.signOut')
  signOutSubscription(id: SubscriptionId): Promise<SubscriptionResult> { return this.subscriptions.signOut(id) }

  /** Add a missing catalog route through live profile settings, retaining other routes.
   * @param id - subscription provider.
   * @returns safe route-enablement outcome.
   */
  @Remote('subscriptions.enableRoute')
  enableSubscriptionRoute(id: SubscriptionId): Promise<SubscriptionResult> { return this.subscriptions.enableRoute(id) }

  /** Read safe speech readiness facts.
   * @returns speech defaults and key presence without credentials.
   */
  @Remote
  voiceStatus(): VoiceStatus { return this.voice.status() }

  /**
   * Transcribe a browser recording without sending a chat message.
   * @param audio - canonical base64 and audio MIME type.
   * @param signal - client cancellation.
   * @returns final transcript or a safe failure message.
   */
  @Remote
  voiceTranscribe(audio: VoiceAudio, signal: AbortSignal): Promise<VoiceResult<VoiceTranscript>> {
    return this.voice.transcribe(audio, signal)
  }

  /**
   * Read final assistant prose aloud using the configured OpenAI voice.
   * @param text - at most 4096 characters of prose.
   * @param signal - client cancellation.
   * @returns MP3 bytes or a safe failure message.
   */
  @Remote
  voiceSpeak(text: string, signal: AbortSignal): Promise<VoiceResult<VoiceAudio>> {
    return this.voice.speak(text, signal)
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(switchboardDomain)
    this.engine = new FlowEngine(domain, executionEnvironment(this.ctx, this.config))
    this.automations = new Automations(domain, this.engine)
    let closeGraphs = async (): Promise<void> => {}
    let stopGraphs = async (): Promise<void> => {}
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      try { await this.automations.dispose() } finally {
        try { await stopGraphs() } finally {
          try { await this.engine.dispose() }
          finally { try { await closeGraphs() } finally { await domain.close() } }
        }
      }
    }, 'switchboard.runs-and-graphs')
    this.layouts = await this.ctx.storageDomain.open(layoutDomain)
    this.ctx.effect(() => () => this.layouts.close(), 'switchboard.layouts')
    const graphDomain = await this.ctx.storageDomain.open(graphsDomain)
    closeGraphs = () => graphDomain.close()
    this.graphs = new GraphEngine(graphDomain, graphEnvironment(this.ctx, this.engine, this.config))
    stopGraphs = () => this.graphs.dispose()
    await this.graphs.recover()
    if (this.graphs.listGraphs().length === 0) {
      for (const graph of exampleGraphs(this.config.graphMemoryRoot)) await this.graphs.saveGraph(graph)
    }
    await this.engine.recover()
    registerRunTool(this.ctx, this)
    const empty = this.engine.listFlows().length === 0
    for (const flow of exampleFlows) {
      const legacy = { ...flow, version: 1, inputs: flow.inputs.filter(input => input.name !== 'workspace'),
        blocks: flow.blocks.map(block => block.kind === 'agent' ? { ...block, scope: { ...block.scope, cwd: '/workspace' } }
          : block.kind === 'checks' ? { ...block, cwd: '/workspace' } : block) }
      if (empty || isDeepStrictEqual(this.engine.getFlow(flow.id), legacy)) await this.engine.saveFlow(flow)
    }
    await this.automations.recover()
    this.ctx.interval(() => {
      void this.automations.tick().catch((error: unknown) => { this.ctx.logger.error(`Automation scheduler: ${String(error)}`) })
    }, this.config.automationPollMs)
  }

  /** List saved schedules.
   * @returns detached automations.
   */
  @Remote('automations.list')
  listAutomations(): Automation[] { return this.automations.list() }

  /** Read a schedule.
   * @param id - automation identity.
   * @returns schedule; unknown identities throw.
   */
  @Remote('automations.get')
  getAutomation(id: AutomationId): Automation { return this.automations.get(id) }

  /** Save editable schedule fields; omitted identity creates a new automation.
   * @param draft - name, saved Flow, inputs and timing.
   * @returns durable schedule.
   */
  @Remote('automations.save')
  saveAutomation(draft: AutomationDraft): Promise<Automation> { return this.automations.save(draft) }

  /** Delete future scheduling without cancelling existing runs.
   * @param id - automation identity.
   */
  @Remote('automations.delete')
  deleteAutomation(id: AutomationId): Promise<void> { return this.automations.delete(id) }

  /** Enable or pause future scheduling; enabling starts from now.
   * @param id - automation identity.
   * @param enabled - timer admission flag.
   * @returns durable schedule.
   */
  @Remote('automations.setEnabled')
  setAutomationEnabled(id: AutomationId, enabled: boolean): Promise<Automation> { return this.automations.setEnabled(id, enabled) }

  /** Trigger a saved Flow even when paused; active predecessors record a skip.
   * @param id - automation identity.
   * @returns durable firing outcome and reserved run identity.
   */
  @Remote('automations.runNow')
  runAutomationNow(id: AutomationId): Promise<AutomationEvent> { return this.automations.runNow(id) }

  /** Read chart data, newest first.
   * @param id - automation identity.
   * @param limit - row count, 1–100; defaults to 20.
   * @returns outcomes, durations and aligned block cells.
   */
  @Remote('automations.stats')
  getAutomationStats(id: AutomationId, limit?: number): AutomationStats { return this.automations.stats(id, limit) }

  /** List saved domain graphs.
   * @returns detached graph catalog.
   */
  @Remote('graphs.list')
  listGraphs(): Graph[] { return this.graphs.listGraphs() }

  /** Read one saved graph.
   * @param id - graph identity.
   * @returns graph or undefined.
   */
  @Remote('graphs.get')
  getGraph(id: GraphId): Graph | undefined { return this.graphs.getGraph(graphIdSchema.parse(id)) }

  /** Read a bounded Markdown memory summary without invoking a model; creates a missing memory folder.
   * @param id - saved graph identity.
   * @returns complete notes within the configured output limit; oversized memory rejects.
   */
  @Remote('graphs.memory')
  async readGraphMemory(id: GraphId): Promise<string> {
    const graph = this.graphs.getGraph(graphIdSchema.parse(id))
    if (!graph) throw new Error(`Unknown graph ${id}`)
    return (await graphMemory(graph.lead.memoryDir, this.config.outputBytes)).read()
  }

  /** Save a graph without launching its lead.
   * @param graph - graph JSON.
   * @returns saved graph.
   */
  @Remote('graphs.save')
  saveGraph(graph: Graph): Promise<Graph> { return this.graphs.saveGraph(graphSchema.parse(graph)) }

  /** Remove an unused graph, retaining card history.
   * @param id - graph identity.
   */
  @Remote('graphs.delete')
  deleteGraph(id: GraphId): Promise<void> { return this.graphs.deleteGraph(graphIdSchema.parse(id)) }

  /** Create an inbox card and launch routing after persistence.
   * @param input - need and optional workspace for node execution.
   * @returns initial durable card.
   */
  @Remote('cards.create')
  createCard(input: CardInput): Promise<Card> { return this.graphs.create(input) }

  /** List inbox cards.
   * @returns newest-first board records.
   */
  @Remote('cards.list')
  listCards(): Card[] { return this.graphs.listCards() }

  /** Read one card.
   * @param id - card identity.
   * @returns durable snapshot.
   */
  @Remote('cards.get')
  getCard(id: CardId): Card { return this.graphs.getCard(cardIdSchema.parse(id)) }

  /** Acknowledge human resolution; never executes production writes.
   * @param id - inactive card requiring review.
   * @returns completed card.
   */
  @Remote('cards.approve')
  approveCard(id: CardId): Promise<Card> { return this.graphs.decide(cardIdSchema.parse(id), true) }

  /** Reject a card without running it.
   * @param id - inactive card requiring review.
   * @returns rejected card.
   */
  @Remote('cards.reject')
  rejectCard(id: CardId): Promise<Card> { return this.graphs.decide(cardIdSchema.parse(id), false) }

  /** Retry a destination without resetting card budgets or bypassing production rules.
   * @param id - inactive card requiring review.
   * @param target - known destination.
   * @returns queued card.
   */
  @Remote('cards.reroute')
  rerouteCard(id: CardId, target: GraphTarget): Promise<Card> {
    return this.graphs.reroute(cardIdSchema.parse(id), targetSchema.parse(target))
  }

  /** Preview routing; no card or node execution is created.
   * @param text - title and body to route.
   * @param signal - caller lifetime.
   * @returns route with explicit provider/model availability failures.
   */
  @Remote('router.test')
  testRouter(text: string, signal: AbortSignal): Promise<CardRoute> {
    if (!text.trim() || text.length > 32768) throw new Error('Router text must contain 1–32768 characters')
    return this.graphs.test(text, AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.config.graphTimeoutMs)]))
  }

  /** Follow the card board; stream methods use undotted names in Typert.
   * @param signal - subscriber lifetime; does not cancel cards.
   * @returns initial board and post-commit replacement snapshots.
   */
  @Remote({ mode: 'stream' })
  async *followCards(signal: AbortSignal): AsyncIterable<CardFrame> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    let wake = (): void => {}
    let changed = false
    const hasChanged = (): boolean => changed
    const aborted = (): boolean => combined.aborted
    const dispose = this.ctx.on('domain/changed', (change) => {
      if (change.domain === 'switchboard_graphs' && change.table === 'cards') { changed = true; wake() }
    })
    const abort = (): void => { wake() }
    combined.addEventListener('abort', abort)
    try {
      combined.throwIfAborted()
      yield { cards: this.listCards() }
      while (!aborted()) {
        if (!hasChanged()) await new Promise<void>((resolve) => { wake = resolve; if (aborted() || hasChanged()) resolve() })
        if (aborted()) return
        changed = false
        yield { cards: this.listCards() }
      }
    } finally { dispose(); combined.removeEventListener('abort', abort) }
  }

  /** Read Host connectivity facts.
   * @returns connectivity status, package version, and Host UTC time.
   */
  @Remote
  ping(): PingResult { return { ok: true, version, time: new Date().toISOString() } }

  /** List saved recipes.
   * @returns detached recipes.
   */
  @Remote('flows.list')
  listFlows(): Flow[] { return this.engine.listFlows() }

  /** Read a saved recipe.
   * @param id - recipe identity.
   * @returns recipe, or undefined.
   */
  @Remote('flows.get')
  getFlow(id: FlowId): Flow | undefined { return this.engine.getFlow(id) }

  /** Save a validated recipe durably.
   * @param flow - recipe JSON.
   * @returns saved recipe.
   */
  @Remote('flows.save')
  saveFlow(flow: Flow): Promise<Flow> { return this.engine.saveFlow(flowSchema.parse(flow)) }

  /** Read editor placement independently of execution data.
   * @param id - recipe identity.
   * @returns saved positions, or an empty layout for automatic placement.
   */
  @Remote('flows.layout.get')
  getLayout(id: FlowId): FlowLayout { return this.layouts.table('layouts').get(id) ?? { positions: [] } }

  /** Persist editor placement without changing a recipe or active run.
   * @param id - saved recipe identity.
   * @param layout - finite canvas coordinates.
   * @returns persisted placement.
   */
  @Remote('flows.layout.save')
  async saveLayout(id: FlowId, layout: FlowLayout): Promise<FlowLayout> {
    if (!this.engine.getFlow(id)) throw new Error('Unknown flow')
    const parsed = layoutSchema.parse(layout)
    await this.layouts.table('layouts').put(id, parsed)
    return parsed
  }

  /** Delete a saved recipe without deleting its runs.
   * @param id - recipe identity.
   */
  @Remote('flows.delete')
  deleteFlow(id: FlowId): Promise<void> { return this.engine.deleteFlow(id) }

  /** Validate a recipe without filesystem or model access.
   * @param flow - candidate recipe.
   * @returns structural diagnostics.
   */
  @Remote('flows.validate')
  validateFlow(flow: Flow): PreflightResult { return validateFlow(flow) }

  /** Check launch admission without creating agents or running commands.
   * @param flow - candidate recipe.
   * @param inputs - supplied inputs.
   * @returns composition and filesystem diagnostics.
   */
  @Remote('flows.preflight')
  preflightFlow(flow: Flow, inputs: Record<string, InputValue>): Promise<PreflightResult> {
    return preflight(flowSchema.parse(flow), inputsSchema.parse(inputs), this.engine.environment)
  }

  /** Queue a saved flow after successful preflight.
   * @param flowId - saved recipe identity.
   * @param inputs - supplied inputs.
   * @returns durable queued run; browser disconnection does not cancel execution.
   */
  @Remote('runs.start')
  startRun(flowId: FlowId, inputs: Record<string, InputValue>): Promise<FlowRun> {
    return this.engine.start(flowId, inputsSchema.parse(inputs))
  }

  /** Read one durable run.
   * @param id - run identity.
   * @returns run; unknown ids throw.
   */
  @Remote('runs.get')
  getRun(id: RunId): FlowRun { return this.engine.getRun(runIdSchema.parse(id)) }

  /** List all durable runs.
   * @returns newest-first records.
   */
  @Remote('runs.list')
  listRuns(): FlowRun[] { return this.engine.listRuns() }

  /** Cancel a run and await child disposal.
   * @param id - run identity.
   * @returns settled run.
   */
  @Remote('runs.cancel')
  cancelRun(id: RunId): Promise<FlowRun> { return this.engine.cancel(runIdSchema.parse(id)) }

  /** Resolve the current human checkpoint.
   * @param id - run identity.
   * @param blockId - waiting gate.
   * @param approve - approval or denial.
   * @returns decision accepted; follow the run for its next durable state.
   */
  @Remote('runs.approveGate')
  approveGate(id: RunId, blockId: string, approve: boolean): boolean {
    return this.engine.approveGate(runIdSchema.parse(id), blockId, approve)
  }

  /** Stream a baseline then durable replacement updates; slow readers coalesce updates without losing timeline entries.
   * @param id - run identity.
   * @param signal - subscriber lifetime; does not cancel the run.
   * @returns baseline and subsequent run updates until cancellation or completion.
   */
  @Remote({ mode: 'stream' })
  async *followRuns(id: RunId, signal: AbortSignal): AsyncIterable<RunFrame> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    let wake = (): void => {}
    const pending = { changed: false }
    const dispose = this.ctx.on('domain/changed', (change) => {
      if (change.domain === 'switchboard' && change.table === 'runs' && change.key === id) { pending.changed = true; wake() }
    })
    const abort = (): void => { wake() }
    combined.addEventListener('abort', abort)
    try {
      let run = this.getRun(id)
      yield { type: 'snapshot', run }
      while (!combined.aborted && !['succeeded', 'failed', 'cancelled'].includes(run.state)) {
        if (!pending.changed) await new Promise<void>((resolve) => { wake = resolve; if (combined.aborted || pending.changed) resolve() })
        // Cancellation can arrive during the subscriber wait.
        if (isAborted(combined)) break
        pending.changed = false
        run = this.getRun(id)
        yield { type: 'update', run }
      }
    } finally { dispose(); combined.removeEventListener('abort', abort) }
  }
}
