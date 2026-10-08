// @vitest-environment jsdom
import { Context } from '../src/client/dsh.ts'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '../src/client/dsh.ts'
import { usePinnedBrowserLanguages } from './fixtures/locale-env.ts'
import type { Flow, FlowId, FlowLayout, FlowRun, RunFrame, RunId } from '@switchboard/core/types'
import starter from '../../core/examples/fix-bug-with-review.json'
import { FlowsPage } from '../src/client/FlowsPage.tsx'
import { positionsFor } from '../src/client/FlowCanvas.tsx'
import { RunView } from '../src/client/RunPanel.tsx'
import { RunModel } from '../src/client/run-model.ts'
import { en } from '../src/client/locales.ts'
import { blockState } from '../src/client/run-state.ts'
import { runDefinition } from '../src/client/run-card.tsx'
import { ToolCallId } from '../src/client/dsh.ts'
import { createToolResultMessage } from '../src/client/dsh.ts'
import { SessionSeq } from '../src/client/dsh.ts'

import type { FlowsFace } from '../src/client/flow-types.ts'

usePinnedBrowserLanguages('en')
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
function translator() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const locale = new LocaleRuntime(ctx)
  locale.register('switchboard', { en, zh: en })
  return locale.bind('switchboard')
}
const unread = () => { throw new Error('Unexpected framework seat read') }
const seats = { usePanelInfo: unread, useSessions: unread, useSessionStatus: unread,
  useSessionRetainInfo: unread, useWorkspaces: unread, useResource: unread }
function flow(): Flow { return { id: 'example' as FlowId, name: 'Example flow', version: 1, inputs: [], limits: {}, blocks: [{ id: 'a', kind: 'gate', label: 'First' }, { id: 'b', kind: 'gate', label: 'Second' }], edges: [{ from: 'a', to: 'b', kind: 'next' }] } }
function commands(): FlowsFace {
  return {
    workspace: () => undefined,
    listFlows: vi.fn(async () => [flow()]), saveFlow: vi.fn(async (value: Flow) => value),
    getLayout: vi.fn(async () => ({ positions: [] })), saveLayout: vi.fn(async (_id: FlowId, layout: FlowLayout) => layout),
    preflight: vi.fn(async () => ({ ok: true, items: [] })), validate: vi.fn(async () => ({ ok: true, items: [] })),
    start: vi.fn(), listRuns: vi.fn(async () => []), openRun: vi.fn(async () => {}),
  }
}
it('creates a palette block by dragging, and persists its inspector edits and placement', async () => {
  const api = commands()
  render(<FlowsPage {...seats} {...api} t={translator()} />)
  await screen.findByDisplayValue('Example flow')
  await waitFor(() =>{  expect(screen.getByRole('button', { name: 'Fit graph' })).toHaveProperty('disabled', false) })
  const data = new Map<string, string>()
  const dataTransfer = { setData: (key: string, value: string) => data.set(key, value), getData: (key: string) => data.get(key) ?? '' }
  fireEvent.dragStart(screen.getByRole('button', { name: 'Codex' }), { dataTransfer })
  const canvas = screen.getByLabelText('Flow canvas')
  const drop = createEvent.drop(canvas, { dataTransfer })
  Object.defineProperties(drop, { clientX: { value: 80 }, clientY: { value: 90 } })
  fireEvent(canvas, drop)
  await screen.findByLabelText('Prompt template')
  fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Implement change' } })
  fireEvent.change(screen.getByLabelText('Prompt template'), { target: { value: 'Inspect the project' } })
  fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/workspace' } })
  const paths = screen.getByLabelText('Read paths (one per line)')
  fireEvent.change(paths, { target: { value: 'src\n' } })
  expect(paths).toHaveProperty('value', 'src\n')
  fireEvent.change(paths, { target: { value: 'src\ntests' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>{  expect(api.saveLayout).toHaveBeenCalled() })
  const saved = vi.mocked(api.saveFlow).mock.calls[0]?.[0]
  expect(saved?.version).toBe(2)
  expect(saved?.blocks.at(-1)).toMatchObject({ label: 'Implement change', harness: 'codex',
    prompt: 'Inspect the project', scope: { cwd: '/workspace', read: ['src', 'tests'] } })
  expect(vi.mocked(api.saveLayout).mock.calls[0]?.[1].positions.at(-1)).toMatchObject({ x: 80, y: 90 })
})
it('connects a backward edge and marks it as a bounded failed loop', async () => {
  const api = commands()
  render(<FlowsPage {...seats} {...api} t={translator()} />)
  await screen.findByDisplayValue('Example flow')
  fireEvent.change(screen.getByLabelText('From'), { target: { value: 'b' } })
  fireEvent.change(screen.getByLabelText('To'), { target: { value: 'a' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  fireEvent.click(screen.getByLabelText('Loop edge'))
  fireEvent.change(screen.getByLabelText('Loop on'), { target: { value: 'failed' } })
  fireEvent.change(screen.getByLabelText('Maximum rounds'), { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>{  expect(api.saveFlow).toHaveBeenCalled() })
  expect(api.saveFlow).toHaveBeenCalledWith(expect.objectContaining({ edges: [{ from: 'a', to: 'b', kind: 'next' }, { from: 'b', to: 'a', kind: 'loop', on: 'failed', maxRounds: 2 }] }))
})
it('keeps Run disabled while checking or when preflight reports an error', async () => {
  const api = commands()
  api.preflight = vi.fn<FlowsFace['preflight']>(async () => ({ ok: false, items: [{ level: 'error', code: 'scope', message: 'Choose a working directory', blockId: 'a' }] }))
  render(<FlowsPage {...seats} {...api} t={translator()} />)
  await screen.findByDisplayValue('Example flow')
  expect(screen.getByRole('button', { name: 'Run' })).toHaveProperty('disabled', true)
  await screen.findAllByText('Choose a working directory', { exact: false })
  expect(screen.getByRole('button', { name: 'Run' })).toHaveProperty('disabled', true)
  expect(api.start).not.toHaveBeenCalled()
})
it('rejects late preflight responses after a newer draft', async () => {
  const api = commands()
  let resolve!: (value: { ok: boolean; items: [] }) => void
  api.preflight = vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done })).mockResolvedValue({ ok: false, items: [{ level: 'error', code: 'new', message: 'New draft refused' }] })
  render(<FlowsPage {...seats} {...api} t={translator()} />)
  await waitFor(() =>{  expect(api.preflight).toHaveBeenCalledTimes(1) })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New name' } })
  await screen.findByText('New draft refused', { exact: false })
  await act(async () => { resolve({ ok: true, items: [] }) })
  expect(screen.getByRole('button', { name: 'Run' })).toHaveProperty('disabled', true)
})
it('retains the edited draft when layout saving fails and retries without reloading', async () => {
  const api = commands()
  api.saveLayout = vi.fn<FlowsFace['saveLayout']>().mockRejectedValueOnce(new Error('Layout unavailable')).mockImplementation(async (_id, value) => value)
  render(<FlowsPage {...seats} {...api} t={translator()} />)
  await screen.findByDisplayValue('Example flow')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Retained draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByRole('alert')
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Retained draft')
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>{  expect(api.saveLayout).toHaveBeenCalledTimes(2) })
})
it('validates before save and displays block errors without writing an invalid recipe', async () => {
  const api = commands()
  api.validate = vi.fn(async () => ({ ok: false, items: [{ level: 'error' as const, code: 'block', blockId: 'a', message: 'Invalid block label' }] }))
  render(<FlowsPage {...seats} {...api} t={translator()} />)
  await screen.findByDisplayValue('Example flow')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findAllByText('Invalid block label', { exact: false })
  expect(api.saveFlow).not.toHaveBeenCalled()
})
it('starts an admitted saved flow and opens its run', async () => {
  const api = commands()
  const run = { id: 'started' as RunId, flowId: flow().id, flow: flow(), inputs: {}, state: 'queued' as const, attempts: [], timeline: [], createdAt: '', updatedAt: '', cursor: 0, rounds: {}, outputs: {}, tokens: 0 }
  api.start = vi.fn(async () => run)
  render(<FlowsPage {...seats} {...api} t={translator()} />)
  await waitFor(() =>{  expect(screen.getByRole('button', { name: 'Run' })).toHaveProperty('disabled', false) })
  fireEvent.click(screen.getByRole('button', { name: 'Run' }))
  await waitFor(() =>{  expect(api.openRun).toHaveBeenCalledWith(run) })
  expect(api.start).toHaveBeenCalledWith(flow().id, {})
})
it('lays out a DAG without allowing backward loops to move the start', () => {
  const recipe = flow(); recipe.edges.push({ from: 'b', to: 'a', kind: 'loop', on: 'failed', maxRounds: 2 })
  expect(positionsFor(recipe, { positions: [] }).positions).toEqual([{ id: 'a', x: 40, y: 50 }, { id: 'b', x: 40, y: 190 }])
})

it('renders durable states from a scripted follow stream and approves the waiting gate', async () => {
  let deliver!: (value: RunFrame) => void
  let finish!: () => void
  const feed = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const frame = await new Promise<RunFrame | undefined>((resolve) => { deliver = resolve; finish = () =>{  resolve(undefined) } })
        if (!frame) return
        yield { value: frame, generation: 1, signal: new AbortController().signal, accept() {} }
      }
    },
    async dispose() { finish() },
  }
  // The real model owns stream consumption; this fixture replaces only the Gateway carrier.
  const model = new RunModel(() => feed)
  onTestFinished(() => model.dispose())
  const id = 'run-1' as RunId
  const run: FlowRun = { id, flowId: flow().id, flow: flow(), inputs: {}, state: 'running', attempts: [], timeline: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z', cursor: 0, rounds: {}, outputs: {}, tokens: 20 }
  const approve = vi.fn(async () => true)
  const watch = (id: RunId) => model.watch(id)
  const useRuns: Parameters<typeof RunView>[0]['useRuns'] = select => select(useSyncExternalStore(listener => model.source.subscribe(listener), () => model.source.getSnapshot()))
  render(<RunView id={id} t={translator()} watch={watch} useRuns={useRuns} approve={approve} cancel={vi.fn()} />)
  await act(async () => { deliver({ type: 'snapshot', run }) })
  expect(screen.getByText('Running')).toBeTruthy()
  await act(async () => { deliver({ type: 'update', run: { ...run, state: 'needs-you', attempts: [{ blockId: 'a', copy: 0, round: 0, state: 'succeeded', startedAt: run.createdAt, output: '' }, { blockId: 'b', copy: 0, round: 2, state: 'needs-you', startedAt: run.createdAt, output: '' }] } }) })
  expect(screen.getByText('Needs you')).toBeTruthy()
  expect(screen.getByRole('progressbar')).toHaveProperty('value', 1)
  expect(screen.getByText(/Attempts 1 · Round 2/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() =>{  expect(approve).toHaveBeenCalledWith(id, 'b', true) })
  await act(async () => { deliver({ type: 'update', run: { ...run, state: 'failed', error: 'Scripted failure' } }) })
  expect(screen.getByText('Failed')).toBeTruthy()
  expect(screen.getByText('Scripted failure')).toBeTruthy()
  const parallel: FlowRun = { ...run, flow: { ...run.flow, blocks: [{ id: 'a', label: 'Copies', kind: 'agent', harness: 'dsh', prompt: '', copies: 2, scope: { cwd: '/', read: [], write: [], commands: [], web: false, sandbox: 'read-only' } }] }, attempts: [
    { blockId: 'a', copy: 0, round: 1, state: 'running', startedAt: run.createdAt, output: '' },
    { blockId: 'a', copy: 1, round: 1, state: 'succeeded', startedAt: run.createdAt, output: '' },
  ] }
  expect(blockState(parallel, 'a').state).toBe('running')
})

it('recognizes only valid replayable run result metadata as a chat node', () => {
  const event = { type: 'tool/result' as const, surfaceOp: 'append' as const, seq: SessionSeq(1), time: 0, data: {
    turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('call-1'), content: [], isError: false }),
    meta: { switchboardRun: { runId: 'run-1', name: 'Saved flow' } },
  } }
  expect(runDefinition.match(event)).toEqual({ id: 'run-1', role: 'start' })
  expect(runDefinition.match({ ...event, data: { ...event.data, meta: { switchboardRun: false } } })).toBeNull()
})

it('serializes a deferred Save against Refresh and switching recipes', async () => {
  const api = commands()
  const saved = Promise.withResolvers<Flow>()
  api.saveFlow = vi.fn(() => saved.promise)
  api.listFlows = vi.fn(async () => [flow(), { ...flow(), id: 'other' as FlowId, name: 'Other flow' }])
  render(<FlowsPage {...seats} {...api} t={translator()} />)
  await screen.findByDisplayValue('Example flow')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Saving draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => { expect(api.saveFlow).toHaveBeenCalledTimes(1) })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(api.listRuns).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Refresh' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: 'Other flow' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Blocked edit' } })
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Saving draft')
  await act(async () => { saved.resolve({ ...flow(), name: 'Saving draft', version: 2 }) })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false) })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Newer draft' } })
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Newer draft')
})

it('keeps the shipped example preflight diagnostics after structural Validate', async () => {
  const api = commands()
  api.listFlows = vi.fn(async () => [starter as Flow])
  api.preflight = vi.fn(async () => ({ ok: false, items: [{ level: 'error' as const, code: 'inputs', message: 'Missing input bug' }] }))
  render(<FlowsPage {...seats} {...api} t={translator()} />)
  await screen.findByText(/Missing input bug/)
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Validate' })).toHaveProperty('disabled', false) })
  expect(screen.getByText(/Missing input bug/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Run' })).toHaveProperty('disabled', true)
})

it('uses keyboard node selection for inspector editing and deletion', async () => {
  const api = commands()
  render(<FlowsPage {...seats} {...api} t={translator()} />)
  const node = await screen.findByTestId('rf__node-a')
  expect(node.tabIndex).toBe(0)
  node.focus()
  fireEvent.keyDown(node, { key: 'Enter', code: 'Enter' })
  const label = await screen.findByLabelText('Label')
  fireEvent.change(label, { target: { value: 'Keyboard edit' } })
  fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
  expect(screen.queryByTestId('rf__node-a')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => { expect(api.saveFlow).toHaveBeenCalled() })
  expect(vi.mocked(api.saveFlow).mock.calls[0]?.[0].blocks.map(block => block.id)).toEqual(['b'])
})

it.each(['node-to-edge', 'edge-to-node'] as const)('retains keyboard %s selection for editing and deletion', async (direction) => {
  // jsdom has no layout; supply measurements so XYFlow renders the actual edge.
  const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200)
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(80)
  const bbox = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox')
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => new DOMRect(0, 0, 100, 20) })
  onTestFinished(() => {
    width.mockRestore(); height.mockRestore()
    if (bbox) Object.defineProperty(SVGElement.prototype, 'getBBox', bbox)
    else Reflect.deleteProperty(SVGElement.prototype, 'getBBox')
  })
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1 })
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      queueMicrotask(() => {
        this.callback([{
          target, contentRect: new DOMRect(0, 0, 200, 80), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
        }], this)
      })
    }
    unobserve() {}
    disconnect() {}
  })
  const api = commands()
  render(<FlowsPage {...seats} {...api} t={translator()} />)
  await screen.findByTestId('rf__edge-0')
  for (const id of direction === 'node-to-edge' ? ['rf__node-a', 'rf__edge-0'] : ['rf__edge-0', 'rf__node-a']) {
    const item = await screen.findByTestId(id)
    expect(item.tabIndex).toBe(0)
    item.focus()
    fireEvent.keyDown(item, { key: 'Enter', code: 'Enter' })
  }
  if (direction === 'node-to-edge') {
    fireEvent.click(await screen.findByLabelText('Loop edge'))
    fireEvent.change(screen.getByLabelText('Maximum rounds'), { target: { value: '3' } })
  } else fireEvent.change(await screen.findByLabelText('Label'), { target: { value: 'Switched selection' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => { expect(api.saveFlow).toHaveBeenCalledTimes(1) })
  const saved = vi.mocked(api.saveFlow).mock.calls[0]![0]
  if (direction === 'node-to-edge') expect(saved.edges[0]).toMatchObject({ kind: 'loop', maxRounds: 3 })
  else expect(saved.blocks[0]?.label).toBe('Switched selection')
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false) })
  fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => { expect(api.saveFlow).toHaveBeenCalledTimes(2) })
  const deleted = vi.mocked(api.saveFlow).mock.calls[1]![0]
  expect(deleted.edges).toEqual([])
  expect(deleted.blocks.map(block => block.id)).toEqual(direction === 'node-to-edge' ? ['a', 'b'] : ['b'])
})

it('shows Done for an approved gate revisited by a loop', () => {
  const run: FlowRun = { id: 'gate-loop' as RunId, flowId: flow().id, flow: flow(), inputs: {}, state: 'succeeded',
    attempts: [0, 1].map(() => ({ blockId: 'a', copy: 0, round: 0, state: 'succeeded', startedAt: '', output: 'Approved' })),
    timeline: [], createdAt: '', updatedAt: '', cursor: 2, rounds: {}, outputs: {}, tokens: 0 }
  expect(blockState(run, 'a')).toEqual({ state: 'succeeded', attempts: 2, round: 0 })
  run.attempts.push({ blockId: 'b', copy: 0, round: 0, state: 'succeeded', startedAt: '', output: 'Approved' })
  render(<RunView id={run.id} t={translator()} watch={() => () => {}}
    useRuns={select => select({ [run.id]: { run } })} approve={vi.fn()} cancel={vi.fn()} />)
  expect(screen.getByRole('progressbar')).toHaveProperty('value', 2)
  expect(screen.getByText('Step 2 of 2')).toBeTruthy()
  expect(screen.getByText('Done')).toBeTruthy()
})

it('defaults the workspace input to the active Session directory and permits an explicit replacement', async () => {
  const api = commands()
  api.workspace = () => '/active-project'
  api.listFlows = vi.fn(async () => [starter as Flow])
  render(<FlowsPage {...seats} {...api} t={translator()} />)
  const workspace = await screen.findByLabelText('workspace')
  expect(workspace).toHaveProperty('value', '/active-project')
  fireEvent.change(workspace, { target: { value: '/chosen-project' } })
  await waitFor(() => { expect(api.preflight).toHaveBeenLastCalledWith(expect.anything(), { workspace: '/chosen-project' }) })
})

it('requires an explicit workspace when no Session is active', async () => {
  const api = commands()
  api.listFlows = vi.fn(async () => [starter as Flow])
  api.preflight = vi.fn(async () => ({ ok: false, items: [{ level: 'error' as const, code: 'inputs', message: 'Missing input workspace' }] }))
  render(<FlowsPage {...seats} {...api} t={translator()} />)
  expect(await screen.findByLabelText('workspace')).toHaveProperty('value', '')
  await screen.findByText(/Missing input workspace/)
  expect(screen.getByRole('button', { name: 'Run' })).toHaveProperty('disabled', true)
})

it('ignores a save response after its page data has been replaced', async () => {
  const api = commands()
  const t = translator()
  const saved = Promise.withResolvers<Flow>()
  api.saveFlow = vi.fn(() => saved.promise)
  const view = render(<FlowsPage {...seats} {...api} t={t} />)
  await screen.findByDisplayValue('Example flow')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => { expect(api.saveFlow).toHaveBeenCalled() })
  view.rerender(<FlowsPage {...seats} {...api} t={t} listFlows={async () => [{ ...flow(), name: 'Replacement' }]} />)
  await screen.findByDisplayValue('Replacement')
  await act(async () => { saved.resolve({ ...flow(), name: 'Stale saved draft' }) })
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Replacement')
  expect(api.saveLayout).not.toHaveBeenCalled()
})
