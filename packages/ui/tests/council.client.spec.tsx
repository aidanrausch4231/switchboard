// @vitest-environment jsdom
import { Context } from '../src/client/dsh.ts'
import { brandString } from '../src/client/dsh.ts'
import { LocaleRuntime } from '../src/client/dsh.ts'
import { TestRemote } from './fixtures/remote.ts'
import { usePinnedBrowserLanguages } from './fixtures/locale-env.ts'
import { SlotRegistry } from '../src/client/dsh.ts'
import { IconThinkOutlineRegular } from '../src/client/dsh.ts'
import { DshRemoteError as RemoteError, type RemoteStreamHandle } from '../src/client/dsh.ts'
import type { CouncilAnswer, CouncilEvent, CouncilSession, CouncilSessionId, SeatAvailability, SeatId } from '@switchboard/council/types'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { CouncilPage } from '../src/client/CouncilPage.tsx'
import { councilEvent } from '../src/client/council-state.ts'
import * as presentation from '../src/client/council-presentation.ts'
import { en } from '../src/client/council-locales.ts'

usePinnedBrowserLanguages('en')
afterEach(cleanup)
const a = brandString<SeatId>('chair')
const b = brandString<SeatId>('peer')
const c = brandString<SeatId>('native')
const id = brandString<CouncilSessionId>('council-test')
const catalog: SeatAvailability[] = [
  { id: a, label: 'Research', kind: 'llm', model: 'model-a', provider: 'fake', enabled: true, available: true },
  { id: b, label: 'Engineering', kind: 'llm', model: 'model-b', provider: 'fake', enabled: true, available: true },
  { id: c, label: 'Native', kind: 'subagent', subagent: 'claude-code', enabled: true, available: true },
  { id: brandString<SeatId>('codex'), label: 'Codex', kind: 'subagent', subagent: 'codex', enabled: true, available: false, reason: 'codex has no read-only mode yet' },
]
const initial: CouncilSession = {
  id, question: 'Which storage?', mode: 'debate', seats: catalog.slice(0, 3), chair: a,
  roundCount: 2, rounds: [], state: 'running', createdAt: '2026-01-01T00:00:00.000Z',
}
const answer: CouncilAnswer = { seatId: a, state: 'answered', text: 'Use local storage.', usage: { inputTokens: 10, outputTokens: 20 }, ms: 30 }
const ruling = { ruling: 'Prefer a reversible choice.', dissent: [{ seat: 'Seat B', point: 'Cloud writes remain a concern.' }], confidence: 0.8 }

function stream() {
  let wake: (() => void) | undefined
  let closed = false
  const queue: CouncilEvent[] = []
  const dispose = vi.fn(() => { closed = true; wake?.() })
  const handle: RemoteStreamHandle<CouncilEvent, never> = {
    dispose, send: () => {}, end: () => {},
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (queue.length) yield queue.shift()!
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    },
  }
  return { handle, dispose, push: (event: CouncilEvent) => { queue.push(event); wake?.() }, close: () => { closed = true; wake?.() } }
}
function fixture(failingCatalog = false) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const locale = new LocaleRuntime(ctx)
  locale.register('switchboardCouncil', { en, zh: en })
  const feed = stream()
  const api = {
    seats: vi.fn<presentation.CouncilFace['seats']>().mockResolvedValue({ ok: true, value: catalog }),
    list: vi.fn<presentation.CouncilFace['list']>().mockResolvedValue({ ok: true, value: [] }),
    ask: vi.fn<presentation.CouncilFace['ask']>().mockResolvedValue({ ok: true, value: id }),
    follow: vi.fn<presentation.CouncilFace['follow']>().mockReturnValue(feed.handle),
    get: vi.fn<presentation.CouncilFace['get']>().mockResolvedValue({ ok: true, value: { ...initial, state: 'done', ruling } }),
    cancel: vi.fn<presentation.CouncilFace['cancel']>().mockResolvedValue({ ok: true, value: { ...initial, state: 'cancelled' } }),
  }
  if (failingCatalog) api.seats.mockRejectedValueOnce(new Error('Disconnected'))
  const view = render(<CouncilPage api={api} t={locale.bind('switchboardCouncil')} />)
  return { api, feed, view }
}
async function start(f: ReturnType<typeof fixture>) {
  await screen.findByRole('checkbox', { name: /Research/ })
  fireEvent.change(screen.getByRole('textbox', { name: 'The question' }), { target: { value: 'Which storage?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Convene council' }))
  await waitFor(() => { expect(f.api.follow).toHaveBeenCalledWith(id) })
  await act(async () => { f.feed.push({ type: 'snapshot', session: initial }) })
}

it('renders seats from the API, disables unavailable seats, and submits selected debate rounds', async () => {
  const f = fixture()
  const unavailable = await screen.findByRole('checkbox', { name: /Codex/ }) as HTMLInputElement
  expect(unavailable.disabled).toBe(true)
  expect(unavailable.checked).toBe(false)
  expect(screen.getByText(/codex has no read-only mode yet/)).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'The question' }), { target: { value: 'Which storage?' } })
  fireEvent.click(screen.getByRole('radio', { name: 'Debate' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Debate rounds' }), { target: { value: '3' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /Native/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Convene council' }))
  await waitFor(() => { expect(f.api.ask).toHaveBeenCalledWith({ question: 'Which storage?', mode: 'debate', rounds: 3, seatIds: [a, b] }) })
  expect(f.api.seats).toHaveBeenCalledTimes(1)
})

it('follows thinking, answered and failed seats, switches debate rounds, and renders the ruling last', async () => {
  const f = fixture()
  await start(f)
  expect(screen.queryByRole('region', { name: en.ruling })).toBeNull()
  await act(async () => { f.feed.push({ type: 'seat-started', round: 1, seatId: a }) })
  expect(within(screen.getByRole('article', { name: 'Research' })).getByText('Thinking')).toBeTruthy()
  await act(async () => {
    f.feed.push({ type: 'seat-answered', round: 1, answer })
    f.feed.push({ type: 'seat-failed', round: 1, answer: { ...answer, seatId: c, state: 'failed', text: '', usage: null, error: 'Seat timed out' } })
    f.feed.push({ type: 'round-done', round: 1 })
    f.feed.push({ type: 'seat-started', round: 2, seatId: a })
  })
  expect(screen.getByRole('article', { name: 'Native' }).getAttribute('data-state')).toBe('excluded')
  expect(within(screen.getByRole('article', { name: 'Native' })).getByText('Usage unavailable')).toBeTruthy()
  const selector = screen.getByRole('combobox', { name: 'View round' })
  fireEvent.change(selector, { target: { value: '1' } })
  expect(within(screen.getByRole('article', { name: 'Research' })).getByText('Use local storage.')).toBeTruthy()
  await act(async () => { f.feed.push({ type: 'seat-answered', round: 2, answer: { ...answer, text: 'Use local storage with backups.' } }) })
  expect(within(screen.getByRole('article', { name: 'Research' })).getByText('Use local storage.')).toBeTruthy()
  fireEvent.change(selector, { target: { value: 'live' } })
  expect(within(screen.getByRole('article', { name: 'Research' })).getByText('Use local storage with backups.')).toBeTruthy()
  expect(screen.queryByRole('region', { name: en.ruling })).toBeNull()
  const final: CouncilSession = {
    ...initial, state: 'done', ruling, rounds: [{ round: 1, answers: [answer] }, { round: 2, answers: [{ ...answer, text: 'Use local storage with backups.' }] }],
    votes: [{ seatId: a, choice: 'Seat B', reason: 'Complete evidence.', usage: answer.usage }],
    tally: { 'Seat B': 1 }, chairAnswers: [answer],
  }
  f.api.get.mockResolvedValue({ ok: true, value: final })
  await act(async () => { f.feed.push({ type: 'ruling', ruling }) })
  expect(screen.getByRole('region', { name: en.ruling }).textContent).toContain('Confidence: 80%')
  await act(async () => { f.feed.push({ type: 'state', state: 'done' }) })
  await act(async () => { f.feed.close() })
  await waitFor(() => { expect(screen.getByLabelText('Vote tally').textContent).toContain('Seat B · 1') })
  expect(within(screen.getByRole('article', { name: 'Research' })).getByText('120 tokens')).toBeTruthy()
  expect(screen.getByText('Seat B: Cloud writes remain a concern.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Send to Graphs' })).toBeNull()
  expect(f.feed.dispose).toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Cancel council' })).toBeNull()
})

it('keeps history and detaches the old stream when changing sessions; ignores an old final read', async () => {
  const f = fixture()
  const oldId = brandString<CouncilSessionId>('older')
  const old = { ...initial, id: oldId, question: 'An older question', state: 'done' as const, ruling }
  f.api.list.mockResolvedValue({ ok: true, value: [old] })
  // Remount to start a fresh catalog request with the seeded history.
  f.view.unmount()
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const locale = new LocaleRuntime(ctx)
  locale.register('switchboardCouncil', { en, zh: en })
  render(<CouncilPage api={f.api} t={locale.bind('switchboardCouncil')} />)
  await start(f)
  let settle!: (value: Awaited<ReturnType<presentation.CouncilFace['get']>>) => void
  f.api.get.mockReturnValue(new Promise((resolve) => { settle = resolve }))
  await act(async () => { f.feed.close() })
  await waitFor(() => { expect(f.api.get).toHaveBeenCalled() })
  const second = stream()
  f.api.follow.mockReturnValue(second.handle)
  fireEvent.click(screen.getByRole('button', { name: /An older question/ }))
  await act(async () => { second.push({ type: 'snapshot', session: old }) })
  expect(f.feed.dispose).toHaveBeenCalled()
  await act(async () => { settle({ ok: true, value: { ...initial, question: 'STALE RESULT' } }) })
  expect(screen.queryByText('STALE RESULT')).toBeNull()
  expect(screen.getByRole('region', { name: en.ruling })).toBeTruthy()
})

it('reconnects after premature stream end and cancels only on explicit request', async () => {
  const f = fixture()
  f.api.get.mockResolvedValue({ ok: true, value: initial })
  await start(f)
  await act(async () => { f.feed.close() })
  await screen.findByText(en.followError)
  const second = stream()
  f.api.follow.mockReturnValue(second.handle)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await act(async () => { second.push({ type: 'snapshot', session: initial }) })
  expect(f.api.follow).toHaveBeenCalledTimes(2)
  const terminal = stream()
  f.api.follow.mockReturnValue(terminal.handle)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel council' }))
  await waitFor(() => { expect(f.api.cancel).toHaveBeenCalledWith(id); expect(f.api.follow).toHaveBeenCalledTimes(3) })
  await act(async () => { terminal.push({ type: 'snapshot', session: { ...initial, state: 'cancelled' } }) })
  expect(screen.queryByRole('button', { name: 'Cancel council' })).toBeNull()
  f.view.unmount()
  expect(second.dispose).toHaveBeenCalled()
  expect(terminal.dispose).toHaveBeenCalled()
  expect(f.api.cancel).toHaveBeenCalledTimes(1)
})

it('retains the cancellation snapshot when reconnect fails and clears thinking seats', async () => {
  const f = fixture()
  await start(f)
  await act(async () => { f.feed.push({ type: 'seat-started', round: 1, seatId: a }) })
  expect(screen.getByText('Thinking')).toBeTruthy()
  f.api.follow.mockImplementation(() => { throw new Error('Disconnected') })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel council' }))
  await screen.findByText(en.followError)
  expect(f.api.cancel).toHaveBeenCalledWith(id)
  expect(f.api.follow).toHaveBeenCalledTimes(2)
  expect(f.feed.dispose).toHaveBeenCalled()
  const chamber = within(screen.getByRole('region', { name: 'Council chamber' }))
  expect(chamber.getByRole('status').textContent).toBe(en.cancelled)
  expect(chamber.queryByText('Thinking')).toBeNull()
  expect(chamber.queryByRole('button', { name: 'Cancel council' })).toBeNull()
  expect(f.api.get).not.toHaveBeenCalled()
})

it('focuses the remounted question field when starting a new question', async () => {
  const f = fixture()
  await start(f)
  expect(screen.queryByRole('textbox', { name: 'The question' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'New question' }))
  const input = screen.getByRole('textbox', { name: 'The question' }) as HTMLTextAreaElement
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe('')
  expect(f.feed.dispose).toHaveBeenCalled()
  expect(f.api.ask).toHaveBeenCalledTimes(1)
  expect(f.api.cancel).not.toHaveBeenCalled()
})

it('shows admission failures without losing the draft', async () => {
  const f = fixture()
  await screen.findByRole('checkbox', { name: /Research/ })
  f.api.ask.mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'Council seat selection must include the chair', {}) })
  fireEvent.change(screen.getByRole('textbox', { name: 'The question' }), { target: { value: 'Keep this draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Convene council' }))
  await screen.findByRole('alert')
  expect(screen.getByDisplayValue('Keep this draft')).toBeTruthy()
  expect(f.api.follow).not.toHaveBeenCalled()
})

it('retries a failed catalog load without starting a council', async () => {
  const f = fixture(true)
  await screen.findByText(en.loadError)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('checkbox', { name: /Research/ })
  expect(f.api.seats).toHaveBeenCalledTimes(2)
  expect(f.api.ask).not.toHaveBeenCalled()
})

it('prepares a follow-up as an editable new question without sending it', async () => {
  const f = fixture()
  await start(f)
  await act(async () => { f.feed.push({ type: 'ruling', ruling }) })
  fireEvent.click(screen.getByRole('button', { name: 'Ask follow-up' }))
  const input = screen.getByRole('textbox', { name: 'The question' }) as HTMLTextAreaElement
  expect(input.value).toContain('Which storage?')
  expect(input.value).toContain(ruling.ruling)
  expect(document.activeElement).toBe(input)
  expect(f.api.ask).toHaveBeenCalledTimes(1)
  expect(f.feed.dispose).toHaveBeenCalled()
  expect(f.api.cancel).not.toHaveBeenCalled()
})

it('folds snapshots authoritatively and leaves prior rounds immutable', () => {
  const view = { session: initial, thinking: [] }
  expect(councilEvent(undefined, { type: 'round-done', round: 1 })).toBeUndefined()
  const first = councilEvent(view, { type: 'seat-answered', round: 1, answer })!
  expect(initial.rounds).toEqual([])
  const second = councilEvent(first, { type: 'seat-answered', round: 2, answer })!
  expect(first.session.rounds).toHaveLength(1)
  expect(second.session.rounds).toHaveLength(2)
  expect(councilEvent(second, { type: 'snapshot', session: initial })).toEqual(view)
})

it('registers Council navigation and removes it on unload', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  new TestRemote(ctx, { switchboardCouncil: {} })
  const fiber = ctx.plugin(presentation)
  await fiber.await()
  const slots = ctx.get('slots') as SlotRegistry
  expect(slots.entries('main')).toHaveLength(0)
  slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } } } as never, () => null)
  expect(slots.entries('main')[0]?.component).toBe(CouncilPage)
  expect(slots.entries('sidebar.panellist')[0]?.options.id).toBe('switchboard-council')
  expect(slots.entries('sidebar.panellist')[0]?.component).toBe(IconThinkOutlineRegular)
  await fiber.dispose()
  expect(slots.entries('main')).toHaveLength(0)
  expect(slots.entries('sidebar.panellist')).toHaveLength(0)
})
