// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Context } from '../src/client/dsh.ts'
import { LocaleRuntime } from '../src/client/dsh.ts'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { SubscriptionsCard, type SubscriptionStream, type SubscriptionsFace } from '../src/client/Subscriptions.tsx'
import { en } from '../src/client/subscription-locales.ts'
import * as subscriptionsPresentation from '../src/client/subscriptions-presentation.ts'
import * as homePresentation from '../src/client/presentation.ts'
import { SlotRegistry } from '../src/client/dsh.ts'
import { TestRemote } from './fixtures/remote.ts'
import type { SubscriptionFrame, SubscriptionPromptId } from '@switchboard/core/types'
import { usePinnedBrowserLanguages } from './fixtures/locale-env.ts'

usePinnedBrowserLanguages('en')
afterEach(cleanup)

it('mounts Home and the subscription page together without duplicate slot ownership and unregisters on unload', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('layout', { selectPanel: vi.fn() })
  new TestRemote(ctx, { switchboard: {} })
  ctx.slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const home = ctx.plugin(homePresentation)
  const subscriptions = ctx.plugin(subscriptionsPresentation)
  await home.await(); await subscriptions.await()
  expect(ctx.slots.entries('main').map(row => row.options.key)).toContain('switchboard-subscriptions')
  expect(ctx.slots.entries('sidebar.panellist').map(row => row.options.id)).toContain('switchboard-subscriptions')
  expect(ctx.slots.entries('switchboard.subscriptions')).toHaveLength(1)
  await subscriptions.dispose()
  expect(ctx.slots.entries('switchboard.subscriptions')).toHaveLength(0)
  expect(ctx.slots.entries('main').map(row => row.options.key)).not.toContain('switchboard-subscriptions')
})
function setup(needsPiAi = false) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const locale = new LocaleRuntime(ctx)
  locale.register('switchboardSubscriptions', { en, zh: en })
  const t = locale.bind('switchboardSubscriptions')
  let wake: (() => void) | undefined
  let closed = false
  const frames: SubscriptionFrame[] = []
  const stream: SubscriptionStream = {
    dispose: vi.fn(() => { closed = true; wake?.() }),
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        const frame = frames.shift()
        if (frame) yield frame
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    },
  }
  const providers = [{ id: 'openai-codex' as const, label: 'ChatGPT', signedIn: false, routeEnabled: false, needsPiAi }]
  const api: SubscriptionsFace = {
    list: vi.fn<SubscriptionsFace['list']>(async () => ({ ok: true, providers: structuredClone(providers) })),
    signIn: vi.fn(() => stream), answer: vi.fn<SubscriptionsFace['answer']>(async () => ({ ok: true })),
    signOut: vi.fn<SubscriptionsFace['signOut']>(async () => { providers[0]!.signedIn = false; return { ok: true } }),
    enable: vi.fn<SubscriptionsFace['enable']>(async () => { providers[0]!.routeEnabled = true; return { ok: true } }),
  }
  const view = render(<SubscriptionsCard api={api} t={t} />)
  const push = async (frame: SubscriptionFrame) => { await act(async () => { frames.push(frame); wake?.() }) }
  return { api, stream, providers, view, push }
}

it('shows the stock-dsh ChatGPT upgrade message instead of starting a broken login', async () => {
  const { api } = setup(true)
  const button = await screen.findByRole('button', { name: 'Sign in' })
  expect((button as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(en.needsPiAi)).toBeTruthy()
  fireEvent.click(button)
  expect(api.signIn).not.toHaveBeenCalled()
})

it('renders a browser flow, masks the pasted response, and displays safe sign-in errors', async () => {
  const { api, push } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
  await push({ status: 'working', url: 'https://example.com/login', prompt: { id: 'p1' as SubscriptionPromptId, kind: 'code', options: [] } })
  expect(screen.getByRole('link', { name: 'Open sign-in page' }).getAttribute('rel')).toBe('noopener noreferrer')
  const input = screen.getByLabelText('Paste the authorization code or redirect URL')
  expect(input.getAttribute('type')).toBe('password')
  fireEvent.change(input, { target: { value: 'private-redirect-answer' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(api.answer).toHaveBeenCalledWith('openai-codex', 'p1', 'private-redirect-answer')
  expect((input as HTMLInputElement).value).toBe('')
  await push({ status: 'failed', error: 'signin' })
  expect(screen.getByRole('alert').textContent).toBe(en.signinError)
  expect(document.body.textContent).not.toContain('private-redirect-answer')
})

it('offers login methods, copies a device user code, and cancels on request and unmount', async () => {
  const { api, stream, push, view } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
  await push({ status: 'working', prompt: { id: 'p1' as SubscriptionPromptId, kind: 'method', options: ['browser', 'device_code'] } })
  fireEvent.click(screen.getByRole('button', { name: 'Device code' }))
  expect(api.answer).toHaveBeenCalledWith('openai-codex', 'p1', 'device_code')
  await push({ status: 'working', url: 'https://example.com/device', code: 'ABCD-1234' })
  const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await screen.findByText('Copied')
    expect(writeText).toHaveBeenCalledWith('ABCD-1234')
  } finally {
    if (prior) Object.defineProperty(navigator, 'clipboard', prior)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await screen.findByText('Sign-in cancelled')
  expect(stream.dispose).toHaveBeenCalled()
  view.unmount()
})

it('refreshes signed-in and route states after completion and signs out without hiding the row', async () => {
  const { providers, stream, push } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
  providers[0]!.signedIn = true
  providers[0]!.routeEnabled = true
  await push({ status: 'authorized' })
  await act(async () => { stream.dispose() })
  await screen.findByText('Signed in ✓')
  expect(screen.getByText('Models enabled')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  await screen.findByRole('button', { name: 'Sign in' })
  expect(within(screen.getByRole('group', { name: 'ChatGPT' })).getByText('Models enabled')).toBeTruthy()
})

it('retains the row and offers route recovery after a saved grant cannot enable models', async () => {
  const { providers, stream, push } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
  providers[0]!.signedIn = true
  await push({ status: 'failed', error: 'route' })
  await act(async () => { stream.dispose() })
  expect(screen.getByRole('alert').textContent).toBe(en.route)
  fireEvent.click(await screen.findByRole('button', { name: 'Enable models' }))
  await screen.findByText('Models enabled')
  expect(screen.queryByRole('alert')).toBeNull()
})
