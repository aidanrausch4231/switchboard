import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Automations } from '../src/automations.ts'
import { nextFire, parseCron } from '../src/cron.ts'
import { automationStats } from '../src/automation-stats.ts'
import { switchboardDomain } from '../src/storage.ts'
import { FlowEngine } from '../src/engine.ts'
import Switchboard from '../src/index.ts'
import { executionEnvironment } from '../src/runtime.ts'
import { harness as presetHarness } from './fixtures/preset-harness.ts'
import { MockAdapter } from './fixtures/mock-adapter.ts'
import type { AutomationId, AutomationRecord, FlowRun, RunId } from '../src/types.ts'
import { engineHarness, fakeEnvironment, recipe, storageContext } from './helpers.ts'

afterEach(() => { vi.useRealTimers() })

it('validates five fields and IANA zones and computes strict calendar successors', () => {
  expect(nextFire('0 2 * * *', 'UTC', '2026-01-01T02:00:00.000Z')).toBe('2026-01-02T02:00:00.000Z')
  expect(nextFire('*/15 9-10 * * 1-5', 'America/New_York', '2026-01-05T14:00:00.000Z')).toBe('2026-01-05T14:15:00.000Z')
  expect(nextFire('0 0 29 2 *', 'UTC', '2025-01-01T00:00:00.000Z')).toBe('2028-02-29T00:00:00.000Z')
  expect(() => parseCron('* * * * * *', 'UTC')).toThrow('five fields')
  expect(() => parseCron('90 * * * *', 'UTC')).toThrow()
  expect(() => parseCron('* * * * *', 'Not/AZone')).toThrow()
  expect(nextFire('0 2 * * *', 'Europe/Berlin', '2026-03-28T01:00:00.000Z')).toBe('2026-03-29T01:00:00.000Z')
  expect(nextFire('30 2 * * *', 'Europe/Berlin', '2026-10-24T00:30:00.000Z')).toBe('2026-10-25T01:30:00.000Z')
})

async function harness() {
  const host = await engineHarness()
  const flow = recipe(host.cwd)
  flow.blocks = [{ id: 'gate', kind: 'gate', label: 'Approval' }]
  await host.engine.saveFlow(flow)
  const scheduler = new Automations(host.domain, host.engine)
  onTestFinished(async () => { await scheduler.dispose() })
  const automation = await scheduler.save({ name: 'Nightly', flowId: flow.id, inputs: {}, schedule: { kind: 'cron', expr: '0 2 * * *', tz: 'UTC' }, enabled: true })
  return { ...host, flow, scheduler, automation }
}

it('catches up many missed times once, then skips an active predecessor without overlap', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const { scheduler, automation, engine, domain } = await harness()
  vi.setSystemTime(new Date('2026-01-05T03:00:00Z'))
  await scheduler.recover()
  await scheduler.tick()
  expect(engine.listRuns()).toHaveLength(1)
  expect(scheduler.get(automation.id).lastFiredAt).toBe('2026-01-05T03:00:00.000Z')
  const [a, b] = await Promise.all([scheduler.runNow(automation.id), scheduler.runNow(automation.id)])
  expect([a.state, b.state]).toEqual(['skipped', 'skipped'])
  expect(domain.table('automations').get(automation.id)?.events.map(event => event.state)).toEqual(['started', 'skipped', 'skipped'])
  expect(engine.listRuns()).toHaveLength(1)
  expect(scheduler.stats(automation.id).runs.map(run => run.state).slice(0, 2)).toEqual(['skipped', 'skipped'])
})

it('serializes simultaneous first firings before either can launch a second run', async () => {
  const { scheduler, automation, engine } = await harness()
  const firings = await Promise.all([scheduler.runNow(automation.id), scheduler.runNow(automation.id)])
  expect(firings.map(event => event.state)).toEqual(['started', 'skipped'])
  expect(engine.listRuns()).toHaveLength(1)
})

it('manual runs ignore the enabled switch, while paused schedules do not catch up on enable', async () => {
  const { scheduler, automation, engine } = await harness()
  await scheduler.setEnabled(automation.id, false)
  await scheduler.tick()
  expect(engine.listRuns()).toHaveLength(0)
  const event = await scheduler.runNow(automation.id)
  expect(event.state).toBe('started')
  expect(scheduler.get(automation.id).enabled).toBe(false)
  await scheduler.setEnabled(automation.id, true)
  expect(scheduler.get(automation.id).lastFiredAt).not.toBeNull()
  expect(() => scheduler.stats(automation.id, 0)).toThrow()
  await expect(scheduler.save({ name: 'Invalid', flowId: automation.flowId, inputs: { task: 1 }, schedule: { kind: 'manual' }, enabled: true })).rejects.toThrow()
  await scheduler.delete(automation.id)
  expect(scheduler.list()).toEqual([])
  expect(engine.listRuns()).toHaveLength(1)
})

it('persists schedules, skip history and original createdAt through JSON close/reopen', async () => {
  const { root, domain, engine, scheduler, automation } = await harness()
  await scheduler.runNow(automation.id)
  await scheduler.runNow(automation.id)
  const { createdAt: _created, lastFiredAt: _last, ...draft } = scheduler.get(automation.id)
  const saved = await scheduler.save({ ...draft, name: 'Renamed' })
  expect(saved.createdAt).toBe(automation.createdAt)
  const before = structuredClone(domain.table('automations').get(automation.id))
  await scheduler.dispose(); await engine.dispose(); await domain.close()
  const reopened = await storageContext(root)
  const fresh = await reopened.storageDomain.open(switchboardDomain)
  expect(fresh.table('automations').get(automation.id)).toEqual(before)
  const executor = new FlowEngine(fresh, fakeEnvironment())
  const schedules = new Automations(fresh, executor)
  onTestFinished(async () => { await schedules.dispose(); await executor.dispose(); await fresh.close() })
  await executor.recover(); await schedules.recover()
  expect((await schedules.runNow(automation.id)).state).toBe('skipped')
})

it('catches up once after reopening a missed persisted schedule', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const { root, domain, engine, scheduler, automation } = await harness()
  await scheduler.dispose(); await engine.dispose(); await domain.close()
  vi.setSystemTime(new Date('2026-01-08T03:00:00Z'))
  const ctx = await storageContext(root)
  const fresh = await ctx.storageDomain.open(switchboardDomain)
  const executor = new FlowEngine(fresh, fakeEnvironment())
  const schedules = new Automations(fresh, executor)
  onTestFinished(async () => { await schedules.dispose(); await executor.dispose(); await fresh.close() })
  await executor.recover(); await schedules.recover(); await schedules.tick()
  expect(executor.listRuns()).toHaveLength(1)
  expect(schedules.get(automation.id).lastFiredAt).toBe('2026-01-08T03:00:00.000Z')
})

it('keeps a restarted catch-up unreserved until its preset and provider are ready', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const { root, cwd, domain, engine, scheduler, automation } = await harness()
  const flow = recipe(cwd)
  const block = flow.blocks[0]!
  if (block.kind !== 'agent') throw new Error('agent fixture required')
  block.provider = 'delayed'; block.model = 'test'
  await engine.saveFlow(flow)
  await scheduler.dispose(); await engine.dispose(); await domain.close()
  vi.setSystemTime(new Date('2026-01-08T03:00:00Z'))
  const ctx = await presetHarness()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const storage = await storageContext(root)
  const fresh = await storage.storageDomain.open(switchboardDomain)
  const real = executionEnvironment(ctx, { ...fakeEnvironment().config, agentPreset: 'delayed' })
  const launch = vi.fn(async () => ({ output: 'APPROVED' }))
  const executor = new FlowEngine(fresh, { ...real, runAgent: launch })
  const schedules = new Automations(fresh, executor)
  onTestFinished(async () => { await schedules.dispose(); await executor.dispose(); await fresh.close() })
  await executor.recover(); await schedules.recover()
  expect(schedules.get(automation.id).lastFiredAt).toBeNull()
  expect(fresh.table('automations').get(automation.id)?.events).toEqual([])
  ctx.effect(() => ctx.agentPresets.register({ id: 'delayed', plugins: [] }))
  await schedules.tick()
  expect(schedules.get(automation.id).lastFiredAt).toBeNull()
  expect(fresh.table('automations').get(automation.id)?.events).toEqual([])
  ctx.effect(() => ctx.llm.registerAdapter(['delayed'], new MockAdapter([])))
  await schedules.tick(); await schedules.tick()
  await vi.waitFor(() => { expect(launch).toHaveBeenCalledTimes(1) })
  expect(executor.listRuns()).toHaveLength(1)
  expect(fresh.table('automations').get(automation.id)?.events.map(event => event.state)).toEqual(['started'])
  expect(schedules.get(automation.id).lastFiredAt).toBe('2026-01-08T03:00:00.000Z')
})

it('retains catch-up when readiness disappears between scheduler and engine preflight', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  let available = true
  const checkAgent = vi.fn(async () => { if (!available) throw new Error('Provider unavailable') })
  const launch = vi.fn(async () => ({ output: 'APPROVED' }))
  const { domain, engine, cwd } = await engineHarness(fakeEnvironment({ checkAgent, runAgent: launch }))
  const flow = recipe(cwd)
  await engine.saveFlow(flow)
  const scheduler = new Automations(domain, engine)
  onTestFinished(async () => { await scheduler.dispose() })
  const automation = await scheduler.save({ name: 'Nightly', flowId: flow.id, inputs: {}, schedule: { kind: 'cron', expr: '0 2 * * *', tz: 'UTC' }, enabled: true })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const start = engine.start.bind(engine)
  const admission = vi.spyOn(engine, 'start').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    return start(...args)
  })
  vi.setSystemTime(new Date('2026-01-08T03:00:00Z'))
  const tick = scheduler.tick()
  try {
    await entered.promise
    expect(checkAgent).toHaveBeenCalledTimes(1)
    expect(domain.table('automations').get(automation.id)?.events[0]?.state).toBe('pending')
    expect(scheduler.get(automation.id).lastFiredAt).toBeNull()
    available = false
  } finally { release.resolve(undefined); await tick }
  expect(checkAgent).toHaveBeenCalledTimes(2)
  expect(scheduler.get(automation.id).lastFiredAt).toBeNull()
  expect(engine.listRuns()).toEqual([])
  expect(launch).not.toHaveBeenCalled()
  expect(admission).toHaveBeenCalledTimes(1)
  expect(domain.table('automations').get(automation.id)?.events[0]?.state).toBe('failed')
  available = true
  vi.setSystemTime(new Date('2026-01-08T03:00:15Z'))
  await scheduler.tick(); await scheduler.tick()
  await vi.waitFor(() => { expect(launch).toHaveBeenCalledTimes(1) })
  expect(engine.listRuns()).toHaveLength(1)
  expect(scheduler.get(automation.id).lastFiredAt).toBe('2026-01-08T03:00:15.000Z')
  expect(domain.table('automations').get(automation.id)?.events.map(event => event.state)).toEqual(['failed', 'started'])
})

it.each([false, true])('consumes an interrupted reservation on recovery when its run exists: %s', async (admitted) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const { domain, engine, scheduler, automation } = await harness()
  vi.setSystemTime(new Date('2026-01-08T03:00:00Z'))
  const id = 'interrupted' as RunId
  const record = domain.table('automations').get(automation.id)!
  await domain.table('automations').put(automation.id, { ...record, events: [{ id, at: new Date().toISOString(), state: 'pending' }] })
  if (admitted) await engine.start(automation.flowId, automation.inputs, id)
  await scheduler.recover(); await scheduler.tick()
  expect(engine.listRuns()).toHaveLength(admitted ? 1 : 0)
  expect(scheduler.get(automation.id).lastFiredAt).toBe('2026-01-08T03:00:00.000Z')
  expect(domain.table('automations').get(automation.id)?.events.map(event => event.state)).toEqual([admitted ? 'started' : 'failed'])
})

it('reports pending admission separately until its FlowRun exists', async () => {
  const { domain, automation, scheduler } = await harness()
  const record = domain.table('automations').get(automation.id)!
  await domain.table('automations').put(automation.id, { ...record, events: [{ id: 'pending' as RunId, at: automation.createdAt, state: 'pending' }] })
  expect(scheduler.stats(automation.id).runs[0]?.state).toBe('pending')
})

it('owns calendar polling in the Host plugin and removes its interval on disposal', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-01-01T01:59:59Z'))
  const { root, domain, engine, scheduler, automation } = await harness()
  await scheduler.dispose(); await engine.dispose(); await domain.close()
  const ctx = await storageContext(root)
  const fiber = ctx.plugin(Switchboard, { automationPollMs: 1000 })
  await fiber.await()
  const board = ctx.switchboard
  expect(board.listRuns()).toHaveLength(0)
  vi.setSystemTime(new Date('2026-01-01T02:00:00Z'))
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => { expect(board.getAutomationStats(automation.id).runs).toHaveLength(1) })
  await fiber.dispose()
  expect(vi.getTimerCount()).toBe(0)
  await expect(board.runAutomationNow(automation.id)).rejects.toThrow('stopping')
})

it('records rejected admission and interrupted reservation rather than retrying side effects', async () => {
  const { scheduler, automation, engine, domain } = await harness()
  await engine.deleteFlow(automation.flowId)
  const failed = await scheduler.runNow(automation.id)
  expect(failed.state).toBe('failed')
  expect(failed.error).toContain('Unknown flow')
  const record = domain.table('automations').get(automation.id)!
  await domain.table('automations').put(automation.id, { ...record, events: [...record.events, { id: 'interrupted' as RunId, at: new Date().toISOString(), state: 'pending' }] })
  await scheduler.recover()
  expect(scheduler.stats(automation.id).runs[0]?.state).toBe('failed')
  expect(engine.listRuns()).toHaveLength(0)
  await scheduler.dispose()
  await expect(scheduler.runNow(automation.id)).rejects.toThrow('stopping')
})

it('folds latest loop rounds, failures, unreached blocks and common stop locations', () => {
  const flow = recipe('/tmp')
  flow.blocks.push({ kind: 'gate', id: 'ship', label: 'Ship' })
  flow.edges = [{ kind: 'next', from: 'build', to: 'ship' }]
  const at = '2026-01-01T00:00:00.000Z'
  const id = 'run' as RunId
  const run: FlowRun = { id, flowId: flow.id, flow, inputs: {}, state: 'failed', createdAt: at, updatedAt: '2026-01-01T00:01:00.000Z', cursor: 1, tokens: 0, rounds: {}, outputs: {}, timeline: [], attempts: [
    { blockId: 'build', copy: 0, round: 0, state: 'failed', startedAt: at, output: '' },
    { blockId: 'build', copy: 0, round: 1, state: 'succeeded', startedAt: at, output: 'ok' },
    { blockId: 'ship', copy: 0, round: 0, state: 'failed', startedAt: at, output: '' },
  ] }
  const record: AutomationRecord = { automation: { id: 'a' as AutomationId, name: 'a', flowId: flow.id, inputs: {}, schedule: { kind: 'manual' }, enabled: true, createdAt: at, lastFiredAt: at }, events: [{ id, at, state: 'started' }] }
  const stats = automationStats(record, [run], flow, 20, Date.parse(at))
  expect(stats.grid).toEqual([['recovered', 'failed']])
  expect(stats.runs[0]).toMatchObject({ stoppedAtBlock: 'ship', ms: 60_000 })
  expect(stats.blocks).toEqual(['build', 'ship'])
  expect(automationStats(record, [run], undefined, 20, Date.parse(at)).blocks).toEqual(stats.blocks)
  run.attempts[0] = { blockId: 'build', copy: 0, round: 0, state: 'succeeded', refuted: true, startedAt: at, output: 'REFUTED' }
  expect(automationStats(record, [run], flow, 20, Date.parse(at)).grid).toEqual([['recovered', 'failed']])
})
