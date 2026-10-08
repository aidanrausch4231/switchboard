import { mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Storage } from '../src/dsh.ts'
import { Persistence } from '../src/dsh.ts'
import { DshStorageJson as JsonStorage } from '../src/dsh.ts'
import { DshStorageDomain as Domain } from '../src/dsh.ts'
import Council, { Config as CouncilConfig } from '../../council/src/index.ts'
import { textResponse, toolCallResponse } from './fixtures/mock-adapter.ts'
import { FlowEngine } from '../src/engine.ts'
import { GraphEngine } from '../src/graphs.ts'
import { graphEnvironment } from '../src/graph-runtime.ts'
import { graphMemory } from '../src/graph-memory.ts'
import { exampleGraphs } from '../src/graph-examples.ts'
import { graphsDomain } from '../src/graph-schema.ts'
import { switchboardDomain } from '../src/storage.ts'
import { engineHarness, storageContext, temp } from './helpers.ts'
import { runtimeHarness } from './runtime-harness.ts'

const config = { routerProvider: 'fake', routerModel: 'scripted', fallbackRouterProvider: 'fake', fallbackRouterModel: 'scripted', productionTerms: ['prod'], productionWriteTerms: ['write'], graphMaxCostTokens: 1000, graphTimeoutMs: 10000 }
const withoutUsage = (response: ReturnType<typeof textResponse>) => response.filter(chunk => chunk.type !== 'usage')

async function realGraph(responses: Parameters<typeof runtimeHarness>[0], realRouter = false) {
  const root = await temp()
  const workspace = await temp()
  const runtime = await runtimeHarness(responses)
  const { ctx, environment } = runtime
  await ctx.plugin(Persistence, { root: join(root, 'sessions') })
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'storage') })
  await ctx.plugin(Domain, { backend: 'json' })
  const domain = await ctx.storageDomain.open(switchboardDomain)
  const cards = await ctx.storageDomain.open(graphsDomain)
  const flows = new FlowEngine(domain, environment)
  const env = graphEnvironment(ctx, flows, config)
  if (realRouter) runtime.adapter.listModels = async () => [{ id: 'scripted', provider: 'fake', name: 'Scripted' }]
  else {
    // Lead and node tests isolate their request accounting from routing.
    env.available = async () => {}
    env.call = async () => '{"target":"billing","confidence":1,"reason":"Invoice"}'
  }
  const graphs = new GraphEngine(cards, env)
  onTestFinished(async () => { await graphs.dispose(); await flows.dispose(); await cards.close(); await domain.close() })
  const graph = exampleGraphs(join(root, 'memory'))[0]!
  graph.lead.provider = 'fake'; graph.lead.model = 'scripted'
  const node = graph.nodes[0]!
  if (node.kind !== 'agent') throw new Error('fixture')
  node.agent.provider = 'fake'; node.agent.model = 'scripted'
  await graphs.saveGraph(graph)
  const create = async () => {
    const card = await graphs.create({ title: 'Invoice', body: 'Explain', source: 'manual', workspace })
    return graphs.settled(card.id)
  }
  return { ...runtime, root, workspace, flows, graphs, cards, env, graph, node, create }
}

it.each(['error', 'aborted', 'incomplete', 'no-finish', 'throw', 'stop'] as const)('an unmetered router %s settles the card without a fallback request', async (failure) => {
  const response: ReturnType<typeof textResponse> = withoutUsage(textResponse('partial')).filter(chunk => chunk.type !== 'finish')
  if (failure === 'error') response.push({ type: 'finish', reason: { kind: 'error', failure: { message: 'Unavailable', code: 'UNKNOWN' } } })
  if (failure === 'aborted') response.push({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'Stopped', code: 'ABORTED' } } })
  if (failure === 'incomplete') response.push({ type: 'finish', reason: { kind: 'max-tokens' } })
  if (failure === 'stop') response.push({ type: 'finish', reason: { kind: 'stop' } })
  const fixture = await realGraph([
    failure === 'throw' ? () => { throw new Error('Provider failed') } : response,
    textResponse('{"target":"you","confidence":1,"reason":"Fallback must not run"}'),
  ], true)
  const card = await fixture.create()
  expect(fixture.adapter.requests).toHaveLength(1)
  expect(card).toMatchObject({ state: 'needs-you', usageUnavailable: true })
  expect(card.timeline.at(-1)?.text).toContain('Router usage unavailable')
  expect(fixture.flows.listRuns()).toHaveLength(0)
  expect([...fixture.ctx.agents.list()]).toHaveLength(0)
})

it('a failed router answer flush cannot permit fallback after an unmetered request', async () => {
  const fixture = await realGraph([
    () => { throw new Error('Provider failed') },
    textResponse('{"target":"you","confidence":1,"reason":"Fallback must not run"}'),
  ], true)
  let flushFailures = 0
  const calls = fixture.flows.routerCalls
  const put = calls.put.bind(calls)
  vi.spyOn(calls, 'put').mockImplementation(async (id, record) => {
    if (record.answer?.error && flushFailures === 0) { flushFailures++; throw new Error('Answer persistence failed') }
    await put(id, record)
  })
  const card = await fixture.create()
  expect(flushFailures).toBe(1)
  expect(fixture.adapter.requests).toHaveLength(1)
  expect(card).toMatchObject({ state: 'needs-you', usageUnavailable: true })
  expect(card.timeline.at(-1)?.text).toContain('Router usage unavailable')
  expect([...fixture.ctx.agents.list()]).toHaveLength(0)
})

it.each(['usage unavailable', 'token cap reached'])('router disposal retains %s after draining the handle', async (failure) => {
  const fixture = await realGraph([failure === 'usage unavailable' ? withoutUsage(textResponse('partial')) : textResponse('partial')], true)
  const create = fixture.ctx.agents.create.bind(fixture.ctx.agents)
  const spy = vi.spyOn(fixture.ctx.agents, 'create').mockImplementation(async (...args) => {
    const handle = await create(...args)
    const dispose = handle.dispose.bind(handle)
    handle.dispose = async () => { await dispose(); throw new Error('Router cleanup failed') }
    return handle
  })
  onTestFinished(() => { spy.mockRestore() })
  await expect(fixture.env.call({ provider: 'fake', model: 'scripted', prompt: 'Route' }, new AbortController().signal, () => {
    if (failure === 'token cap reached') throw new Error('Card token cap reached')
  })).rejects.toThrow(failure)
  expect(fixture.adapter.requests).toHaveLength(1)
  expect([...fixture.ctx.agents.list()]).toHaveLength(0)
})

it('router accounting failure cannot replace missing usage', async () => {
  const fixture = await realGraph([withoutUsage(textResponse('partial'))], true)
  const stop = fixture.ctx.on('llm/stream', async function* (_request, next) {
    yield* next()
    throw new Error('Stream listener failed')
  })
  onTestFinished(() => { stop() })
  const charge = vi.fn(() => { throw new Error('Usage checkpoint failed') })
  await expect(fixture.env.call({ provider: 'fake', model: 'scripted', prompt: 'Route' }, new AbortController().signal, charge)).rejects.toThrow('Router usage unavailable')
  expect(charge).toHaveBeenCalledTimes(1)
  expect(fixture.adapter.requests).toHaveLength(1)
  expect([...fixture.ctx.agents.list()]).toHaveLength(0)
})

it('a router checkpoint failure retains missing usage through cancellation and terminal logging', async () => {
  const fixture = await realGraph([withoutUsage(textResponse('partial'))], true)
  const table = fixture.cards.table('cards')
  const put = table.put.bind(table)
  const spy = vi.spyOn(table, 'put').mockImplementation(async (id, value) => {
    if (fixture.adapter.requests.length) throw new Error('Usage checkpoint failed')
    await put(id, value)
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { spy.mockRestore(); log.mockRestore() })
  await expect(fixture.create()).rejects.toThrow('Router usage unavailable')
  expect(fixture.adapter.requests).toHaveLength(1)
  expect(log).toHaveBeenCalledTimes(1)
  expect([...fixture.ctx.agents.list()]).toHaveLength(0)
})

it('a metered router failure charges its usage before fallback', async () => {
  const response: ReturnType<typeof textResponse> = textResponse('partial').filter(chunk => chunk.type !== 'finish')
  response.push({ type: 'finish', reason: { kind: 'error', failure: { message: 'Unavailable', code: 'UNKNOWN' } } })
  const fallback = '{"target":"you","confidence":1,"reason":"Human review"}'
  const fixture = await realGraph([response, textResponse(fallback)], true)
  const card = await fixture.create()
  expect(card).toMatchObject({ state: 'needs-you', costTokens: 10 + 'partial'.length + 10 + fallback.length, route: { router: 'fallback' } })
  expect(card.usageUnavailable).toBeUndefined()
  expect(fixture.adapter.requests).toHaveLength(2)
})

it.each(['unregistered', 'unavailable'])('a router %s before inference still permits the metered fallback', async (availability) => {
  const fixture = await realGraph([textResponse('{"target":"you","confidence":1,"reason":"Human review"}')], true)
  fixture.env.config = { ...config, routerProvider: availability === 'unregistered' ? 'missing' : 'fake', routerModel: 'missing-model' }
  const card = await fixture.create()
  expect(card).toMatchObject({ state: 'needs-you', route: { target: 'you', router: 'fallback' } })
  expect(card.usageUnavailable).toBeUndefined()
  expect(card.costTokens).toBeGreaterThan(0)
  expect(fixture.adapter.requests).toMatchObject([{ provider: 'fake', model: 'scripted' }])
})

it.each(['darwin', 'win32'] as const)('an unsupported %s memory host stops the card before lead inference', async (platform) => {
  const fixture = await realGraph([toolCallResponse('done', 'done', { summary: 'Must not run' })])
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { value: platform })
    const card = await fixture.create()
    expect(card).toMatchObject({ state: 'needs-you' })
    expect(card.timeline.at(-1)?.text).toContain('Graph memory requires Linux directory-fd access')
    expect(fixture.adapter.requests).toHaveLength(0)
    expect(fixture.flows.listRuns()).toHaveLength(0)
  } finally { Object.defineProperty(process, 'platform', original) }
})

it.runIf(process.platform === 'linux').each(['symlink', 'directory'])('memory refuses a replacement %s without reading or appending outside the authorized inode', async (replacement) => {
  const root = await temp()
  const directory = join(root, 'memory')
  const outside = await temp()
  const memory = await graphMemory(directory, 1024)
  await memory.append('note.md', 'authorized')
  await writeFile(join(outside, 'note.md'), 'private')
  await rename(directory, join(root, 'original'))
  if (replacement === 'symlink') await symlink(outside, directory, 'dir')
  else { await mkdir(directory); await writeFile(join(directory, 'note.md'), 'replacement') }
  await expect(memory.read()).rejects.toThrow()
  await expect(memory.append('note.md', 'escape')).rejects.toThrow()
  expect(await readFile(join(outside, 'note.md'), 'utf8')).toBe('private')
  expect(await readFile(join(root, 'original/note.md'), 'utf8')).toBe('authorized\n')
})

it('node admission rejects an external workspace symlink before creating a run', async () => {
  const { engine, ctx, cwd } = await engineHarness()
  const outside = await temp()
  await symlink(outside, join(cwd, 'linked'), 'dir')
  const node = exampleGraphs(cwd)[0]!.nodes[0]!
  if (node.kind !== 'agent') throw new Error('fixture')
  node.agent.scope.cwd = '{{inputs.workspace}}/linked'
  await expect(graphEnvironment(ctx, engine, config).dispatch(node, { task: 'inspect' }, cwd, 100, new AbortController().signal, () => {})).rejects.toThrow('workspace')
  expect(engine.listRuns()).toHaveLength(0)
})

it('node launch rechecks the admitted symlink binding and never launches a swapped target', async () => {
  const { engine, ctx, cwd } = await engineHarness()
  const outside = await temp()
  const inside = join(cwd, 'inside')
  const linked = join(cwd, 'linked')
  await mkdir(inside)
  await symlink(inside, linked, 'dir')
  const runAgent = vi.fn(async () => ({ output: 'done', usage: { inputTokens: 1, outputTokens: 1 } }))
  engine.environment.runAgent = runAgent
  engine.environment.checkAgent = async () => { await unlink(linked); await symlink(outside, linked, 'dir') }
  const node = exampleGraphs(cwd)[0]!.nodes[0]!
  if (node.kind !== 'agent') throw new Error('fixture')
  node.agent.scope.cwd = '{{inputs.workspace}}/linked'
  await expect(graphEnvironment(ctx, engine, config).dispatch(node, { task: 'inspect' }, cwd, 100, new AbortController().signal, () => {})).rejects.toThrow('Workspace cwd changed')
  expect(runAgent).not.toHaveBeenCalled()
})

it.each(['Node usage unavailable', 'Card token cap reached'])('node cancellation retains %s when cleanup fails', async (message) => {
  const { engine, ctx, cwd } = await engineHarness()
  const controller = new AbortController()
  const failure = new Error(message)
  const start = engine.startRecipe.bind(engine)
  const startSpy = vi.spyOn(engine, 'startRecipe').mockImplementation(async (...args) => {
    const run = await start(...args)
    controller.abort(failure)
    return run
  })
  const cancel = engine.cancel.bind(engine)
  const cancelSpy = vi.spyOn(engine, 'cancel').mockImplementation(async (id) => { await cancel(id); throw new Error('Node cleanup failed') })
  onTestFinished(() => { startSpy.mockRestore(); cancelSpy.mockRestore() })
  const node = exampleGraphs(cwd)[0]!.nodes[0]!
  await expect(graphEnvironment(ctx, engine, config).dispatch(node, { task: 'inspect' }, cwd, 100, controller.signal, () => {})).rejects.toBe(failure)
  expect(cancelSpy).toHaveBeenCalledTimes(1)
  expect(engine.listRuns()).toMatchObject([{ state: 'cancelled' }])
})

it.runIf(process.platform === 'linux')('a lead with metered then unmetered requests stops before dispatch or done', async () => {
  const fixture = await realGraph([
    toolCallResponse('read', 'read_memory', {}),
    withoutUsage(toolCallResponse('dispatch', 'dispatch', { nodeId: 'billing-reader', input: '{"task":"inspect"}' })),
    textResponse('node result'), toolCallResponse('done', 'done', { summary: 'understated' }), textResponse('finished'),
  ])
  expect(await fixture.create()).toMatchObject({ state: 'needs-you', usageUnavailable: true })
  expect(fixture.adapter.requests).toHaveLength(2)
  expect(fixture.flows.listRuns()).toHaveLength(0)
})

it.runIf(process.platform === 'linux')('a node with metered then unmetered requests stops before another tool or inference', async () => {
  const fixture = await realGraph([
    toolCallResponse('dispatch', 'dispatch', { nodeId: 'billing-reader', input: '{"task":"inspect"}' }),
    toolCallResponse('first-read', 'read', { file_path: 'evidence.txt' }),
    withoutUsage(toolCallResponse('second-read', 'read', { file_path: 'forbidden.txt' })),
    textResponse('node result'), toolCallResponse('done', 'done', { summary: 'understated' }), textResponse('finished'),
  ])
  await writeFile(join(fixture.workspace, 'evidence.txt'), 'evidence')
  const executed: string[] = []
  fixture.ctx.on('tools/execute', async (exec, next) => { executed.push(exec.name); return next() })
  const card = await fixture.create()
  expect(card, JSON.stringify(card)).toMatchObject({ state: 'needs-you', usageUnavailable: true })
  expect(fixture.adapter.requests).toHaveLength(3)
  expect(executed.filter(name => name === 'read')).toHaveLength(1)
})

it.runIf(process.platform === 'linux').each([false, true])('usage checkpoint barrier terminates on lead failure (%s) and recovery cannot replenish the card cap', async (failLead) => {
  const fixture = await realGraph([
    failLead ? () => { throw new Error('Lead request failed') } : toolCallResponse('append', 'append_note', { name: 'note.md', text: 'remember' }),
    toolCallResponse('done', 'done', { summary: 'finished' }), textResponse('finished'),
  ])
  const reached = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  fixture.ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'append_note') { reached.resolve(undefined); await release.promise }
    return next()
  })
  const initial = await fixture.graphs.create({ title: 'Invoice', body: '', source: 'manual', workspace: fixture.workspace })
  const settled = fixture.graphs.settled(initial.id)
  try {
    const barrier = Promise.race([reached.promise, settled.then((card) => { throw new Error(`Card settled before append_note: ${card.state}`) })])
    if (failLead) {
      await expect(barrier).rejects.toThrow('Card settled before append_note: needs-you')
      return
    }
    await barrier
    // A separate storage owner observes the persisted checkpoint, not the live card cache.
    const restarted = await storageContext(join(fixture.root, 'storage'))
    const domain = await restarted.storageDomain.open(graphsDomain)
    const lead = vi.fn(async () => {})
    const engine = new GraphEngine(domain, { ...fixture.env, lead })
    try {
      const persisted = engine.getCard(initial.id)
      expect(persisted.costTokens).toBeGreaterThan(0)
      expect(persisted.hops).toBe(0)
      expect(persisted.timeline.some(event => event.kind === 'done')).toBe(false)
      await engine.recover()
      const graph = fixture.graphs.getGraph(fixture.graph.id)!
      graph.rules.maxCostTokens = persisted.costTokens
      await engine.saveGraph(graph)
      await engine.reroute(initial.id, graph.id)
      expect(await engine.settled(initial.id)).toMatchObject({ state: 'needs-you', costTokens: persisted.costTokens })
      expect(lead).not.toHaveBeenCalled()
    } finally { await engine.dispose(); await domain.close() }
  } finally { release.resolve(undefined); await settled }
})

it.each(['cap', 'missing-usage', 'missing-usage-cancel-error'])('Council stops at the settled malformed chair answer on %s before retrying', async (failure) => {
  const fixture = await realGraph([
    textResponse('seat a'), textResponse('seat b'), failure === 'cap' ? textResponse('not JSON') : withoutUsage(textResponse('not JSON')), textResponse('{"ruling":"too late","dissent":[],"confidence":1}'),
  ])
  fixture.adapter.listModels = async () => [{ id: 'scripted', provider: 'fake', name: 'Scripted' }]
  await fixture.ctx.plugin(Council, CouncilConfig({
    seats: ['a', 'b'].map(id => ({ id, label: id, kind: 'llm', provider: 'fake', model: 'scripted', enabled: true })), chair: 'a',
  }))
  const cancel = fixture.ctx.switchboardCouncil.cancel.bind(fixture.ctx.switchboardCouncil)
  const cancelSpy = vi.spyOn(fixture.ctx.switchboardCouncil, 'cancel').mockImplementation(async (id) => {
    const result = await cancel(id)
    if (failure === 'missing-usage-cancel-error') throw new Error('Council cleanup failed')
    return result
  })
  onTestFinished(() => { cancelSpy.mockRestore() })
  fixture.env.call = async () => '{"target":"council","confidence":1,"reason":"Compare"}'
  if (failure === 'cap') fixture.env.config = { ...config, graphMaxCostTokens: 10 * 3 + 'seat a'.length + 'seat b'.length + 'not JSON'.length }
  const card = await fixture.create()
  expect(card, JSON.stringify(card)).toMatchObject({ state: 'needs-you', costTokens: failure === 'cap' ? fixture.env.config.graphMaxCostTokens : 32 })
  if (failure !== 'cap') expect(card.usageUnavailable).toBe(true)
  if (failure === 'missing-usage-cancel-error') expect(cancelSpy).toHaveBeenCalledTimes(1)
  expect(fixture.adapter.requests).toHaveLength(3)
  expect(fixture.ctx.switchboardCouncil.list()[0]?.chairAnswers).toHaveLength(1)
})
