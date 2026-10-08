import { Context } from '../src/dsh.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { subscriptionAdapter } from '../src/subscriptions-adapter.ts'

function context(profile: object = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const routes: { id: string; name: string }[] = []
  const describeRecord = vi.fn(async () => ({ configured: true, kind: 'grant', writable: true }))
  const deleteRecord = vi.fn(async () => {})
  const modifyRecord = vi.fn(async () => undefined)
  ctx.provide('credentials', { describeRecord, deleteRecord, modifyRecord })
  const begin = vi.fn(async () => ({ status: 'authorized' }))
  ctx.provide('authorization', { begin })
  const mutate = vi.fn(async () => { routes.push({ id: 'openai-codex', name: 'ChatGPT' }) })
  const describe = vi.fn(() => [{ ns: 'my-pi-ai', revision: 7, value: profile }])
  ctx.provide('settings', { describe, mutate })
  ctx.provide('llm', { listProviders: () => routes,
    listConfigurableProviders: () => [{ provider: 'openai-codex', declared: false, settingsNs: 'my-pi-ai', settingsPath: ['providers', 'openai-codex'] }] })
  return { ctx, adapter: subscriptionAdapter(ctx, () => true), begin, describeRecord, deleteRecord, modifyRecord, describe, mutate, routes }
}

it('refuses ChatGPT OAuth on stock dsh and exposes an actionable upgrade flag', async () => {
  const { ctx, begin } = context()
  const stock = subscriptionAdapter(ctx, () => false)
  expect((await stock.list()).find(row => row.id === 'openai-codex')).toMatchObject({ needsPiAi: true })
  await expect(stock.login('openai-codex', { notify() {}, prompt: async () => '' }, new AbortController().signal)).rejects.toThrow('needs pi-ai >= 1.0')
  expect(begin).not.toHaveBeenCalled()
})

it('writes only a missing route with a revision fence and observes the live registration', async () => {
  const { adapter, mutate, describe } = context({ providers: { anthropic: { models: [{ id: 'kept' }] } } })
  expect(await adapter.enable('openai-codex')).toEqual({ ok: true })
  expect(describe).toHaveBeenCalledWith({ redactSecrets: true })
  expect(mutate).toHaveBeenCalledExactlyOnceWith('my-pi-ai', [{ op: 'set', path: ['providers', 'openai-codex'], value: {} }], 7)
  expect(await adapter.list()).toContainEqual({ id: 'openai-codex', label: 'ChatGPT', signedIn: true, routeEnabled: true })
})

it('retains existing model overrides and refuses API-key precedence rather than changing billing', async () => {
  const first = context({ providers: { 'openai-codex': { models: [{ id: 'kept' }] } } })
  first.routes.push({ id: 'openai-codex', name: 'ChatGPT' })
  expect(await first.adapter.enable('openai-codex')).toEqual({ ok: true })
  expect(first.mutate).not.toHaveBeenCalled()
  const second = context({ providers: { 'openai-codex': { apiKeyEnv: 'PRIVATE_REFERENCE' } } })
  expect(await second.adapter.enable('openai-codex')).toEqual({ ok: false, error: 'apiKey' })
  expect(second.mutate).not.toHaveBeenCalled()
})

it('uses only safe credential descriptions and the OAuth entry point, never reads stored records', async () => {
  const { adapter, begin, describeRecord, deleteRecord, modifyRecord } = context()
  const interaction = { notify: vi.fn(), prompt: vi.fn(async () => 'private-pasted-code') }
  const signal = new AbortController().signal
  expect(await adapter.login('openai-codex', interaction, signal)).toBe('authorized')
  expect(begin).toHaveBeenCalledExactlyOnceWith({ key: 'llm-pi-ai/openai-codex', method: 'oauth', interaction, signal })
  expect(modifyRecord).toHaveBeenCalledWith('llm-pi-ai/openai-codex', expect.any(Function))
  await adapter.list()
  expect(describeRecord).toHaveBeenCalledTimes(6)
  await adapter.logout('openai-codex')
  expect(deleteRecord).toHaveBeenCalledWith('llm-pi-ai/openai-codex')
})
