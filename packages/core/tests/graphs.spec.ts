import { readFile } from 'node:fs/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { GraphEngine, type GraphEnvironment } from '../src/graphs.ts'
import { graphsDomain, graphSchema } from '../src/graph-schema.ts'
import { exampleGraphs } from '../src/graph-examples.ts'
import { routeCard } from '../src/graph-router.ts'
import type { GraphId } from '../src/graph-types.ts'
import { storageContext, temp } from './helpers.ts'

const config: GraphEnvironment['config'] = { routerProvider: 'openrouter', routerModel: 'typesafe/jev-router', fallbackRouterProvider: 'deepseek-official', fallbackRouterModel: 'deepseek-v4-flash', productionTerms: ['prod', 'production'], productionWriteTerms: ['write', 'migrate', 'delete', 'deploy'], graphMaxCostTokens: 1000, graphTimeoutMs: 10000 }
function environment(overrides: Partial<GraphEnvironment> = {}): GraphEnvironment {
  return { config, available: vi.fn(async () => {}), call: vi.fn(async () => '{"target":"billing","confidence":0.95,"reason":"Invoice question"}'),
    lead: vi.fn<GraphEnvironment['lead']>(async (_graph, _question, actions) => { await actions.done('Read-only answer') }),
    dispatch: vi.fn(async () => 'Run test-run started and completed'), council: vi.fn(async () => 'Council ruling'), ...overrides }
}
async function fixture(overrides: Partial<GraphEnvironment> = {}) {
  const root = await temp()
  const ctx = await storageContext(root)
  const domain = await ctx.storageDomain.open(graphsDomain)
  const env = environment(overrides)
  const engine = new GraphEngine(domain, env)
  onTestFinished(async () => { await engine.dispose(); await domain.close() })
  for (const graph of exampleGraphs(root)) await engine.saveGraph(graph)
  const create = async (body = 'Explain this invoice') => {
    const card = await engine.create({ title: 'Invoice question', body, source: 'manual', workspace: root })
    return engine.settled(card.id)
  }
  return { engine, env, domain, create, root }
}
it('rules route production writes to You without contacting either router or lead', async () => {
  const { create, env } = await fixture()
  const card = await create('Please deploy to production')
  expect(card).toMatchObject({ state: 'needs-you', route: { target: 'you', router: 'rule' }, hops: 0 })
  expect(env.call).not.toHaveBeenCalled(); expect(env.lead).not.toHaveBeenCalled()
})
it('low confidence and unknown targets fail closed; valid JSON is retried exactly once', async () => {
  for (const response of ['{"target":"billing","confidence":0.69,"reason":"Unsure"}', '{"target":"missing","confidence":0.99,"reason":"Unknown"}']) {
    const env = environment({ call: vi.fn().mockResolvedValue(response) })
    const result = await routeCard('Invoice', exampleGraphs('/memory'), config, env, new AbortController().signal, () => {})
    expect(result.target).toBe('you')
  }
  const call = vi.fn<GraphEnvironment['call']>().mockResolvedValueOnce('not JSON').mockResolvedValueOnce('{"target":"billing","confidence":0.7,"reason":"Invoice"}')
  const result = await routeCard('Invoice', exampleGraphs('/memory'), config, environment({ call }), new AbortController().signal, () => {})
  expect(result.target).toBe('billing'); expect(call).toHaveBeenCalledTimes(2)
  expect(call.mock.calls[1]?.[0].prompt).toContain('previous response failed validation')
})
it('unavailable Jev uses Flash and includes the exact unavailable route in the decision', async () => {
  const available = vi.fn(async (provider: string) => { if (provider === 'openrouter') throw new Error('unknown model') })
  const { create, env } = await fixture({ available })
  const card = await create()
  expect(card.route).toMatchObject({ target: 'billing', router: 'fallback' })
  expect(card.route?.reason).toContain('openrouter/typesafe/jev-router unavailable')
  expect(env.call).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }), expect.anything(), expect.anything())
})
it('dispatch runs only a listed node with the card workspace and shared budget', async () => {
  const { create, env, root } = await fixture({ lead: async (_graph, _question, actions) => {
    await expect(actions.dispatch('foreign', {})).rejects.toThrow('Unknown node')
    expect(await actions.dispatch('billing-reader', { task: 'Explain invoice' })).toContain('test-run')
    await actions.done('Done with evidence')
  } })
  const card = await create()
  expect(env.dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'billing-reader' }), { task: 'Explain invoice' }, root, 1000, expect.anything(), expect.anything())
  expect(card).toMatchObject({ state: 'done', hops: 1, result: 'Done with evidence' })
  expect(card.timeline.map(event => event.kind)).toEqual(['created', 'routing', 'route', 'running', 'dispatch', 'result', 'done'])
})
it('ask_node enforces directed adjacency; child leads share hops and tokens', async () => {
  const { create } = await fixture({ lead: async (graph, _question, actions, _signal, charge) => {
    await charge(10)
    if (graph.id === 'billing') {
      await expect(actions.askNode('code' as GraphId, 'Question')).rejects.toThrow('not an edge')
      expect(await actions.askNode('research' as GraphId, 'Question')).toBe('Research answer')
      await actions.done('Combined answer')
    } else await actions.done('Research answer')
  } })
  expect(await create()).toMatchObject({ state: 'done', hops: 1, costTokens: 20 })
})
it('bounce disposes the lead before returning to Jev and keeps cumulative hops', async () => {
  let calls = 0
  const { create, env } = await fixture({ lead: async (_graph, _question, actions) => {
    if (calls++ === 0) await actions.bounce('Try again with more context')
    else await actions.done('Second pass')
  } })
  const card = await create()
  expect(card).toMatchObject({ state: 'done', hops: 1 })
  expect(env.call).toHaveBeenCalledTimes(2)
  expect(card.timeline.filter(event => event.kind === 'routing')).toHaveLength(2)
})
it('the sixth bounce stops at Needs you and approval cannot reset or bypass the hop cap', async () => {
  const { create, engine, env } = await fixture({ lead: async (_graph, _question, actions) => { await actions.bounce('Not mine') } })
  const card = await create()
  expect(card).toMatchObject({ state: 'needs-you', hops: 5 })
  expect(card.timeline.at(-1)?.text).toContain('hop limit')
  await engine.reroute(card.id, 'billing' as GraphId)
  expect((await engine.settled(card.id)).hops).toBe(5)
  expect(env.dispatch).not.toHaveBeenCalled()
  expect(await engine.decide(card.id, true)).toMatchObject({ state: 'done', hops: 5, result: 'Resolved by You' })
})
it('router, lead, and dispatch usage share the cap and stop further work', async () => {
  const { create, env } = await fixture({ call: async (_request, _signal, charge) => { await charge(300); return '{"target":"billing","confidence":0.95,"reason":"Invoice"}' },
    lead: async (_graph, _question, actions, _signal, charge) => { await charge(700); await actions.dispatch('billing-reader', {}) } })
  const card = await create()
  expect(card).toMatchObject({ state: 'needs-you', costTokens: 1000 })
  expect(card.timeline.at(-1)?.text).toContain('token cap'); expect(env.dispatch).not.toHaveBeenCalled()
})
it('missing router usage requires You without spending tokens on fallback', async () => {
  const call = vi.fn(async () => { throw new Error('Router usage unavailable') })
  const { create, env } = await fixture({ call })
  expect(await create()).toMatchObject({ state: 'needs-you', usageUnavailable: true })
  expect(call).toHaveBeenCalledTimes(1)
  expect(env.lead).not.toHaveBeenCalled()
})
it.each(['usage unavailable', 'token cap reached'])('terminal card logging retains %s when persistence fails', async (failure) => {
  const { create, domain, env } = await fixture({ call: async (_request, signal, charge) => {
    if (failure === 'usage unavailable') throw new Error('Router usage unavailable')
    await charge(config.graphMaxCostTokens)
    signal.throwIfAborted()
    return 'unreachable'
  } })
  const table = domain.table('cards')
  const put = table.put.bind(table)
  const loggingError = new Error('Terminal card persistence failed')
  const spy = vi.spyOn(table, 'put').mockImplementation(async (id, value) => {
    if (value.state === 'needs-you') throw loggingError
    await put(id, value)
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { spy.mockRestore(); log.mockRestore() })
  await expect(create()).rejects.toThrow(failure)
  expect(log).toHaveBeenCalledWith('Graph card persistence failed', expect.objectContaining({ cause: loggingError }))
  expect(spy.mock.calls.at(-1)?.[1]).toMatchObject({ state: 'needs-you', ...(failure === 'usage unavailable' ? { usageUnavailable: true } : {}) })
  expect(env.lead).not.toHaveBeenCalled()
})

it.each(['usage unavailable', 'token cap reached'])('a rejected usage checkpoint retains %s through card settlement', async (failure) => {
  const { create, domain, env } = await fixture({ lead: async (_graph, _question, _actions, _signal, charge) => {
    try { await charge(failure === 'token cap reached' ? config.graphMaxCostTokens : 1) }
    catch (error) { if (failure === 'usage unavailable') throw new Error('Lead usage unavailable', { cause: error }); throw error }
  } })
  const table = domain.table('cards')
  const put = table.put.bind(table)
  const spy = vi.spyOn(table, 'put').mockImplementation(async (id, value) => {
    if (value.costTokens > 0) throw new Error('Usage checkpoint failed')
    await put(id, value)
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => { spy.mockRestore(); log.mockRestore() })
  await expect(create()).rejects.toThrow(failure)
  expect(env.dispatch).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledTimes(1)
})

it('board human decisions are durable and never execute a production-write card', async () => {
  const { create, engine, env } = await fixture()
  const card = await create('migrate prod')
  await engine.reroute(card.id, 'billing' as GraphId)
  expect(await engine.settled(card.id)).toMatchObject({ state: 'needs-you', route: { target: 'you', router: 'rule' } })
  expect(await engine.decide(card.id, false)).toMatchObject({ state: 'failed', result: 'Rejected by You' })
  expect(env.lead).not.toHaveBeenCalled()
  expect(await engine.decide(card.id, true)).toMatchObject({ state: 'done' })
  await expect(engine.decide(card.id, true)).rejects.toThrow('does not require')
})
it('missing council becomes You, and quick-mode success completes the card', async () => {
  const call = async () => '{"target":"council","confidence":0.9,"reason":"Trade-offs"}'
  const missing = await fixture({ call, council: async () => { throw new Error('council not installed') } })
  expect(await missing.create()).toMatchObject({ state: 'needs-you', route: { target: 'you', reason: 'council not installed' } })
  const present = await fixture({ call })
  expect(await present.create()).toMatchObject({ state: 'done', result: 'Council ruling' })
})
it('restart marks interrupted cards Needs you without launching models', async () => {
  const { domain, engine, env } = await fixture()
  const card = { id: 'interrupted' as import('../src/graph-types.ts').CardId, title: 'Old work', body: '', source: 'manual' as const, state: 'running' as const, hops: 2, costTokens: 100, maxCostTokens: 1000, timeline: [] }
  await domain.table('cards').put(card.id, card)
  await engine.recover()
  expect(engine.getCard(card.id)).toMatchObject({ state: 'needs-you', hops: 2, costTokens: 100 })
  expect(env.call).not.toHaveBeenCalled()
})
it('JSON examples match seeded graphs after binding memory paths', async () => {
  for (const graph of exampleGraphs('/switchboard-memory')) {
    const json: unknown = JSON.parse(await readFile(new URL(`../examples/graphs/${graph.id}.json`, import.meta.url), 'utf8'))
    expect(graphSchema.parse(json)).toEqual(graph)
  }
})
