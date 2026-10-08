/** Durable sequential DAG execution with bounded fan-out, loops and human checkpoints. */
import { randomUUID } from 'node:crypto'
import { type Domain } from './dsh.ts'
import type { Attempt, Block, Flow, FlowId, FlowRun, InputValue, RunId, RunState } from './types.ts'
import { switchboardDomain } from './storage.ts'
import { flowSchema, orderBlocks, renderPrompt, resolveInputs, validateFlow } from './recipe.ts'
import { bindWorkspace } from './workspace.ts'
import { preflight } from './preflight.ts'
import { writeViolations } from './files.ts'
import { outputTail, type ExecutionEnvironment } from './runtime.ts'

interface RunPolicy {
  check(block: Block): Promise<void>
  charge(tokens: number): void | Promise<void>
}
interface ActiveRun {
  controller: AbortController
  done: Promise<void>
  decide?: (approved: boolean) => void
  workspace?: Awaited<ReturnType<typeof bindWorkspace>>
  policy?: RunPolicy
}

/** Owns all live work; storage commits precede observable state changes. */
export class FlowEngine {
  private readonly active = new Map<RunId, ActiveRun>()
  private readonly transitions = new Map<RunId, Promise<void>>()
  private readonly cancellations = new Set<RunId>()
  private stopping = false

  /** @param domain - caller-owned open storage domain.
   * @param environment - current composition execution capabilities.
   */
  constructor(private readonly domain: Domain<typeof switchboardDomain>, readonly environment: ExecutionEnvironment) {}

  /** Durable tool-less router call diary; owned by the existing Switchboard domain. */
  get routerCalls() { return this.domain.table('router_calls') }

  /** Refuse replay of interrupted side effects; restore checkpoint waits and their original deadlines. */
  async recover(): Promise<void> {
    for (const [, saved] of this.domain.table('runs').entries()) {
      if (saved.cancelRequested && ['queued', 'running', 'needs-you'].includes(saved.state)) {
        await this.transition(saved.id, () => this.finishCancellation(structuredClone(saved)))
        continue
      }
      if (saved.state === 'needs-you') {
        const run = structuredClone(saved)
        this.launch(run)
        if (this.remainingTime(run) <= 0) await this.active.get(run.id)?.done
        continue
      }
      if (saved.state !== 'queued' && saved.state !== 'running') continue
      const run = structuredClone(saved)
      run.error = 'Host stopped during execution; start a new run to retry'
      for (const attempt of run.attempts) if (attempt.state === 'running') { attempt.state = 'failed'; attempt.endedAt = new Date().toISOString(); attempt.error = run.error }
      await this.commit(run, 'failed', run.error)
    }
  }

  /** List saved recipes as detached values.
   * @returns saved recipes.
   */
  listFlows(): Flow[] { return [...this.domain.table('flows').entries()].map(([, flow]) => structuredClone(flow)) }
  /** Read a saved recipe.
   * @param id - recipe identity.
   * @returns detached recipe, or undefined.
   */
  getFlow(id: FlowId): Flow | undefined { return structuredClone(this.domain.table('flows').get(id)) }
  /** Save a valid recipe durably.
   * @param candidate - recipe received from the client.
   * @returns detached saved recipe.
   */
  async saveFlow(candidate: Flow): Promise<Flow> {
    const validation = validateFlow(candidate)
    if (!validation.ok) throw new Error(validation.items.map(item => item.message).join('; '))
    const flow = flowSchema.parse(candidate)
    await this.domain.table('flows').put(flow.id, flow)
    return structuredClone(flow)
  }
  /** Delete a saved recipe, retaining every run's embedded recipe.
   * @param id - recipe identity.
   */
  async deleteFlow(id: FlowId): Promise<void> { await this.domain.table('flows').delete(id) }
  /** Read a durable run.
   * @param id - run identity.
   * @returns detached run; unknown ids throw.
   */
  getRun(id: RunId): FlowRun {
    const run = this.domain.table('runs').get(id)
    if (!run) throw new Error(`Unknown run ${id}`)
    return structuredClone(run)
  }
  /** List durable runs newest first.
   * @returns detached records.
   */
  listRuns(): FlowRun[] { return [...this.domain.table('runs').entries()].map(([, run]) => structuredClone(run)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }

  /** Preflight then persist a queued execution before launching background work.
   * @param flowId - saved recipe identity.
   * @param supplied - run inputs.
   * @param id - optional pre-reserved automation firing identity; must be unused.
   * @returns durable queued record; request disconnection does not cancel the run.
   */
  async start(flowId: FlowId, supplied: Record<string, InputValue>, id: RunId = randomUUID() as RunId): Promise<FlowRun> {
    this.assertAccepting()
    const flow = this.getFlow(flowId)
    if (!flow) throw new Error(`Unknown flow ${flowId}`)
    return this.startRecipe(flow, supplied, undefined, id)
  }

  /** Queue a recipe snapshot through the same preflight and executor as a saved Flow.
   * @param flow - recipe snapshot; not saved to the catalog.
   * @param supplied - primitive inputs for this run.
   * @param policy - host-owned launch checks and awaited per-request accounting.
   * @param id - optional pre-reserved automation firing identity; must be unused.
   * @returns durable queued run.
   */
  async startRecipe(
    flow: Flow, supplied: Record<string, InputValue>, policy?: RunPolicy, id: RunId = randomUUID() as RunId,
  ): Promise<FlowRun> {
    this.assertAccepting()
    const flowId = flow.id
    const workspace = await bindWorkspace(flow, resolveInputs(flow, supplied))
    const admission = await preflight(workspace.flow, workspace.inputs, this.environment)
    if (!admission.ok) throw new Error(admission.items.filter(item => item.level === 'error').map(item => `${item.code}: ${item.message}`).join('; '))
    for (const block of workspace.flow.blocks) await workspace.check(block)
    this.assertAccepting()
    if (this.domain.table('runs').get(id)) throw new Error(`Run already exists ${id}`)
    const now = new Date().toISOString()
    const run: FlowRun = { id, flowId, flow: workspace.flow, inputs: workspace.inputs, state: 'queued', attempts: [], timeline: [], createdAt: now, updatedAt: now, cursor: 0, rounds: {}, outputs: {}, tokens: 0 }
    await this.commit(run, 'queued', 'Run queued')
    const queued = structuredClone(run)
    if (this.stopping) { await this.commit(run, 'cancelled', 'Host stopping'); return structuredClone(run) }
    this.launch(run, undefined, workspace, policy)
    return queued
  }

  /** Reserve cancellation before yielding; persist intent and await complete child/process disposal.
   * @param id - run identity.
   * @returns final durable record.
   */
  async cancel(id: RunId): Promise<FlowRun> {
    this.assertAccepting()
    this.getRun(id)
    this.cancellations.add(id)
    try {
      await this.transition(id, async () => {
        await this.domain.table('runs').update(id, run => ['queued', 'running', 'needs-you'].includes(run.state) ? { ...run, cancelRequested: true } : run)
        const active = this.active.get(id)
        if (active) { active.controller.abort(new Error('Run cancelled')); await active.done }
        const run = this.getRun(id)
        if (['queued', 'running', 'needs-you'].includes(run.state)) await this.finishCancellation(run)
      })
      return this.getRun(id)
    } finally { this.cancellations.delete(id) }
  }

  /** Resolve exactly the currently waiting human gate; deny fails the run.
   * @param id - run identity.
   * @param blockId - waiting block identity.
   * @param approve - human decision.
   * @returns decision acceptance (subsequent state arrives through follow/get).
   */
  approveGate(id: RunId, blockId: string, approve: boolean): boolean {
    if (this.stopping) throw new Error('Switchboard is stopping')
    const run = this.getRun(id)
    const current = orderBlocks(run.flow)[run.cursor]
    if (run.cancelRequested || run.state !== 'needs-you' || current !== blockId) throw new Error('Run is not waiting at this gate')
    const active = this.active.get(id)
    if (this.transitions.has(id) || (active && !active.decide)) throw new Error('Gate decision already submitted')
    void this.transition(id, () => {
      const current = this.getRun(id)
      if (this.stopping || this.cancellations.has(id) || current.cancelRequested || current.state !== 'needs-you' || orderBlocks(current.flow)[current.cursor] !== blockId) return
      const owner = this.active.get(id)
      if (owner) {
        if (owner.controller.signal.aborted) return
        const decide = owner.decide
        delete owner.decide
        decide?.(approve)
      } else this.launch(current, approve)
    }).catch((error: unknown) => { console.error('Switchboard gate transition failed', error) })
    return true
  }

  /** Stop owned work and drain transitions before storage closes; reject after commandTimeoutMs. Uncancelled gates remain resumable. */
  async dispose(): Promise<void> {
    this.stopping = true
    // Requested cancellations persist intent in their queue slot before aborting execution.
    for (const [id, active] of this.active) if (!this.cancellations.has(id)) active.controller.abort(new Error('Host stopping'))
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all([...this.transitions.values(), ...[...this.active.values()].map(active => active.done)]),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { reject(new Error('Switchboard shutdown timed out')) }, this.environment.config.commandTimeoutMs) }),
      ])
    } finally { clearTimeout(timeout) }
  }

  private async finishCancellation(run: FlowRun): Promise<void> {
    run.error = 'Run cancelled'
    for (const attempt of run.attempts) if (['queued', 'running', 'needs-you'].includes(attempt.state)) {
      attempt.state = 'cancelled'; attempt.endedAt = new Date().toISOString(); attempt.error = run.error
    }
    await this.commit(run, 'cancelled', run.error)
  }

  private transition(id: RunId, operation: () => void | Promise<void>): Promise<void> {
    // Reserve synchronously: durable state may still describe the preceding checkpoint.
    const previous = this.transitions.get(id) ?? Promise.resolve()
    const pending = previous.then(operation, operation).finally(() => {
      if (this.transitions.get(id) === pending) this.transitions.delete(id)
    })
    this.transitions.set(id, pending)
    return pending
  }

  private remainingTime(run: FlowRun): number {
    const minutes = Math.min(run.flow.limits.maxMinutes ?? Infinity, this.environment.config.maxRunMinutes)
    return minutes * 60_000 - (Date.now() - Date.parse(run.createdAt))
  }

  private assertAccepting(): void {
    if (this.stopping) throw new Error('Switchboard is stopping')
  }

  private launch(run: FlowRun, decision?: boolean, workspace?: Awaited<ReturnType<typeof bindWorkspace>>, policy?: RunPolicy): void {
    const controller = new AbortController()
    const active: ActiveRun = { controller, done: Promise.resolve(), ...(workspace ? { workspace } : {}), ...(policy ? { policy } : {}) }
    this.active.set(run.id, active)
    active.done = this.execute(run, active, decision).finally(() => { this.active.delete(run.id) })
    // The durable final state owns execution errors; storage failure remains visible to waiters.
    void active.done.catch((error: unknown) => {
      // The owner still observes rejection during cancellation/disposal; avoid an unhandled background rejection.
      console.error('Switchboard run persistence failed', error)
    })
  }

  private async commit(run: FlowRun, state: RunState, message: string, blockId?: string): Promise<void> {
    if (this.cancellations.has(run.id)) run.cancelRequested = true
    run.state = state
    run.updatedAt = new Date().toISOString()
    run.timeline.push({ at: run.updatedAt, state, message, ...(blockId === undefined ? {} : { blockId }) })
    await this.domain.table('runs').put(run.id, structuredClone(run))
  }

  private async execute(run: FlowRun, active: ActiveRun, resumedDecision?: boolean): Promise<void> {
    const remaining = this.remainingTime(run)
    const timeout = setTimeout(() => { active.controller.abort(new Error('Run time limit exceeded')) }, Math.max(1, remaining))
    if (remaining <= 0) active.controller.abort(new Error('Run time limit exceeded'))
    const signal = active.controller.signal
    let launched = run.attempts.filter(attempt => run.flow.blocks.find(block => block.id === attempt.blockId)?.kind === 'agent').length
    try {
      const order = orderBlocks(run.flow)
      while (run.cursor < order.length) {
        signal.throwIfAborted()
        const block = run.flow.blocks.find(candidate => candidate.id === order[run.cursor])
        if (!block) throw new Error('Run cursor references a missing block')
        if (block.kind === 'gate') {
          let approved: boolean
          let attempt = run.attempts.findLast(item => item.blockId === block.id && item.state === 'needs-you')
          if (!attempt) { attempt = { blockId: block.id, copy: 0, round: 0, state: 'needs-you', startedAt: new Date().toISOString(), output: '' }; run.attempts.push(attempt) }
          if (resumedDecision !== undefined) { approved = resumedDecision; resumedDecision = undefined }
          else {
            const decision = Promise.withResolvers<boolean>()
            void decision.promise.catch((error: unknown) => { void error }) // Observed below after the durable checkpoint.
            const abort = (): void => { decision.reject(signal.reason) }
            active.decide = decision.resolve
            signal.addEventListener('abort', abort, { once: true })
            try {
              await this.commit(run, 'needs-you', 'Waiting for human approval', block.id)
              signal.throwIfAborted()
              approved = await decision.promise
            } finally { signal.removeEventListener('abort', abort); delete active.decide }
          }
          attempt.state = approved ? 'succeeded' : 'failed'
          attempt.endedAt = new Date().toISOString()
          attempt.output = approved ? 'Approved' : 'Denied'
          if (!approved) throw new Error(`Gate ${block.id} denied`)
          run.outputs[block.id] = attempt.output
          run.cursor++
          await this.commit(run, 'running', 'Gate approved', block.id)
          continue
        }
        const copies = block.kind === 'agent' ? block.copies ?? 1 : 1
        if (block.kind === 'agent') {
          launched += copies
          if (launched > Math.min(this.environment.maxAgents, run.flow.limits.maxHops ?? Infinity)) throw new Error('Agent launch limit exceeded')
        }
        const attempts = await this.runBlock(run, block, active, copies)
        signal.throwIfAborted()
        const failed = attempts.some(attempt => attempt.state === 'failed')
        const refuted = attempts.some(attempt => attempt.refuted ?? /^\s*REFUTED\b/i.test(attempt.output))
        const edge = run.flow.edges.find(candidate => candidate.kind === 'loop' && candidate.from === block.id && (candidate.on === 'failed' ? failed : refuted))
        if (edge) {
          const key = `${edge.from}:${edge.to}`
          const round = run.rounds[key] ?? 0
          if (round >= (edge.maxRounds ?? 0)) throw new Error(`Loop ${key} exhausted ${round} rounds`)
          run.rounds[key] = round + 1
          const target = order.indexOf(edge.to)
          run.cursor = target
          await this.commit(run, 'running', `Loop round ${round + 1}`, block.id)
        } else {
          if (failed) throw new Error(attempts.find(attempt => attempt.error)?.error ?? `Block ${block.id} failed`)
          run.cursor++
          await this.commit(run, 'running', 'Block completed', block.id)
        }
      }
      await this.commit(run, 'succeeded', 'Run completed')
    } catch (error) {
      if (!this.cancellations.has(run.id) && !run.cancelRequested && run.state === 'needs-you' && signal.reason instanceof Error && signal.reason.message === 'Host stopping') return
      run.error = String(error)
      const cancelled = signal.aborted && !(signal.reason instanceof Error && /limit exceeded/.test(signal.reason.message))
      for (const attempt of run.attempts) if (attempt.state === 'queued' || attempt.state === 'running' || attempt.state === 'needs-you') { attempt.state = cancelled ? 'cancelled' : 'failed'; attempt.endedAt = new Date().toISOString(); attempt.error = run.error }
      await this.commit(run, cancelled ? 'cancelled' : 'failed', run.error)
    } finally { clearTimeout(timeout) }
  }

  private async runBlock(run: FlowRun, block: Exclude<Block, { kind: 'gate' }>, active: ActiveRun, copies: number): Promise<Attempt[]> {
    const signal = active.controller.signal
    const workspace = active.workspace ??= await bindWorkspace(run.flow, run.inputs)
    const checkCwd = (): Promise<void> => workspace.check(block)
    await checkCwd()
    const attempts = Array.from({ length: copies }, (_, copy): Attempt => ({ blockId: block.id, copy, round: run.attempts.filter(attempt => attempt.blockId === block.id && attempt.copy === copy).length, state: 'queued', startedAt: new Date().toISOString(), output: '' }))
    run.attempts.push(...attempts)
    await active.policy?.check(block)
    const before = block.kind === 'agent' ? await this.environment.snapshot(block.scope.cwd, signal) : undefined
    const prompt = block.kind === 'agent' ? renderPrompt(block.prompt, run.inputs, run.outputs) : ''
    if (Buffer.byteLength(prompt) > 65_536) throw new Error('Rendered prompt exceeds 64 KiB')
    await this.commit(run, 'running', 'Block started', block.id)
    let cursor = 0
    // One run owns its mutable record; serialize checkpoints even when copies finish together.
    let writes = Promise.resolve()
    const checkpoint = (): Promise<void> => {
      writes = writes.then(() => this.commit(run, 'running', 'Attempt updated', block.id))
      return writes
    }
    const worker = async (): Promise<void> => {
      while (cursor < attempts.length) {
        signal.throwIfAborted()
        const attempt = attempts[cursor++]
        if (!attempt) throw new Error('Missing fan-out attempt')
        attempt.state = 'running'
        attempt.startedAt = new Date().toISOString()
        await checkpoint()
        try {
          await checkCwd()
          signal.throwIfAborted()
          await active.policy?.check(block)
          const result = block.kind === 'agent'
            ? await this.environment.runAgent(block, prompt, signal, async (tokens) => {
              run.tokens += tokens
              if (run.tokens >= (run.flow.limits.maxCostTokens ?? Infinity)) active.controller.abort(new Error('Token limit exceeded'))
              await active.policy?.charge(tokens)
              await checkpoint()
            }, checkCwd)
            : await this.environment.runChecks(block, signal, checkCwd)
          Object.assign(attempt, result)
          attempt.output = outputTail(result.output, this.environment.config.outputBytes)
          attempt.state = signal.aborted ? 'cancelled' : result.error ? 'failed' : 'succeeded'
        } catch (error) {
          if (/usage unavailable/i.test(String(error))) active.controller.abort(error)
          attempt.state = signal.aborted ? 'cancelled' : 'failed'; attempt.error = String(error)
        }
        attempt.endedAt = new Date().toISOString()
        await checkpoint()
      }
    }
    const settled = await Promise.allSettled(Array.from({ length: Math.min(copies, block.kind === 'agent' ? block.concurrency ?? 1 : 1) }, worker))
    let scopeError: string | undefined
    if (before && block.kind === 'agent') {
      const after = await this.environment.snapshot(block.scope.cwd, AbortSignal.timeout(this.environment.config.commandTimeoutMs))
      const violations = writeViolations(block.scope.cwd, block.scope.write, before, after)
      if (violations.length) {
        scopeError = `Write scope violation: ${violations.join(', ')}`
        const first = attempts[0]
        if (first) { first.state = 'failed'; first.error = scopeError }
      }
    }
    run.outputs[block.id] = outputTail(attempts.map(attempt => attempt.output).join('\n\n'), this.environment.config.outputBytes)
    await checkpoint()
    if (scopeError) throw new Error(scopeError)
    const rejection = settled.find(result => result.status === 'rejected')
    if (rejection?.status === 'rejected') throw rejection.reason
    return attempts
  }
}
