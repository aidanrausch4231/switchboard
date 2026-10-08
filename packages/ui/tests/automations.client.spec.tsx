// @vitest-environment jsdom
import { Context } from '../src/client/dsh.ts'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '../src/client/dsh.ts'
import { SlotRegistry } from '../src/client/dsh.ts'
import { streamMethod } from '../src/client/dsh.ts'
import { TestRemote } from './fixtures/remote.ts'
import { usePinnedBrowserLanguages } from './fixtures/locale-env.ts'
import type { Automation, AutomationDraft, AutomationId, AutomationStats, Flow, FlowId, RunFrame, RunId } from '@switchboard/core/types'
import { AutomationCharts } from '../src/client/AutomationCharts.tsx'
import { AutomationEditor } from '../src/client/AutomationEditor.tsx'
import { AutomationsPage } from '../src/client/AutomationsPage.tsx'
import * as presentation from '../src/client/automation-presentation.tsx'
import { automationEn, automationZh } from '../src/client/automation-locales.ts'

usePinnedBrowserLanguages('en')
afterEach(() => { cleanup(); vi.useRealTimers() })

const flow: Flow = { id: 'flow' as FlowId, name: 'Review flow', version: 1, inputs: [], blocks: [{ id: 'review', kind: 'gate', label: 'Review' }], edges: [], limits: {} }
const automation: Automation = { id: 'automation' as AutomationId, name: 'Nightly review', flowId: flow.id, inputs: {}, schedule: { kind: 'cron', expr: '0 2 * * *', tz: 'UTC' }, enabled: true, createdAt: '2026-01-01T00:00:00.000Z', lastFiredAt: null }
const stats: AutomationStats = {
  runs: [
    { id: 'new' as RunId, state: 'failed', startedAt: '2026-01-03T02:00:00.000Z', ms: 180_000, stoppedAtBlock: 'review' },
    { id: 'old' as RunId, state: 'succeeded', startedAt: '2026-01-02T02:00:00.000Z', ms: 60_000 },
  ], blocks: ['review'], grid: [['failed'], ['recovered']],
}
const ready = async () => ({ ok: true as const, value: { ok: true, items: [{ level: 'ok' as const, code: 'ready', message: 'Ready to run' }] } })
const blocked = async () => ({ ok: true as const, value: { ok: false, items: [{ level: 'error' as const, code: 'cwd', message: 'Workspace directory does not exist' }] } })
function pageApi(): presentation.AutomationsFace['api'] {
  return {
    'automations.list': async () => ({ ok: true, value: [automation] }),
    'flows.list': async () => ({ ok: true, value: [flow] }),
    'flows.preflight': ready,
    'automations.stats': async () => ({ ok: true, value: stats }),
    'automations.save': async () => ({ ok: true, value: automation }),
    'automations.delete': async () => ({ ok: true, value: undefined }),
    'automations.setEnabled': async () => ({ ok: true, value: automation }),
    'automations.runNow': async () => ({ ok: true, value: { id: 'run' as RunId, at: automation.createdAt, state: 'started' } }),
    followRuns: streamMethod(async function* () {}),
  }
}
function translator() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const locale = new LocaleRuntime(ctx)
  locale.register('switchboardAutomations', { en: automationEn, zh: automationZh })
  return locale.bind('switchboardAutomations')
}

it('renders outcome squares, duration points, median and stop grid from fixture statistics', () => {
  const view = render(<AutomationCharts stats={stats} t={translator()} />)
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(screen.getByText('Median 120s')).toBeTruthy()
  expect(view.container.querySelectorAll('svg circle')).toHaveLength(2)
  expect(view.container.querySelector('line[stroke-dasharray]')).not.toBeNull()
  expect(screen.getByRole('img', { name: 'review: Recovered in a later round' })).toBeTruthy()
  expect(screen.getByText(/1 failed runs stopped at review/)).toBeTruthy()
})

it('saves an editor draft and keeps invalid JSON local', async () => {
  const save = vi.fn(async (_draft: AutomationDraft) => ({ ok: true as const, value: automation }))
  const saved = vi.fn()
  render(<AutomationEditor flows={[flow]} api={{ 'automations.save': save, 'flows.preflight': ready }} onClose={() => {}} onSaved={saved} t={translator()} />)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nightly review' } })
  fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'UTC' } })
  expect(screen.getByText('daily 02:00 · UTC')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Inputs (JSON)'), { target: { value: '[]' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save automation' }))
  expect(screen.getByRole('alert').textContent).toContain('JSON object')
  expect(save).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Inputs (JSON)'), { target: { value: '{}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save automation' }))
  await waitFor(() => { expect(saved).toHaveBeenCalledWith(automation) })
  expect(save).toHaveBeenCalledWith({ name: 'Nightly review', flowId: flow.id, inputs: {}, schedule: { kind: 'cron', expr: '0 2 * * *', tz: 'UTC' }, enabled: true })
})

it('keeps a failed save open and reports the failure', async () => {
  const save = vi.fn(async () => { throw new Error('offline') })
  render(<AutomationEditor automation={automation} flows={[flow]} api={{ 'automations.save': save, 'flows.preflight': ready }} onClose={() => {}} onSaved={() => { throw new Error('must not close') }} t={translator()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save automation' }))
  await screen.findByRole('alert')
  expect(screen.getByLabelText('Name')).toHaveProperty('value', automation.name)
})

it('renders schedule rows and charts from Remote data without reading Session state', async () => {
  const api: presentation.AutomationsFace['api'] = {
    'flows.preflight': ready,
    'automations.list': async () => ({ ok: true, value: [automation] }),
    'flows.list': async () => ({ ok: true, value: [flow] }),
    'automations.stats': async (...args: [AutomationId, number?]) => {
      // The generated transport requires the optional parameter's positional slot.
      expect(args).toEqual([automation.id, undefined])
      return { ok: true, value: stats }
    },
    'automations.save': async () => ({ ok: true, value: automation }),
    'automations.delete': async () => ({ ok: true, value: undefined }),
    'automations.setEnabled': async () => ({ ok: true, value: automation }),
    'automations.runNow': async () => ({ ok: true, value: { id: 'skip' as RunId, at: automation.createdAt, state: 'skipped' } }),
    followRuns: () => { throw new Error('No active runs') },
  }
  const notify = vi.fn()
  render(<AutomationsPage api={api} notify={notify} t={translator()} />)
  await screen.findByRole('table', { name: 'Where runs stop' })
  expect(screen.getByText('daily 02:00 · UTC')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
  await waitFor(() => { expect(notify).toHaveBeenCalledWith('skippedRun') })
})

it('blocks Run now and enabling when preflight fails, and displays the first error', async () => {
  const api = pageApi()
  api['flows.preflight'] = blocked
  api['automations.list'] = async () => ({ ok: true, value: [{ ...automation, enabled: false }] })
  const enable = vi.fn(api['automations.setEnabled'])
  api['automations.setEnabled'] = enable
  render(<AutomationsPage api={api} notify={() => {}} t={translator()} />)
  await screen.findByText('Workspace directory does not exist')
  expect(screen.getByRole('button', { name: 'Run now' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
  expect(enable).not.toHaveBeenCalled()
})

it('retains the failed preflight returned by an enable attempt instead of replacing it with a fresh check', async () => {
  const api = pageApi()
  api['automations.list'] = async () => ({ ok: true, value: [{ ...automation, enabled: false }] })
  let checks = 0
  api['flows.preflight'] = async () => ++checks === 2 ? blocked() : ready()
  const enable = vi.fn(api['automations.setEnabled'])
  api['automations.setEnabled'] = enable
  render(<AutomationsPage api={api} notify={() => {}} t={translator()} />)
  await screen.findByText('Ready to run')
  fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
  await screen.findByText('Workspace directory does not exist')
  expect(enable).not.toHaveBeenCalled()
})

it('shows workspace among ordinary editor inputs and preflight errors before enabling a save', async () => {
  const save = vi.fn(async () => ({ ok: true as const, value: automation }))
  const check = vi.fn(blocked)
  const withWorkspace: Flow = { ...flow, inputs: [{ name: 'workspace', type: 'string' }] }
  render(<AutomationEditor flows={[withWorkspace]} api={{ 'automations.save': save, 'flows.preflight': check }} onClose={() => {}} onSaved={() => {}} t={translator()} />)
  expect(screen.getByLabelText('Inputs (JSON)')).toHaveProperty('value', JSON.stringify({ workspace: '' }, null, 2))
  await screen.findByText('Workspace directory does not exist')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Workspace review' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save automation' }))
  expect(save).not.toHaveBeenCalled()
})

it('persists workspace unchanged and displays successful preflight in the editor', async () => {
  const save = vi.fn(async (_draft: AutomationDraft) => ({ ok: true as const, value: automation }))
  const check = vi.fn(ready)
  const saved = vi.fn()
  render(<AutomationEditor automation={{ ...automation, inputs: { workspace: '/selected/project' } }} flows={[{ ...flow, inputs: [{ name: 'workspace', type: 'string' }] }]} api={{ 'automations.save': save, 'flows.preflight': check }} onClose={() => {}} onSaved={saved} t={translator()} />)
  await screen.findByText('Ready to run')
  fireEvent.click(screen.getByRole('button', { name: 'Save automation' }))
  await waitFor(() => { expect(saved).toHaveBeenCalled() })
  expect(save.mock.calls[0]?.[0]).toMatchObject({ inputs: { workspace: '/selected/project' } })
})

it('polls pending reservations without subscribing until admission creates a run', async () => {
  vi.useFakeTimers()
  const api = pageApi()
  let pending = true
  api['automations.stats'] = async () => ({ ok: true, value: { ...stats, runs: [{ ...stats.runs[0]!, state: pending ? 'pending' : 'running' }] } })
  const follow = vi.fn(async function* () {})
  api.followRuns = streamMethod(follow)
  render(<AutomationsPage api={api} notify={() => {}} t={translator()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(follow).not.toHaveBeenCalled()
  pending = false
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(follow).toHaveBeenCalledTimes(1)
})

it.each(['automations.list', 'automations.stats', 'flows.preflight'] as const)('publishes pending-to-running results when %s exceeds the retry interval', async (method) => {
  vi.useFakeTimers()
  const api = pageApi()
  let pending = true
  const delay = async (reading: typeof method): Promise<void> => {
    if (!pending && reading === method) await new Promise<void>((resolve) => { setTimeout(resolve, 1500) })
  }
  const list = vi.fn(async () => { await delay('automations.list'); return { ok: true as const, value: [automation] } })
  api['automations.list'] = list
  api['automations.stats'] = async () => {
    await delay('automations.stats')
    return { ok: true, value: { ...stats, runs: [{ ...stats.runs[0]!, state: pending ? 'pending' : 'running' }] } }
  }
  api['flows.preflight'] = async () => { await delay('flows.preflight'); return ready() }
  const follow = vi.fn(async function* () {})
  api.followRuns = streamMethod(follow)
  render(<AutomationsPage api={api} notify={() => {}} t={translator()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(follow).not.toHaveBeenCalled()
  pending = false
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(list).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(list).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(screen.getByRole('button', { name: /Nightly review/ }).textContent).toContain('Running')
  expect(follow).toHaveBeenCalledTimes(1)
})

it('waits for slow refresh reads before retrying an ended stream again', async () => {
  vi.useFakeTimers()
  const api = pageApi()
  let slow = false
  const read = vi.fn(async () => {
    if (slow) await new Promise<void>((resolve) => { setTimeout(resolve, 1500) })
    return { ok: true as const, value: { ...stats, runs: [{ ...stats.runs[0]!, state: 'running' as const }] } }
  })
  api['automations.stats'] = read
  const follow = vi.fn(async function* () {})
  api.followRuns = streamMethod(follow)
  render(<AutomationsPage api={api} notify={() => {}} t={translator()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(follow).toHaveBeenCalledTimes(1)
  slow = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(read).toHaveBeenCalledTimes(2)
  expect(follow).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(follow).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(999) })
  expect(read).toHaveBeenCalledTimes(2)
})

it('coalesces Refresh while publishing the latest started read before the queued read settles', async () => {
  vi.useFakeTimers()
  const api = pageApi()
  const first = Promise.withResolvers<Awaited<ReturnType<typeof api['automations.stats']>>>()
  const next = Promise.withResolvers<Awaited<ReturnType<typeof api['automations.stats']>>>()
  const read = vi.fn(api['automations.stats']).mockImplementationOnce(api['automations.stats'])
    .mockImplementationOnce(() => first.promise).mockImplementationOnce(() => next.promise)
  api['automations.stats'] = read
  render(<AutomationsPage api={api} notify={() => {}} t={translator()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(read).toHaveBeenCalledTimes(2)
  await act(async () => { first.resolve({ ok: true, value: { ...stats, runs: [{ ...stats.runs[0]!, state: 'running' }] } }) })
  expect(read).toHaveBeenCalledTimes(3)
  expect(screen.getByRole('button', { name: /Nightly review/ }).textContent).toContain('Running')
  await act(async () => { next.resolve({ ok: true, value: stats }) })
  expect(screen.getByRole('button', { name: /Nightly review/ }).textContent).toContain('Failed')
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['end', 'error'] as const)('reconnects after stream %s and Refresh without restarting on frames', async (ending) => {
  vi.useFakeTimers()
  const api = pageApi()
  api['automations.stats'] = async () => ({ ok: true, value: { ...stats, runs: [{ ...stats.runs[0]!, state: 'running' }] } })
  let finish = (): void => {}
  const signals: AbortSignal[] = []
  const frame: RunFrame = { type: 'snapshot', run: { id: stats.runs[0]!.id, flowId: flow.id, flow, inputs: {}, state: 'running', attempts: [], timeline: [], createdAt: automation.createdAt, updatedAt: automation.createdAt, cursor: 0, rounds: {}, outputs: {}, tokens: 0 } }
  const follow = vi.fn(async function* (_id: RunId, signal?: AbortSignal) {
    if (!signal) throw new Error('subscriber signal required')
    signals.push(signal)
    const done = new Promise<void>((resolve) => { finish = resolve; signal.addEventListener('abort', resolve.bind(null, undefined), { once: true }) })
    yield frame
    await done
    if (ending === 'error') throw new Error('Disconnected')
  })
  api.followRuns = streamMethod(follow)
  const view = render(<AutomationsPage api={api} notify={() => {}} t={translator()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(follow).toHaveBeenCalledTimes(1)
  await act(async () => { finish() })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(follow).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(follow).toHaveBeenCalledTimes(3)
  expect(signals[1]?.aborted).toBe(true)
  view.unmount()
  expect(signals.every(signal => signal.aborted)).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(follow).toHaveBeenCalledTimes(3)
})

it('aborts selected streams and pending retry timers on selection change and unmount', async () => {
  vi.useFakeTimers()
  const api = pageApi()
  const other = { ...automation, id: 'other' as AutomationId, name: 'Other review' }
  api['automations.list'] = async () => ({ ok: true, value: [automation, other] })
  api['automations.stats'] = async (id: AutomationId) => ({ ok: true, value: { ...stats, runs: [{ ...stats.runs[0]!, id: `run-${id}` as RunId, state: 'running' }] } })
  const signals: AbortSignal[] = []
  let finish = (): void => {}
  const list = vi.spyOn(api, 'automations.list')
  const follow = vi.fn(async function* (id: RunId, signal?: AbortSignal) {
    if (!signal) throw new Error('subscriber signal required')
    signals.push(signal)
    if (id === `run-${other.id}`) await new Promise<void>((resolve) => {
      finish = resolve
      signal.addEventListener('abort', resolve.bind(null, undefined), { once: true })
    })
  })
  api.followRuns = streamMethod(follow)
  const view = render(<AutomationsPage api={api} notify={() => {}} t={translator()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(vi.getTimerCount()).toBe(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  fireEvent.click(screen.getByRole('button', { name: /Other review/ }))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(signals[0]?.aborted).toBe(true)
  expect(follow).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  expect(list).toHaveBeenCalledTimes(1)
  expect(follow).toHaveBeenCalledTimes(2)
  await act(async () => { finish() })
  expect(vi.getTimerCount()).toBe(1)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(signals.every(signal => signal.aborted)).toBe(true)
  expect(follow).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('owns navigation, page and notices through slot teardown', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  new TestRemote(ctx, { switchboard: {} })
  const slots = ctx.get('slots') as SlotRegistry
  const root = slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } } } as never, () => null)
  const fiber = ctx.plugin(presentation)
  await fiber.await()
  expect(slots.entries('main')[0]?.component).toBe(AutomationsPage)
  expect(slots.entries('sidebar.panellist')[0]?.options.id).toBe('switchboard-automations')
  expect(slots.entries('shell.overlay')).toHaveLength(1)
  await fiber.dispose()
  for (const name of ['main', 'sidebar.panellist', 'shell.overlay'] as const) expect(slots.entries(name)).toHaveLength(0)
  root()
})
