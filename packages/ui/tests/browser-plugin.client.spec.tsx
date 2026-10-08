// @vitest-environment jsdom
import { Context } from '../src/client/dsh.ts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '../src/client/dsh.ts'

import { SlotRegistry } from '../src/client/dsh.ts'
import { resolveSlotLabel } from '../src/client/dsh.ts'
import { RemoteError } from '../src/client/dsh.ts'
import { TestRemote } from './fixtures/remote.ts'
import { usePinnedBrowserLanguages } from './fixtures/locale-env.ts'
import * as presentation from '../src/client/presentation.ts'
import { SwitchboardIcon, SwitchboardPage } from '../src/client/SwitchboardPage.tsx'
import { en } from '../src/client/locales.ts'

usePinnedBrowserLanguages('en')
afterEach(cleanup)

it('waits for owner slots, registers the sidebar and page, and removes them on unload', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const selectPanel = vi.fn()
  ctx.provide('layout', { selectPanel })
  const ping = vi.fn(async () => ({ ok: true as const, value: { ok: true as const, version: 'test', time: '2026-01-01T00:00:00.000Z' } }))
  new TestRemote(ctx, { switchboard: { ping } })
  const fiber = ctx.plugin(presentation)
  await fiber.await()
  const slots = ctx.get('slots') as SlotRegistry
  expect(slots.entries('main')).toHaveLength(0)
  const declare = () => slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    'conversation.input.activity': { kind: 'single', scope: 'session' },
  } } as never, () => null)
  const removeRoot = declare()
  expect(slots.entries('conversation.input.activity')).toHaveLength(1)
  const nav = slots.entries('sidebar.panellist')[0]!
  expect(resolveSlotLabel(nav.options.label)).toBe('Switchboard')
  expect(nav.options.id).toBe('switchboard')
  const page = slots.entries('main')[0]!
  expect(page.options.key).toBe('switchboard')
  expect(page.component).toBe(SwitchboardPage)
  expect(ping).not.toHaveBeenCalled()
  const injected: object = page.inject!()
  const face = injected as presentation.PageFace
  await expect(face.ping()).resolves.toMatchObject({ ok: true, value: { ok: true } })
  await act(async () => { render(<SwitchboardPage {...seats} {...face} t={translator()} />) })
  for (const [name, panel] of [
    ['Flows', 'switchboard-flows'],
    ['Automations', 'switchboard-automations'],
    ['Graphs', 'switchboard-graphs'],
    ['Council', 'switchboard-council'],
    ['Voice', 'switchboard.voice'],
  ] as const) {
    fireEvent.click(screen.getByRole('button', { name }))
    expect(selectPanel).toHaveBeenLastCalledWith(panel)
  }
  expect(selectPanel).toHaveBeenCalledTimes(5)
  removeRoot()
  expect(slots.entries('main')).toHaveLength(0)
  declare()
  expect(slots.entries('main')).toHaveLength(2)
  expect(slots.entries('sidebar.panellist')[1]?.options.id).toBe('switchboard.voice')
  await fiber.dispose()
  expect(slots.entries('main')).toHaveLength(0)
  expect(slots.entries('sidebar.panellist')).toHaveLength(0)
  expect(slots.entries('conversation.input.activity')).toHaveLength(0)
  expect(slots.entries('switchboard.voice')).toHaveLength(0)
})

function translator() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const locale = new LocaleRuntime(ctx)
  locale.register('switchboard', { en, zh: en })
  return locale.bind('switchboard')
}

const unread = () => { throw new Error('The connectivity page must not read Session state') }
const seats = {
  renderSlot: () => null,
  usePanelInfo: unread, useSessions: unread, useSessionStatus: unread,
  useSessionRetainInfo: unread, useWorkspaces: unread, useResource: unread,
  selectPanel: vi.fn(),
}

it('renders the shared navigation icon', () => {
  const view = render(<SwitchboardIcon {...seats} size={18} active={false} />)
  expect(view.container.querySelector('svg')).not.toBeNull()
})

it('renders a successful ping and describes every workspace page', async () => {
  const ping = vi.fn(async () => ({ ok: true as const, value: { ok: true as const, version: 'test', time: '2026-01-01T00:00:00.000Z' } }))
  render(<SwitchboardPage {...seats} t={translator()} ping={ping} />)
  await screen.findByText('Connected')
  expect(screen.getByText(/"ok": true/)).toBeTruthy()
  for (const description of [
    en.flowsDescription, en.automationsDescription, en.graphsDescription, en.councilDescription, en.voiceDescription,
  ]) {
    expect(screen.getByText(description)).toBeTruthy()
  }
})

it('shows a query failure with a working retry', async () => {
  const ping = vi.fn<presentation.PageFace['ping']>()
    .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
    .mockResolvedValueOnce({ ok: true, value: { ok: true, version: 'test', time: '2026-01-01T00:00:00.000Z' } })
  render(<SwitchboardPage {...seats} t={translator()} ping={ping} />)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Connected')
  expect(ping).toHaveBeenCalledTimes(2)
})

it('keeps the newer ping result when an older response arrives last', async () => {
  type Result = Awaited<ReturnType<presentation.PageFace['ping']>>
  let settleOlder!: (value: Result) => void
  let settleNewer!: (value: Result) => void
  const older = new Promise<Result>((resolve) => { settleOlder = resolve })
  const newer = new Promise<Result>((resolve) => { settleNewer = resolve })
  const olderPing = vi.fn(() => older)
  const newerPing = vi.fn(() => newer)
  const t = translator()
  const view = render(<SwitchboardPage {...seats} t={t} ping={olderPing} />)
  expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Checking Host connection')
  view.rerender(<SwitchboardPage {...seats} t={t} ping={newerPing} />)
  expect(olderPing).toHaveBeenCalledTimes(1)
  expect(newerPing).toHaveBeenCalledTimes(1)
  await act(async () => {
    settleNewer({ ok: true, value: { ok: true, version: 'newer', time: '2026-01-02T00:00:00.000Z' } })
    await newer
  })
  expect(screen.getByText('Connected')).toBeTruthy()
  const currentResult = screen.getByText(/"version": "newer"/).textContent
  await act(async () => {
    settleOlder({ ok: true, value: { ok: true, version: 'older', time: '2026-01-01T00:00:00.000Z' } })
    await older
  })
  expect(screen.getByText('Connected')).toBeTruthy()
  expect(screen.getByText(/"version": "newer"/).textContent).toBe(currentResult)
  expect(screen.queryByText(/"version": "older"/)).toBeNull()
})
