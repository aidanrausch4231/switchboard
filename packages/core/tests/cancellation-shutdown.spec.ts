import { expect, it, vi } from 'vitest'
import { FlowEngine } from '../src/engine.ts'
import { switchboardDomain } from '../src/storage.ts'
import { engineHarness, fakeEnvironment, recipe, storageContext } from './helpers.ts'

it.each([false, true])('persists cancellation when shutdown starts in the same turn (recovered=%s)', async (recover) => {
  const launch = vi.fn(async () => ({ output: 'done' }))
  const environment = fakeEnvironment({ runAgent: launch })
  const { engine, domain, root, cwd } = await engineHarness(environment)
  const flow = recipe(cwd)
  flow.blocks.unshift({ kind: 'gate', id: 'gate', label: 'Gate' })
  flow.edges.push({ from: 'gate', to: 'build', kind: 'next' })
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  await vi.waitFor(() => { expect(engine.getRun(run.id).state).toBe('needs-you') })
  let owner = engine
  if (recover) {
    await engine.dispose()
    owner = new FlowEngine(domain, environment)
    await owner.recover()
  }
  const cancellation = owner.cancel(run.id)
  const disposal = owner.dispose()
  try {
    await disposal
    expect((await cancellation).state).toBe('cancelled')
  } finally { await Promise.allSettled([cancellation, disposal]); await owner.dispose() }
  await domain.close()
  const ctx = await storageContext(root)
  const reopened = await ctx.storageDomain.open(switchboardDomain)
  const restarted = new FlowEngine(reopened, environment)
  try {
    expect(restarted.getRun(run.id).state).toBe('cancelled')
    await restarted.recover()
    expect(() => restarted.approveGate(run.id, 'gate', true)).toThrow('not waiting')
    expect(restarted.getRun(run.id).attempts[0]?.state).toBe('cancelled')
    expect(launch).not.toHaveBeenCalled()
  } finally { await restarted.dispose(); await reopened.close() }
})

it.each([false, true])('drains a queued cancellation with a bounded shutdown wait (timeout=%s)', async (expire) => {
  const { engine, domain, cwd } = await engineHarness()
  const flow = recipe(cwd)
  flow.blocks.unshift({ kind: 'gate', id: 'gate', label: 'Gate' })
  flow.edges.push({ from: 'gate', to: 'build', kind: 'next' })
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  await vi.waitFor(() => { expect(engine.getRun(run.id).state).toBe('needs-you') })
  await engine.dispose()
  const owner = new FlowEngine(domain, fakeEnvironment())
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const table = domain.table('runs')
  const put = table.put.bind(table)
  const barrier = vi.spyOn(table, 'put').mockImplementation(async (id, value) => {
    if (value.state === 'cancelled') { entered.resolve(undefined); await release.promise }
    await put(id, value)
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const cancellation = owner.cancel(run.id)
  const disposal = owner.dispose()
  let settled = false
  void disposal.then(() => { settled = true }, () => { settled = true })
  try {
    await entered.promise
    expect(owner.getRun(run.id).cancelRequested).toBe(true)
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
    if (expire) {
      const rejected = expect(disposal).rejects.toThrow('shutdown timed out')
      await vi.advanceTimersByTimeAsync(1)
      await rejected
    } else {
      release.resolve(undefined)
      await disposal
      expect(owner.getRun(run.id).state).toBe('cancelled')
    }
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([cancellation, disposal])
    barrier.mockRestore()
    await owner.dispose()
    vi.useRealTimers()
  }
})

it('recovers a persisted cancellation intent without restoring an approvable gate', async () => {
  const launch = vi.fn(async () => ({ output: 'done' }))
  const { engine, domain, root, cwd } = await engineHarness()
  const flow = recipe(cwd)
  flow.blocks.unshift({ kind: 'gate', id: 'gate', label: 'Gate' })
  flow.edges.push({ from: 'gate', to: 'build', kind: 'next' })
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  await vi.waitFor(() => { expect(engine.getRun(run.id).state).toBe('needs-you') })
  await engine.dispose()
  const interrupted = { ...engine.getRun(run.id), cancelRequested: true }
  await domain.table('runs').put(run.id, interrupted)
  await domain.close()
  const ctx = await storageContext(root)
  const reopened = await ctx.storageDomain.open(switchboardDomain)
  const restarted = new FlowEngine(reopened, fakeEnvironment({ runAgent: launch }))
  try {
    await restarted.recover()
    expect(restarted.getRun(run.id).state).toBe('cancelled')
    expect(restarted.getRun(run.id).attempts[0]?.state).toBe('cancelled')
    expect(() => restarted.approveGate(run.id, 'gate', true)).toThrow('not waiting')
    expect(launch).not.toHaveBeenCalled()
  } finally { await restarted.dispose(); await reopened.close() }
})
