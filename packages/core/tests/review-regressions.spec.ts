import { chmod, mkdir, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { FlowEngine } from '../src/engine.ts'
import { snapshotFiles, writeViolations } from '../src/files.ts'
import type { FlowRun, RunId } from '../src/types.ts'
import { engineHarness, fakeEnvironment, recipe, temp } from './helpers.ts'

function checkpoint(cwd: string): FlowRun {
  const flow = recipe(cwd)
  flow.blocks.unshift({ kind: 'gate', id: 'gate', label: 'Gate' })
  flow.edges.push({ from: 'gate', to: 'build', kind: 'next' })
  const now = new Date().toISOString()
  return { id: 'checkpoint' as RunId, flowId: flow.id, flow, inputs: { task: 'fix' }, state: 'needs-you', attempts: [{ blockId: 'gate', copy: 0, round: 0, state: 'needs-you', startedAt: now, output: '' }], timeline: [], createdAt: now, updatedAt: now, cursor: 0, rounds: {}, outputs: {}, tokens: 0 }
}

it.each([true, false])('reserves cancellation before its checkpoint write and rejects overlapping approval (recovered=%s)', async (recover) => {
  const launch = vi.fn(async () => ({ output: 'done' }))
  const { domain, cwd } = await engineHarness()
  const run = checkpoint(cwd)
  await domain.table('runs').put(run.id, run)
  const recovered = new FlowEngine(domain, fakeEnvironment({ runAgent: launch }))
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  if (recover) await recovered.recover()
  const table = domain.table('runs')
  const put = table.put.bind(table)
  const barrier = vi.spyOn(table, 'put').mockImplementation(async (id, value) => {
    if (value.state === 'cancelled') { entered.resolve(undefined); await release.promise }
    await put(id, value)
  })
  const cancellation = recovered.cancel(run.id)
  try {
    await entered.promise
    expect(recovered.getRun(run.id).state).toBe('needs-you')
    expect(() => recovered.approveGate(run.id, 'gate', true)).toThrow()
  } finally {
    release.resolve(undefined)
    await cancellation
    await recovered.dispose()
    barrier.mockRestore()
  }
  expect(recovered.getRun(run.id).state).toBe('cancelled')
  expect(launch).not.toHaveBeenCalled()
})

it.each(['create', 'delete'] as const)('audits %s of an empty directory outside the write grant', async (operation) => {
  const { engine, cwd } = await engineHarness(fakeEnvironment({ async runAgent(block) {
    const path = join(block.scope.cwd, 'outside')
    if (operation === 'create') await mkdir(path)
    else await rmdir(path)
    return { output: 'done' }
  } }))
  if (operation === 'delete') await mkdir(join(cwd, 'outside'))
  const flow = recipe(cwd)
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  await vi.waitFor(() => { expect(engine.getRun(run.id).state).toBe('failed') })
  expect(engine.getRun(run.id).error).toContain('Write scope violation: outside')
})

it('ignores parent directory timestamps when a granted file changes', async () => {
  const cwd = await temp()
  await mkdir(join(cwd, 'src'))
  const before = await snapshotFiles(cwd)
  await writeFile(join(cwd, 'src/allowed'), 'ok')
  expect(writeViolations(cwd, ['src/allowed'], before, await snapshotFiles(cwd))).toEqual([])
})

it.skipIf(process.platform === 'win32')('audits directory permissions without depending on timestamps', async () => {
  const cwd = await temp()
  await mkdir(join(cwd, 'outside'), { mode: 0o700 })
  const before = await snapshotFiles(cwd)
  await chmod(join(cwd, 'outside'), 0o755)
  expect(writeViolations(cwd, [], before, await snapshotFiles(cwd))).toEqual(['outside'])
})

it.each([0, 30_000])('restores a recovered gate deadline with %i milliseconds remaining', async (remaining) => {
  const { domain, cwd } = await engineHarness()
  const run = checkpoint(cwd)
  await domain.table('runs').put(run.id, run)
  const launch = vi.fn(async () => ({ output: 'done' }))
  const recovered = new FlowEngine(domain, fakeEnvironment({ runAgent: launch }))
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(Date.parse(run.createdAt) + 60_000 - remaining)
  try {
    await recovered.recover()
    if (remaining > 0) {
      expect(recovered.getRun(run.id).state).toBe('needs-you')
      await vi.advanceTimersByTimeAsync(remaining)
    }
    // The domain's notification follows persistence, unlike the timer callback.
    await vi.waitFor(() => { expect(recovered.getRun(run.id).state).toBe('failed') })
    expect(recovered.getRun(run.id).error).toMatch(/time limit exceeded/)
    expect(recovered.getRun(run.id).attempts[0]?.state).toBe('failed')
    expect(launch).not.toHaveBeenCalled()
  } finally { await recovered.dispose(); vi.useRealTimers() }
})
