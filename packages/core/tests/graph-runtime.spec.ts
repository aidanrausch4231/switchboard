import { readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { textResponse, toolCallResponse } from './fixtures/mock-adapter.ts'
import { FlowEngine } from '../src/engine.ts'
import { graphEnvironment } from '../src/graph-runtime.ts'
import { graphMemory } from '../src/graph-memory.ts'
import { exampleGraphs } from '../src/graph-examples.ts'
import { switchboardDomain } from '../src/storage.ts'
import { engineHarness, fakeEnvironment, recipe, storageContext, temp } from './helpers.ts'
import { runtimeHarness } from './runtime-harness.ts'
import type { LeadActions } from '../src/graphs.ts'
import type { ExecutionEnvironment } from '../src/runtime.ts'

const config = { routerProvider: 'fake', routerModel: 'scripted', fallbackRouterProvider: 'fake', fallbackRouterModel: 'scripted', productionTerms: ['prod'], productionWriteTerms: ['write'], graphMaxCostTokens: 10000, graphTimeoutMs: 10000 }
it.runIf(process.platform === 'linux')('Loader-mounted agent tools stay scoped to the lead, append memory, and dispatch through the real Flow run path', async () => {
  const root = await temp()
  const workspace = await temp()
  const { ctx, environment, adapter } = await runtimeHarness([
    toolCallResponse('read-memory', 'read_memory', {}),
    toolCallResponse('escape-memory', 'append_note', { name: '../outside.md', text: 'forbidden' }),
    toolCallResponse('note', 'append_note', { name: 'billing.md', text: 'Invoices require evidence.' }),
    toolCallResponse('dispatch-node', 'dispatch', { nodeId: 'billing-reader', input: '{"task":"Explain invoice"}' }),
    textResponse('Read-only node result'),
    toolCallResponse('done', 'done', { summary: 'Explained invoice' }), textResponse('Finished'),
  ], 'standard')
  const storage = await storageContext(root)
  const domain = await storage.storageDomain.open(switchboardDomain)
  const engine = new FlowEngine(domain, environment)
  onTestFinished(async () => { await engine.dispose(); await domain.close() })
  // Run writes are emitted by the owning domain context; use that feed in this independent fixture.
  const stop = storage.on('domain/changed', (change) => { ctx.emit('domain/changed', change) })
  onTestFinished(() => { stop() })
  const env = graphEnvironment(ctx, engine, config)
  const graph = exampleGraphs(join(root, 'memory'))[0]!
  graph.lead.provider = 'fake'; graph.lead.model = 'scripted'
  const node = graph.nodes[0]!
  if (node.kind !== 'agent') throw new Error('Expected Billing agent node')
  node.agent.provider = 'fake'; node.agent.model = 'scripted'
  const signal = new AbortController().signal
  const done = vi.fn(async () => 'done')
  const actions: LeadActions = { done, bounce: async () => 'bounce', askNode: async () => 'answer', dispatch: async (_id, input) => env.dispatch(node, input, workspace, 10000, signal, () => {}) }
  await env.lead(graph, 'Explain invoice', actions, signal, () => {})
  expect(done).toHaveBeenCalledWith('Explained invoice')
  expect(adapter.requests[0]?.tools?.map(tool => tool.name).sort()).toEqual(['append_note', 'ask_node', 'bounce', 'dispatch', 'done', 'read_memory'])
  expect(adapter.requests[4]?.tools?.map(tool => tool.name)).not.toContain('dispatch')
  expect(engine.listRuns()).toMatchObject([{ state: 'succeeded', attempts: [{ output: 'Read-only node result' }] }])
  expect(await readFile(join(graph.lead.memoryDir, 'billing.md'), 'utf8')).toBe('Invoices require evidence.\n')
  await expect(readFile(join(root, 'memory/outside.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('dispatch')
  expect([...ctx.agents.list()]).toHaveLength(0)
  expect(adapter.requests[0]?.messages.map(message => ({ role: message.role, content: message.content }))).toMatchSnapshot('lead prompt and tool-visible memory instructions')
})
it('direct routing flushes exact request and answer events without tools or retained agent handles', async () => {
  const { ctx, environment, adapter } = await runtimeHarness([textResponse('{"target":"you","confidence":0.5,"reason":"Uncertain"}')])
  const storage = await storageContext(await temp())
  const domain = await storage.storageDomain.open(switchboardDomain)
  const flows = new FlowEngine(domain, environment)
  onTestFinished(async () => { await flows.dispose(); await domain.close() })
  const flushed: number[] = []
  storage.on('domain/changed', change => { if (change.table === 'router_calls') flushed.push(adapter.requests.length) })
  const env = graphEnvironment(ctx, flows, config)
  const request = { provider: 'fake', model: 'scripted', prompt: 'Route the invoice' }
  const charge = vi.fn()
  expect(await env.call(request, new AbortController().signal, charge)).toContain('Uncertain')
  expect(flushed[0]).toBe(0)
  expect([...flows.routerCalls.entries()].map(([, record]) => record)).toMatchObject([
    { request, answer: { text: '{"target":"you","confidence":0.5,"reason":"Uncertain"}' } },
  ])
  expect(adapter.requests[0]).toMatchObject({ tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }] })
  expect(charge).toHaveBeenCalledTimes(1)
  expect([...ctx.agents.list()]).toHaveLength(0)
})
it.runIf(process.platform === 'linux')('memory rejects linked notes, traversal, non-Markdown files, and complete-result overflow', async () => {
  const root = await temp(); const memory = await graphMemory(join(root, 'memory'), 64)
  await memory.append('note.md', 'Kept')
  expect(await memory.read()).toContain('Kept')
  await expect(memory.append('../escape.md', 'bad')).rejects.toThrow()
  await expect(memory.append('bad.txt', 'bad')).rejects.toThrow()
  await expect(memory.append('note.md', 'x'.repeat(64))).rejects.toThrow('budget')
  await writeFile(join(root, 'outside'), 'private')
  await symlink(join(root, 'outside'), join(root, 'memory/link.md'))
  await expect(memory.append('link.md', 'bad')).rejects.toThrow()
  expect(await readFile(join(root, 'outside'), 'utf8')).toBe('private')
  await memory.append('a.md', 'x'.repeat(40))
  await expect(memory.read()).rejects.toThrow('output budget')
})
it('single-block execution uses scope preflight and refuses cwd escapes and native unmetered nodes before launch', async () => {
  const { engine, ctx, cwd } = await engineHarness()
  const env = graphEnvironment(ctx, engine, config)
  const graph = exampleGraphs(cwd)[0]!
  const node = graph.nodes[0]!
  if (node.kind !== 'agent') throw new Error('fixture')
  node.agent.scope.cwd = join(cwd, '../escape')
  await expect(env.dispatch(node, { task: 'inspect' }, cwd, 1000, new AbortController().signal, () => {})).rejects.toThrow('card workspace')
  node.agent.scope.cwd = '{{inputs.workspace}}'; node.agent.harness = 'claude-code'
  await expect(env.dispatch(node, { task: 'inspect' }, cwd, 1000, new AbortController().signal, () => {})).rejects.toThrow('usage unavailable')
  expect(engine.listRuns()).toHaveLength(0)
})
it('saved Flow nodes use the card workspace input while retaining the saved template', async () => {
  const runAgent = vi.fn<ExecutionEnvironment['runAgent']>(async (_block, _prompt, _signal, charge) => {
    await charge(2)
    return { output: 'done', usage: { inputTokens: 1, outputTokens: 1 } }
  })
  const { engine, ctx, cwd } = await engineHarness(fakeEnvironment({ runAgent }))
  const flow = recipe('{{inputs.workspace}}')
  flow.inputs.push({ name: 'workspace', type: 'path' })
  await engine.saveFlow(flow)
  const charge = vi.fn()
  const env = graphEnvironment(ctx, engine, config)
  await env.dispatch({ id: 'saved', kind: 'flow', description: 'Saved Flow', flowId: flow.id }, { task: 'inspect', workspace: '/ignored' }, cwd, 1000, new AbortController().signal, charge)
  expect(engine.listRuns()).toMatchObject([{ state: 'succeeded', inputs: { task: 'inspect', workspace: await realpath(cwd) }, tokens: 2 }])
  expect(runAgent.mock.calls[0]?.[0].scope.cwd).toBe(await realpath(cwd))
  expect(runAgent.mock.calls[0]?.[1]).toBe('inspect')
  expect(charge).toHaveBeenCalledWith(2)
  expect(engine.getFlow(flow.id)).toEqual(flow)
})
it('native leads fail explicitly without spawning a subagent', async () => {
  const { engine, ctx, cwd } = await engineHarness()
  const env = graphEnvironment(ctx, engine, config)
  const graph = exampleGraphs(cwd)[0]!; graph.lead.harness = 'claude-code'
  const actions: LeadActions = { done: async () => '', bounce: async () => '', dispatch: async () => '', askNode: async () => '' }
  await expect(env.lead(graph, 'Question', actions, new AbortController().signal, () => {})).rejects.toThrow('scoped lead tools')
})
it('missing council and unregistered router fail with actionable diagnostics', async () => {
  const { engine, ctx } = await engineHarness()
  const env = graphEnvironment(ctx, engine, config)
  await expect(env.available('openrouter', 'typesafe/jev-router')).rejects.toThrow('not registered')
  await expect(env.council('Question', new AbortController().signal, () => {})).rejects.toThrow('council not installed')
})
