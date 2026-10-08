import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { FlowEngine } from '../src/engine.ts'
import { switchboardDomain } from '../src/storage.ts'
import { snapshotFiles, writeViolations } from '../src/files.ts'
import type { FlowRun, RunId, RunState } from '../src/types.ts'
import { engineHarness, fakeEnvironment, recipe, temp } from './helpers.ts'

async function state(engine: FlowEngine, id: RunId, expected: RunState): Promise<FlowRun> {
  await vi.waitFor(() => { expect(engine.getRun(id).state).toBe(expected) })
  return engine.getRun(id)
}

it('pauses at a gate, accepts one approval, and persists a complete round trip', async () => {
  const { engine, domain, ctx, cwd, root } = await engineHarness()
  const flow = recipe(cwd)
  flow.blocks.push({ kind: 'gate', id: 'gate', label: 'You decide' })
  flow.edges.push({ from: 'build', to: 'gate', kind: 'next' })
  await engine.saveFlow(flow)
  const started = await engine.start(flow.id, {})
  expect(started.state).toBe('queued')
  await state(engine, started.id, 'needs-you')
  expect(() => engine.approveGate(started.id, 'wrong', true)).toThrow('not waiting')
  expect(engine.approveGate(started.id, 'gate', true)).toBe(true)
  expect(() => engine.approveGate(started.id, 'gate', true)).toThrow('already submitted')
  const completed = await state(engine, started.id, 'succeeded')
  expect(completed.attempts.map(attempt => attempt.state)).toEqual(['succeeded', 'succeeded'])
  await engine.dispose(); await domain.close()
  const reopened = await ctx.storageDomain.open(switchboardDomain)
  try {
    expect(reopened.table('runs').get(started.id)).toEqual(completed)
    expect(reopened.table('flows').get(flow.id)).toEqual(flow)
    expect(await readFile(join(root, 'switchboard.json'), 'utf8')).toContain('succeeded')
  } finally { await reopened.close() }
})
it('records two approved visits when a loop returns through a gate', async () => {
  const launch = vi.fn().mockResolvedValueOnce({ output: 'REFUTED' }).mockResolvedValue({ output: 'APPROVED' })
  const { engine, cwd } = await engineHarness(fakeEnvironment({ runAgent: launch }))
  const flow = recipe(cwd)
  flow.blocks.unshift({ kind: 'gate', id: 'gate', label: 'You decide' })
  flow.edges.push({ from: 'gate', to: 'build', kind: 'next' }, { from: 'build', to: 'gate', kind: 'loop', on: 'refuted', maxRounds: 1 })
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  await state(engine, run.id, 'needs-you')
  engine.approveGate(run.id, 'gate', true)
  await vi.waitFor(() => { expect(engine.getRun(run.id).attempts.filter(attempt => attempt.blockId === 'gate')).toHaveLength(2) })
  await state(engine, run.id, 'needs-you')
  engine.approveGate(run.id, 'gate', true)
  const completed = await state(engine, run.id, 'succeeded')
  expect(completed.attempts.filter(attempt => attempt.blockId === 'gate').map(attempt => [attempt.round, attempt.state])).toEqual([[0, 'succeeded'], [0, 'succeeded']])
})

it('denial fails a run without launching successors', async () => {
  const launch = vi.fn(async () => ({ output: 'done' }))
  const { engine, cwd } = await engineHarness(fakeEnvironment({ runAgent: launch }))
  const flow = recipe(cwd)
  flow.blocks.unshift({ kind: 'gate', id: 'gate', label: 'You decide' })
  flow.edges.push({ from: 'gate', to: 'build', kind: 'next' })
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  await state(engine, run.id, 'needs-you')
  engine.approveGate(run.id, 'gate', false)
  expect((await state(engine, run.id, 'failed')).error).toContain('denied')
  expect(launch).not.toHaveBeenCalled()
})
it.each(['refuted', 'failed'] as const)('repeats backward segments for %s, at most two extra rounds', async (condition) => {
  const launch = vi.fn(async () => condition === 'refuted' ? { output: 'REFUTED: needs work' } : { output: '', error: 'broken' })
  const { engine, cwd } = await engineHarness(fakeEnvironment({ runAgent: launch }))
  const flow = recipe(cwd)
  flow.blocks.unshift({ kind: 'checks', id: 'start', label: 'Check', cwd, commands: ['true'] })
  flow.edges.push({ from: 'start', to: 'build', kind: 'next' }, { from: 'build', to: 'start', kind: 'loop', on: condition, maxRounds: 2 })
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  const failed = await state(engine, run.id, 'failed')
  expect(launch).toHaveBeenCalledTimes(3)
  expect(failed.rounds).toEqual({ 'build:start': 2 })
  expect(failed.error).toContain('exhausted 2 rounds')
  expect(failed.attempts).toHaveLength(6)
})
it('detects outside-scope additions, modifications, and deletions without reverting them', async () => {
  const cwd = await temp()
  await writeFile(join(cwd, 'old'), 'original')
  await writeFile(join(cwd, 'remove'), 'original')
  const before = await snapshotFiles(cwd)
  await writeFile(join(cwd, 'old'), 'changed')
  await unlink(join(cwd, 'remove'))
  await writeFile(join(cwd, 'new'), 'new')
  expect(writeViolations(cwd, ['new'], before, await snapshotFiles(cwd))).toEqual(['old', 'remove'])
})
it('fails an agent block that writes outside its grant', async () => {
  const { engine, cwd } = await engineHarness(fakeEnvironment({ async runAgent(block) {
    await writeFile(join(block.scope.cwd, 'unexpected'), 'bad')
    return { output: 'done' }
  } }))
  const flow = recipe(cwd); await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  const failed = await state(engine, run.id, 'failed')
  expect(failed.attempts[0]?.error).toContain('Write scope violation: unexpected')
  expect(await readFile(join(cwd, 'unexpected'), 'utf8')).toBe('bad')
})
it('bounds fan-out concurrency and waits for all copies', async () => {
  const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
  let active = 0; let peak = 0
  const { engine, cwd } = await engineHarness(fakeEnvironment({ async runAgent() {
    active++; peak = Math.max(peak, active)
    if (active === 2) entered.resolve(undefined)
    await release.promise
    active--
    return { output: 'done' }
  } }))
  const flow = recipe(cwd); const block = flow.blocks[0]!
  if (block.kind !== 'agent') throw new Error('fixture')
  block.copies = 5; block.concurrency = 2
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  try { await entered.promise; expect(active).toBe(2) } finally { release.resolve(undefined) }
  expect((await state(engine, run.id, 'succeeded')).attempts).toHaveLength(5)
  expect(peak).toBe(2); expect(active).toBe(0)
})
it('cancels active copies and awaits their cleanup before returning', async () => {
  const entered = Promise.withResolvers<undefined>(); let disposed = false
  const { engine, cwd } = await engineHarness(fakeEnvironment({ async runAgent(_block, _prompt, signal) {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () =>{  resolve() }, { once: true }); if (signal.aborted) resolve() })
    disposed = true
    signal.throwIfAborted()
    return { output: '' }
  } }))
  const flow = recipe(cwd); await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  await entered.promise
  const cancelled = await engine.cancel(run.id)
  expect(cancelled.state).toBe('cancelled'); expect(disposed).toBe(true)
  expect(cancelled.attempts[0]?.state).toBe('cancelled')
})
it('charges tokens and aborts on a token cap without starting the next block', async () => {
  const { engine, cwd } = await engineHarness(fakeEnvironment({ async runAgent(_block, _prompt, _signal, charge) {
    await charge(11); return { output: 'done', usage: { inputTokens: 10, outputTokens: 1 } }
  } }))
  const flow = recipe(cwd); flow.limits.maxCostTokens = 10
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  expect((await state(engine, run.id, 'failed')).tokens).toBe(11)
})
it('recovers interrupted runs as failed and resumes a saved human checkpoint', async () => {
  const { domain, environment, engine, cwd } = { ...(await engineHarness()), environment: fakeEnvironment() }
  const flow = recipe(cwd)
  flow.blocks.unshift({ kind: 'gate', id: 'gate', label: 'Gate' }); flow.edges.push({ from: 'gate', to: 'build', kind: 'next' })
  await engine.saveFlow(flow)
  const now = new Date().toISOString()
  const waiting: FlowRun = { id: 'waiting' as RunId, flowId: flow.id, flow, inputs: { task: 'fix' }, state: 'needs-you', attempts: [], timeline: [], createdAt: now, updatedAt: now, cursor: 0, rounds: {}, outputs: {}, tokens: 0 }
  await domain.table('runs').put(waiting.id, waiting)
  await domain.table('runs').put('interrupted' as RunId, { ...waiting, id: 'interrupted' as RunId, state: 'running' })
  const recovered = new FlowEngine(domain, environment)
  try {
    await recovered.recover()
    expect(recovered.getRun('interrupted' as RunId).state).toBe('failed')
    expect(recovered.getRun(waiting.id).state).toBe('needs-you')
    recovered.approveGate(waiting.id, 'gate', true)
    await state(recovered, waiting.id, 'succeeded')
  } finally { await recovered.dispose() }
})
