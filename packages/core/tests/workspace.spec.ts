import { mkdir, realpath, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import Switchboard, { exampleFlows } from '../src/index.ts'
import { preflight } from '../src/preflight.ts'
import { resolveWorkspace, validateFlow } from '../src/recipe.ts'
import { bindWorkspace } from '../src/workspace.ts'
import type { Flow } from '../src/types.ts'
import { engineHarness, fakeEnvironment, storageContext, temp } from './helpers.ts'

function oldSeed(flow: Flow): Flow {
  return { ...structuredClone(flow), version: 1, inputs: flow.inputs.filter(input => input.name !== 'workspace'),
    blocks: flow.blocks.map(block => block.kind === 'agent' ? { ...block, scope: { ...block.scope, cwd: '/workspace' } } : block.kind === 'checks' ? { ...block, cwd: '/workspace' } : block) }
}

it('preflights both shipped examples against a supplied temporary workspace', async () => {
  const cwd = await temp()
  for (const flow of exampleFlows) {
    expect(flow.inputs).toContainEqual({ name: 'workspace', type: 'path', required: true })
    const result = await preflight(flow, { workspace: cwd, [flow.id === 'company-research' ? 'company' : 'bug']: 'test' }, fakeEnvironment())
    expect(result.items.some(item => item.message.includes('ENOENT'))).toBe(false)
    expect(result.ok).toBe(true)
  }
})

it('resolves workspace cwd and relative subpaths before agent and check execution', async () => {
  const environment = fakeEnvironment()
  const runAgent = vi.fn<typeof environment.runAgent>(async (...args) => environment.runAgent(...args))
  const runChecks = vi.fn<typeof environment.runChecks>(async (...args) => environment.runChecks(...args))
  const { engine, cwd } = await engineHarness(fakeEnvironment({ runAgent, runChecks }))
  await mkdir(join(cwd, 'sub'))
  const flow = structuredClone(exampleFlows[0]!)
  flow.blocks = flow.blocks.filter(block => block.id === 'map' || block.id === 'checks')
  flow.edges = [{ from: 'map', to: 'checks', kind: 'next' }]
  for (const block of flow.blocks) {
    if (block.kind === 'agent') block.scope.cwd = '{{inputs.workspace}}/sub'
    if (block.kind === 'checks') block.cwd = '{{inputs.workspace}}'
  }
  await engine.saveFlow(flow)
  const queued = await engine.start(flow.id, { workspace: cwd, bug: 'test' })
  await vi.waitFor(() => { expect(engine.getRun(queued.id).state).toBe('succeeded') })
  expect(runAgent.mock.calls[0]?.[0].scope.cwd).toBe(join(cwd, 'sub'))
  expect(runChecks.mock.calls[0]?.[0].cwd).toBe(cwd)
  expect(engine.getFlow(flow.id)).toEqual(flow)
})

it.each(['{{inputs.bug}}', '{{blocks.map.output}}', '/tmp/{{inputs.workspace}}', '{{inputs.workspace}}/../escape', '{{inputs.workspace}}/{{inputs.bug}}', '{{inputs.workspace}}//absolute'])('rejects unsupported cwd expression %s', (cwd) => {
  const flow = structuredClone(exampleFlows[0]!)
  const block = flow.blocks[0]!
  if (block.kind !== 'agent') throw new Error('Expected agent')
  block.scope.cwd = cwd
  expect(validateFlow(flow).ok).toBe(false)
})

it('rejects invalid workspace inputs and checks resolved absolute grants before launch', async () => {
  const { engine, cwd } = await engineHarness()
  const flow = structuredClone(exampleFlows[0]!)
  await engine.saveFlow(flow)
  for (const workspace of ['', 'relative', `${cwd}/../escape`, '{{inputs.bug}}', 7]) {
    await expect(engine.start(flow.id, { workspace, bug: 'test' })).rejects.toThrow()
  }
  const block = flow.blocks[0]!
  if (block.kind !== 'agent') throw new Error('Expected agent')
  block.scope.read = [await temp()]
  const result = await preflight(flow, { workspace: cwd, bug: 'test' }, fakeEnvironment())
  expect(result.items.some(item => item.code === 'scope-path')).toBe(true)
  expect(engine.listRuns()).toEqual([])
})

function workspaceFlow(kind: 'agent' | 'checks', cwd = '{{inputs.workspace}}/link'): Flow {
  const flow = structuredClone(exampleFlows[0]!)
  flow.blocks = flow.blocks.filter(block => block.kind === kind).slice(0, 1)
  flow.edges = []
  const block = flow.blocks[0]!
  if (block.kind === 'agent') block.scope.cwd = cwd
  if (block.kind === 'checks') block.cwd = cwd
  return flow
}

it.each(['agent', 'checks'] as const)('rejects %s cwd symlink escapes before admission or queueing', async (kind) => {
  const runAgent = vi.fn(async () => ({ output: 'APPROVED' }))
  const runChecks = vi.fn(async () => ({ output: 'exit=0' }))
  const environment = fakeEnvironment({ runAgent, runChecks })
  const { engine, cwd } = await engineHarness(environment)
  await symlink(await temp(), join(cwd, 'link'), 'junction')
  const flow = workspaceFlow(kind)
  await engine.saveFlow(flow)
  const inputs = { workspace: cwd, bug: 'test' }
  const preview = await preflight(flow, inputs, environment)
  expect(preview.ok).toBe(false)
  expect(preview.items.some(item => /workspace/.test(item.message))).toBe(true)
  await expect(engine.start(flow.id, inputs)).rejects.toThrow(/workspace/)
  expect(engine.listRuns()).toEqual([])
  expect(runAgent).not.toHaveBeenCalled()
  expect(runChecks).not.toHaveBeenCalled()
})

it.each(['agent', 'checks'] as const)('pins a symlinked workspace root to its canonical target for %s', async (kind) => {
  const environment = fakeEnvironment()
  const runAgent = vi.fn<typeof environment.runAgent>(async () => ({ output: 'APPROVED' }))
  const runChecks = vi.fn<typeof environment.runChecks>(async () => ({ output: 'exit=0' }))
  const { engine, cwd } = await engineHarness(fakeEnvironment({ runAgent, runChecks }))
  const alias = join(await temp(), 'workspace')
  await symlink(cwd, alias, 'junction')
  const flow = workspaceFlow(kind, '{{inputs.workspace}}')
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, { workspace: alias, bug: 'test' })
  await vi.waitFor(() => { expect(engine.getRun(run.id).state).toBe('succeeded') })
  const root = await realpath(cwd)
  if (kind === 'agent') expect(runAgent.mock.calls[0]?.[0].scope.cwd).toBe(root)
  else expect(runChecks.mock.calls[0]?.[0].cwd).toBe(root)
})

it.each(['agent', 'checks'] as const)('refuses a changed %s cwd after a human checkpoint', async (kind) => {
  const runAgent = vi.fn(async () => ({ output: 'APPROVED' }))
  const runChecks = vi.fn(async () => ({ output: 'exit=0' }))
  const { engine, cwd } = await engineHarness(fakeEnvironment({ runAgent, runChecks }))
  const first = join(cwd, 'first'); const second = join(cwd, 'second')
  await mkdir(first); await mkdir(second)
  const link = join(cwd, 'link')
  await symlink(first, link, 'junction')
  const flow = workspaceFlow(kind)
  flow.blocks.unshift({ id: 'wait', kind: 'gate', label: 'Wait' })
  flow.edges = [{ from: 'wait', to: flow.blocks[1]!.id, kind: 'next' }]
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, { workspace: cwd, bug: 'test' })
  await vi.waitFor(() => { expect(engine.getRun(run.id).state).toBe('needs-you') })
  await unlink(link); await symlink(second, link, 'junction')
  engine.approveGate(run.id, 'wait', true)
  await vi.waitFor(() => { expect(engine.getRun(run.id).state).toBe('failed') })
  expect(engine.getRun(run.id).error).toMatch(/cwd.*changed/i)
  expect(runAgent).not.toHaveBeenCalled()
  expect(runChecks).not.toHaveBeenCalled()
})

it('confines missing cwd descendants through their nearest existing ancestor', async () => {
  const cwd = await temp()
  await symlink(await temp(), join(cwd, 'link'), 'junction')
  await expect(bindWorkspace(workspaceFlow('checks', '{{inputs.workspace}}/link/not-created/leaf'), { workspace: cwd, bug: 'test' })).rejects.toThrow('cwd escapes workspace')
})

it('rechecks admission before queueing after a path changes during model checks', async () => {
  const cwd = await temp(); const target = join(cwd, 'target'); const link = join(cwd, 'link')
  await mkdir(target); await symlink(target, link, 'junction')
  const outside = await temp()
  const { engine } = await engineHarness(fakeEnvironment({ async checkAgent() {
    await unlink(link); await symlink(outside, link, 'junction')
  } }))
  const flow = workspaceFlow('agent')
  await engine.saveFlow(flow)
  await expect(engine.start(flow.id, { workspace: cwd, bug: 'test' })).rejects.toThrow('cwd changed')
  expect(engine.listRuns()).toEqual([])
})

it('rechecks cwd before each sequential fanout copy', async () => {
  const cwd = await temp(); const first = join(cwd, 'first'); const second = join(cwd, 'second'); const link = join(cwd, 'link')
  await mkdir(first); await mkdir(second); await symlink(first, link, 'junction')
  const runAgent = vi.fn(async () => {
    await unlink(link); await symlink(second, link, 'junction')
    return { output: 'APPROVED' }
  })
  const { engine } = await engineHarness(fakeEnvironment({ runAgent }))
  const flow = workspaceFlow('agent'); const block = flow.blocks[0]!
  if (block.kind !== 'agent') throw new Error('Expected agent')
  block.copies = 2; block.concurrency = 1
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, { workspace: cwd, bug: 'test' })
  await vi.waitFor(() => { expect(engine.getRun(run.id).state).toBe('failed') })
  expect(engine.getRun(run.id).error).toMatch(/cwd.*changed/i)
  expect(runAgent).toHaveBeenCalledTimes(1)
})

it('rejects parent traversal in both binding suffix and workspace input before normalization', () => {
  expect(() => resolveWorkspace(workspaceFlow('agent', '{{inputs.workspace}}/../escape'), { workspace: '/safe' })).toThrow(/traversal/)
  expect(() => resolveWorkspace(workspaceFlow('checks'), { workspace: '/safe/../outside' })).toThrow(/traversal/)
})

it('migrates only unchanged legacy seeds once across host restarts', async () => {
  const root = await temp()
  const ctx = await storageContext(root)
  let fiber = ctx.plugin(Switchboard)
  await fiber.await()
  const untouched = oldSeed(exampleFlows[0]!)
  const edited = { ...oldSeed(exampleFlows[1]!), name: 'My research' }
  await ctx.switchboard.saveFlow(untouched)
  await ctx.switchboard.saveFlow(edited)
  await fiber.dispose()
  fiber = ctx.plugin(Switchboard)
  await fiber.await()
  expect(ctx.switchboard.getFlow(untouched.id)).toEqual(exampleFlows[0])
  expect(ctx.switchboard.getFlow(edited.id)).toEqual(edited)
  await fiber.dispose()
  await ctx.plugin(Switchboard).await()
  expect(ctx.switchboard.getFlow(untouched.id)).toEqual(exampleFlows[0])
  expect(ctx.switchboard.getFlow(edited.id)).toEqual(edited)
})
