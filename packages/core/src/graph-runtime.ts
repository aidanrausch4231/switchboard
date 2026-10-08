/** Graph adapters reuse Flow execution, agent scopes, and Council; logging and cleanup retain usage and budget failures. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { type Context } from './dsh.ts'
import { brandString } from './dsh.ts'
import { BlockAssembler, type TokenUsage } from './dsh.ts'
import { type SessionId } from './dsh.ts'
import { type ToolDefinition } from './dsh.ts'
import type { CouncilSessionId } from '@switchboard/council'
import { z } from 'zod'
import type { FlowEngine } from './engine.ts'
import type { GraphEnvironment, LeadActions } from './graphs.ts'
import type { Graph } from './graph-types.ts'
import { graphIdSchema } from './graph-schema.ts'
import { graphMemory } from './graph-memory.ts'
import { inputsSchema, inside } from './recipe.ts'
import { outputTail, usageTokens } from './runtime.ts'
import { bindWorkspace } from './workspace.ts'
import type { Block, Flow, FlowId, FlowRun, InputValue } from './types.ts'

// Council launches background requests before follow() can observe every chair attempt.
const councilRequests = new AsyncLocalStorage<symbol>()

function leadTools(actions: LeadActions, memory: Awaited<ReturnType<typeof graphMemory>>, signal: AbortSignal): ToolDefinition[] {
  const text = z.string().min(1).max(32768)
  const output: ToolDefinition['output'] = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: z.string().parse(value) }] }
  const field = (description: string) => ({ type: 'string' as const, required: true, description })
  const tools: ToolDefinition[] = [
    { name: 'read_memory', description: 'Read the Markdown notes retained by this graph lead.', parameters: {}, output, execute: () => memory.read() },
    { name: 'append_note', description: 'Append a durable Markdown note to this graph’s memory.', parameters: { name: field('Flat filename ending in .md; letters, numbers, underscores, and hyphens only.'), text: field('Markdown to append.') }, output,
      execute: (args) => { const value = z.strictObject({ name: text, text }).parse(args); return memory.append(value.name, value.text) } },
    { name: 'dispatch', description: 'Run one listed node and return its run identity and result. Uses the card workspace.', parameters: { nodeId: field('Node id from this graph.'), input: field('JSON object of Flow input values; workspace is supplied by the card.') }, output,
      execute: (args) => {
        const value = z.strictObject({ nodeId: text, input: text }).parse(args)
        return actions.dispatch(value.nodeId, inputsSchema.parse(JSON.parse(value.input)))
      } },
    { name: 'ask_node', description: 'Ask an adjacent graph lead a question and wait for its answer. Shares this card’s budget.', parameters: { graphId: field('Graph id from the configured edges.'), question: field('Question for the other lead.') }, output,
      execute: (args) => {
        const value = z.strictObject({ graphId: graphIdSchema, question: text }).parse(args)
        return actions.askNode(value.graphId, value.question)
      } },
    { name: 'bounce', description: 'Return this card to Jev for another routing decision; ends your work on this card.', parameters: { reason: field('Why another destination is needed.') }, output,
      execute: args => actions.bounce(z.strictObject({ reason: text }).parse(args).reason) },
    { name: 'done', description: 'Finish this card with a summary of the work completed.', parameters: { summary: field('Result for the card owner.') }, output,
      execute: args => actions.done(z.strictObject({ summary: text }).parse(args).summary) },
  ]
  // Custom callers cannot overlap memory mutations or finish a lead while another dispatch is pending.
  let queue = Promise.resolve<unknown>(undefined)
  return tools.map(tool => ({ ...tool, presentCall: () => ({ card: 'generic', title: tool.name, kind: 'other' }), execute: (args, exec) => {
    const pending = queue.then(() => { signal.throwIfAborted(); return tool.execute(args, exec) })
    queue = pending.catch((error: unknown) => { void error })
    return pending
  } }))
}

async function bindCardWorkspace(flow: Flow, workspace: string): Promise<{ flow: Flow; check(block: Block): Promise<void> }> {
  const bound = structuredClone(flow)
  for (const block of bound.blocks) {
    if (block.kind === 'gate') continue
    const path = block.kind === 'agent' ? block.scope.cwd : block.cwd
    const template = path.match(/^{{inputs\.workspace}}(?:[/\\](.*))?$/)
    // The two Phase-one examples declare /workspace; only their run snapshot is rebound.
    const example = ['fix-bug-with-review', 'company-research'].includes(flow.id) && path === '/workspace'
    const cwd = template ? resolve(workspace, template[1] ?? '.') : example ? workspace : path
    if (!isAbsolute(cwd) || !inside(workspace, cwd)) throw new Error('Node cwd must stay inside the card workspace')
    if (block.kind === 'agent') block.scope.cwd = cwd
    else block.cwd = cwd
  }
  return bindWorkspace(bound, { workspace }, workspace)
}

/** Construct adapters without launching work or accessing credentials.
 * @param ctx - Host context.
 * @param flows - existing Flow execution owner.
 * @param config - resolved routing and card limits.
 * @returns externally effectful Graph operations.
 */
export function graphEnvironment(ctx: Context, flows: FlowEngine, config: GraphEnvironment['config']): GraphEnvironment {
  return {
    config,
    async available(provider, model) {
      const llm = ctx.get('llm')
      if (!llm || !llm.listProviders().some(value => value.id === provider)) throw new Error(`Provider ${provider} is not registered`)
      if (!(await llm.listModels(provider)).some(value => value.id === model)) throw new Error(`Model ${model} is not in the ${provider} catalog (remote availability unverified)`)
    },
    async call(request, signal, charge) {
      const agents = ctx.get('agents')
      const sessions = ctx.get('sessions')
      const llm = ctx.get('llm')
      if (!agents || !sessions || !llm) throw new Error('Router needs agents, sessions, and llm services')
      const handle = await agents.create({ sessionId: brandString<SessionId>(`graph-router-${randomUUID()}`), signal })
      let text = ''
      let tokens = 0
      let charged = false
      let requested = false
      let failure: unknown
      const assembler = new BlockAssembler()
      try {
        await flows.routerCalls.put(handle.agent.session.id, { request })
        let finished = false
        requested = true
        for await (const chunk of llm.stream({ provider: request.provider, model: request.model, messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }], tools: [], signal, sessionId: handle.agent.session.id })) {
          signal.throwIfAborted()
          if (finished) throw new Error('Router received data after finish')
          assembler.push(chunk)
          if (chunk.type === 'usage') tokens = usageTokens(chunk.usage)
          if (chunk.type === 'finish') finished = true
        }
        charged = true; await charge(tokens)
        signal.throwIfAborted()
        if (!finished) throw new Error('Router response has no terminal finish')
        if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') throw new Error(assembler.finish.failure.message)
        if (assembler.finish.kind !== 'stop') throw new Error(`Router response incomplete: ${assembler.finish.kind}`)
        text = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        if (!assembler.usage) throw new Error('Router usage unavailable')
        await flows.routerCalls.put(handle.agent.session.id, { request, answer: { text, tokens } })
        return text
      } catch (error) {
        failure = requested && !assembler.usage ? new Error('Router usage unavailable', { cause: error }) : error
        try {
          if (!charged) await charge(tokens)
          await flows.routerCalls.put(handle.agent.session.id, { request, answer: { text, tokens, error: String(failure) } })
        } catch (loggingError) { failure = new Error(String(failure), { cause: loggingError }) }
        throw failure
      } finally {
        try { await handle.dispose() }
        catch (error) { throw failure ?? error }
      }
    },
    async lead(graph: Graph, question, actions, signal, charge) {
      if (graph.lead.harness !== 'dsh') throw new Error('Claude Code leads unavailable: native providers cannot receive these scoped lead tools; select dsh')
      const memory = await graphMemory(graph.lead.memoryDir, flows.environment.config.outputBytes)
      const block = { id: 'lead', kind: 'agent' as const, label: graph.name, harness: 'dsh' as const, ...(graph.lead.provider ? { provider: graph.lead.provider } : {}), ...(graph.lead.model ? { model: graph.lead.model } : {}), prompt: question,
        scope: { cwd: graph.lead.memoryDir, read: [], write: [], commands: [], web: false, sandbox: 'read-only' as const } }
      await flows.environment.checkAgent(block)
      const instructions = `You lead the ${graph.name} graph. Production writes are prohibited. Read your memory before planning. Dispatch only listed nodes. Use done for a finished answer or bounce when this card belongs elsewhere. Dispatch, ask_node and bounce share a five-hop limit and the card token cap.\n${graph.lead.instructions}\nNodes: ${JSON.stringify(graph.nodes.map(node => ({ id: node.id, kind: node.kind, description: node.description, ...(node.kind === 'flow' ? { inputs: flows.getFlow(node.flowId)?.inputs ?? [] } : { prompt: node.agent.prompt }) })))}\nAdjacent leads: ${JSON.stringify(graph.edges)}`
      const result = await flows.environment.runAgent(block, question, signal, charge, async () => {}, {
        tools: leadTools(actions, memory, signal), instructions,
      })
      if (result.error) throw new Error(result.error)
      if (!result.usage) throw new Error('Lead usage unavailable; inspect its session')
    },
    async dispatch(node, input, workspace, budget, signal, charge) {
      signal.throwIfAborted()
      const original: Flow | undefined = node.kind === 'flow' ? flows.getFlow(node.flowId) : {
        id: `graph-node-${node.id}` as FlowId, name: node.description, version: 1,
        inputs: Object.keys(input).map(name => ({ name, type: typeof input[name] as 'string' | 'number' | 'boolean' })), blocks: [node.agent], edges: [], limits: {},
      }
      if (!original) throw new Error(`Unknown saved flow for node ${node.id}`)
      const bound = await bindCardWorkspace(original, workspace)
      const flow = bound.flow
      if (flow.blocks.some(block => block.kind === 'agent' && block.harness !== 'dsh')) throw new Error('Native node usage unavailable; token-capped cards require dsh nodes')
      flow.limits.maxCostTokens = Math.min(flow.limits.maxCostTokens ?? Infinity, budget)
      const supplied: Record<string, InputValue> = { ...input }
      if (flow.inputs.some(value => value.name === 'workspace')) supplied.workspace = await realpath(workspace)
      else delete supplied.workspace
      let wake = (): void => {}
      let changed = false
      const hasChanged = (): boolean => changed
      let run: FlowRun | undefined
      let failure: unknown
      const stop = ctx.on('domain/changed', (change) => { if (change.domain === 'switchboard' && change.table === 'runs' && change.key === run?.id) { changed = true; wake() } })
      const abort = (): void => { wake() }
      signal.addEventListener('abort', abort)
      try {
        run = await flows.startRecipe(flow, supplied, {
          check: async (block) => { signal.throwIfAborted(); await bound.check(block) },
          charge: async (tokens) => { await charge(tokens); signal.throwIfAborted() },
        })
        for (;;) {
          signal.throwIfAborted()
          run = flows.getRun(run.id)
          if (run.state === 'needs-you') throw new Error(`Node run ${run.id} needs human approval; inspect it before rerouting`)
          if (['succeeded', 'failed', 'cancelled'].includes(run.state)) break
          if (!hasChanged()) await new Promise<void>((resolve) => { wake = resolve; if (signal.aborted || hasChanged()) resolve() })
          changed = false
        }
        if (run.state !== 'succeeded') throw new Error(`Node run ${run.id}: ${run.error ?? run.state}`)
        if (run.attempts.some(attempt => flow.blocks.some(block => block.kind === 'agent' && block.id === attempt.blockId) && !attempt.usage)) throw new Error(`Node run ${run.id}: usage unavailable`)
        return outputTail(`Run ${run.id}\n${Object.values(run.outputs).join('\n')}`, flows.environment.config.outputBytes)
      } catch (error) { failure = error; throw error }
      finally {
        try {
          stop(); signal.removeEventListener('abort', abort)
          if (run && !['succeeded', 'failed', 'cancelled'].includes(run.state)) run = await flows.cancel(run.id)
        } catch (error) { throw failure ?? (signal.aborted ? signal.reason : error) }
      }
    },
    async council(question, signal, charge) {
      const council = ctx.get('switchboardCouncil')
      if (!council) throw new Error('council not installed')
      // Native seats cannot report usage, so cannot honor a card token cap.
      const seats = (await council.seats()).filter(seat => seat.available && seat.kind === 'llm').map(seat => seat.id)
      signal.throwIfAborted()
      const owner = Symbol('card-council')
      let id: CouncilSessionId | undefined
      let failure: Error | undefined
      let cancellation: Promise<unknown> | undefined
      const abort = (): void => {
        if (!id) return
        cancellation ??= council.cancel(id)
        void cancellation.catch((error: unknown) => { ctx.logger.error(String(error)) })
      }
      // Async ownership isolates concurrent cards and excludes unrelated Council/agent calls.
      const stop = ctx.on('llm/stream', async function* (_request, next) {
        if (councilRequests.getStore() !== owner) { yield* next(); return }
        signal.throwIfAborted()
        if (failure) throw failure
        let usage: TokenUsage | undefined
        try {
          for await (const chunk of next()) {
            if (chunk.type === 'usage') usage = chunk.usage
            yield chunk
          }
        } finally {
          try {
            if (!usage) throw new Error('Council usage unavailable')
            await charge(usageTokens(usage))
            signal.throwIfAborted()
          } catch (error) { failure ??= new Error(String(error)); abort(); throw error }
        }
      })
      signal.addEventListener('abort', abort, { once: true })
      try {
        id = await councilRequests.run(owner, () => council.ask({ question, mode: 'quick', seatIds: seats }))
        if (signal.aborted || failure) abort()
        for await (const _event of council.follow(id)) {
          signal.throwIfAborted()
          if (failure) throw failure
        }
        signal.throwIfAborted()
        if (failure) throw failure
        const session = council.get(id)
        if (session.state !== 'done' || !session.ruling) throw new Error(session.error ?? 'Council did not finish')
        return session.ruling.ruling
      } catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); throw failure }
      finally {
        try {
          signal.removeEventListener('abort', abort)
          if (id && (signal.aborted || failure || ['queued', 'running'].includes(council.get(id).state))) abort()
          try { await cancellation } finally { stop() }
        } catch (error) { throw failure ?? (signal.aborted ? signal.reason : error) }
      }
    },
  }
}
