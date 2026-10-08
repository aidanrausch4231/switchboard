// @vitest-environment jsdom
import { Context } from '../src/client/dsh.ts'
import { LocaleRuntime } from '../src/client/dsh.ts'
import { TestRemote } from './fixtures/remote.ts'
import { usePinnedBrowserLanguages } from './fixtures/locale-env.ts'
import { SlotRegistry } from '../src/client/dsh.ts'
import { type RemoteStreamHandle } from '../src/client/dsh.ts'
import type { Card, CardFrame, CardId, Graph, GraphId } from '@switchboard/core/types'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { CardBoard, GraphsPage, RoutingLog } from '../src/client/GraphsPage.tsx'
import * as presentation from '../src/client/graphs-presentation.ts'
import { en } from '../src/client/graphs-locales.ts'

usePinnedBrowserLanguages('en')
afterEach(cleanup)
const graph: Graph = { id: 'billing' as GraphId, name: 'Billing', description: 'Invoices', color: '#b48bf5', lead: { harness: 'dsh', model: 'flash', memoryDir: '/memory/billing', instructions: 'Check evidence.' }, nodes: [], edges: [], rules: { maxCostTokens: 10000, prodWrites: 'never' } }
const cards: Card[] = [
  { id: 'one' as CardId, title: 'Explain invoice', body: '', source: 'chat', state: 'running', hops: 1, costTokens: 50, maxCostTokens: 10000, timeline: [], route: { target: graph.id, confidence: 0.95, reason: 'Invoice question', router: 'jev' } },
  { id: 'two' as CardId, title: 'Deploy prod', body: '', source: 'manual', state: 'needs-you', hops: 0, costTokens: 0, maxCostTokens: 10000, timeline: [{ at: '2026-01-01T00:00:00.000Z', actor: 'rule', kind: 'route', text: 'Production write' }], route: { target: 'you', confidence: 1, reason: 'Production writes are prohibited', router: 'rule' } },
]
function locale() {
  const ctx = new Context(); onTestFinished(async () => { await ctx.fiber.dispose() })
  const service = new LocaleRuntime(ctx); service.register('switchboardGraphs', { en, zh: en })
  return service.bind('switchboardGraphs')
}
function stream() {
  let closed = false; let wake = (): void => {}
  const queue: CardFrame[] = [{ cards }]
  const dispose = vi.fn(() => { closed = true; wake() })
  const handle: RemoteStreamHandle<CardFrame, never> = { dispose, send: () => {}, end: () => {}, async *[Symbol.asyncIterator]() {
    while (!closed) { if (queue.length) yield queue.shift()!; else await new Promise<void>((resolve) => { wake = resolve }) }
  } }
  return { handle, dispose, push(frame: CardFrame) { queue.push(frame); wake() } }
}
function fixture() {
  const feed = stream()
  const api = {
    'graphs.list': vi.fn<presentation.GraphsFace['graphs.list']>().mockResolvedValue({ ok: true, value: [graph] }),
    'graphs.memory': vi.fn<presentation.GraphsFace['graphs.memory']>().mockResolvedValue({ ok: true, value: 'Invoice cutoff: 09:00 UTC.' }),
    'graphs.save': vi.fn<presentation.GraphsFace['graphs.save']>().mockResolvedValue({ ok: true, value: graph }),
    'graphs.delete': vi.fn<presentation.GraphsFace['graphs.delete']>().mockResolvedValue({ ok: true, value: undefined }),
    'flows.list': vi.fn<presentation.GraphsFace['flows.list']>().mockResolvedValue({ ok: true, value: [] }),
    'cards.create': vi.fn<presentation.GraphsFace['cards.create']>().mockResolvedValue({ ok: true, value: cards[0]! }),
    'cards.approve': vi.fn<presentation.GraphsFace['cards.approve']>().mockResolvedValue({ ok: true, value: cards[1]! }),
    'cards.reject': vi.fn<presentation.GraphsFace['cards.reject']>().mockResolvedValue({ ok: true, value: cards[1]! }),
    'cards.reroute': vi.fn<presentation.GraphsFace['cards.reroute']>().mockResolvedValue({ ok: true, value: cards[1]! }),
    'router.test': vi.fn<presentation.GraphsFace['router.test']>().mockResolvedValue({ ok: true, value: cards[0]!.route! }),
    followCards: vi.fn<presentation.GraphsFace['followCards']>().mockReturnValue(feed.handle),
  }
  const view = render(<GraphsPage api={api} t={locale()} />)
  return { api, feed, view }
}
it('renders all four board columns, usage, confidence, reasons, and human actions from fixtures', () => {
  const t = locale(); const approve = vi.fn(); const reroute = vi.fn()
  const view = render(<>
    <CardBoard cards={cards} graphs={[graph]} t={t} pending={false}
      select={() => {}} approve={approve} reject={() => {}} reroute={reroute} />
    <RoutingLog cards={cards} graphs={[graph]} t={t} select={() => {}} />
  </>)
  for (const name of ['New', 'Running', 'Needs you', 'Done']) expect(screen.getByRole('region', { name })).toBeTruthy()
  expect(screen.getByText('95%')).toBeTruthy()
  expect(screen.getByText('50 tokens')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Approve' })); expect(approve).toHaveBeenCalledWith(cards[1]?.id)
  fireEvent.change(screen.getByRole('combobox', { name: 'Destination' }), { target: { value: 'billing' } })
  fireEvent.click(screen.getByRole('button', { name: 'Reroute' })); expect(reroute).toHaveBeenCalledWith(cards[1]?.id, graph.id)
  expect(view.container.textContent).toMatchSnapshot('board and routing copy')
})
it('streams cards, opens the graph lead and timeline, submits a new card, and disposes its follower', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: 'Billing' })
  expect(f.api['cards.create']).not.toHaveBeenCalled(); expect(f.api['router.test']).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Routing log' }))
  expect(screen.getByText('95%')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Billing' }))
  expect(screen.getByText('/memory/billing')).toBeTruthy()
  expect(screen.getByText('Check evidence.')).toBeTruthy()
  await screen.findByText('Invoice cutoff: 09:00 UTC.')
  fireEvent.click(within(screen.getByRole('region', { name: 'Needs you' })).getByRole('button', { name: 'Deploy prod' }))
  expect(screen.getByText('Production write')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'New card' }), { target: { value: 'New invoice' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'What needs doing?' }), { target: { value: 'Explain it' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Workspace path' }), { target: { value: '/work' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send to inbox' }))
  await waitFor(() => { expect(f.api['cards.create']).toHaveBeenCalledWith({ title: 'New invoice', body: 'Explain it', workspace: '/work', source: 'manual' }) })
  await act(async () => { f.feed.push({ cards: [{ ...cards[0]!, state: 'done', result: 'Explained' }] }) })
  expect(within(screen.getByRole('region', { name: 'Done' })).getByRole('button', { name: 'Explain invoice' })).toBeTruthy()
  f.view.unmount(); expect(f.feed.dispose).toHaveBeenCalled()
})
it('registers Graphs independently and removes all contributions on unload', async () => {
  const ctx = new Context(); onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await(); ctx.provide('locale', new LocaleRuntime(ctx)); new TestRemote(ctx, { switchboard: {} })
  const fiber = ctx.plugin(presentation); await fiber.await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } } } as never, () => null)
  expect(slots.entries('sidebar.panellist')[0]?.options.id).toBe('switchboard-graphs')
  expect(slots.entries('main')[0]?.component).toBe(GraphsPage)
  await fiber.dispose(); expect(slots.entries('main')).toHaveLength(0)
})
