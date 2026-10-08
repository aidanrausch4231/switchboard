import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context, AuthorizationService, credentialKey, LocalCredentialProvider } from '../src/dsh.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { subscriptionAdapter } from '../src/subscriptions-adapter.ts'
import { Subscriptions } from '../src/subscriptions.ts'
import type { SubscriptionFrame } from '../src/subscription-types.ts'

it.each([
  { action: 'cancel', window: 'commit' }, { action: 'dispose', window: 'commit' },
  { action: 'cancel', window: 'fence' }, { action: 'dispose', window: 'fence' },
] as const)('$action waits for the credential $window without enabling the route', async ({ action, window }) => {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-commit-'))
  const ctx = new Context()
  const release = Promise.withResolvers<undefined>()
  let consuming = Promise.resolve()
  onTestFinished(async () => {
    release.resolve(undefined)
    await consuming
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  const key = credentialKey('llm-pi-ai', 'openai-codex')
  const holding = Promise.withResolvers<undefined>()
  const hold = () => ctx.credentials.modifyRecord(key, async () => {
    holding.resolve(undefined)
    await release.promise
    return undefined
  })
  let blocker = window === 'commit' ? hold() : Promise.resolve()
  if (window === 'commit') await holding.promise
  const queued = Promise.withResolvers<undefined>()
  const flowDone = Promise.withResolvers<undefined>()
  const updated = vi.fn()
  ctx.on('credentials/record-updated', updated)
  ctx.authorization.registerFlow({ key, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'OAuth' }],
    async run(session) {
      // pi-ai writes through its credential store, not session.commit().
      session.signal.throwIfAborted()
      const commit = ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { fixture: true } }))
      queued.resolve(undefined)
      try { await commit }
      finally { flowDone.resolve(undefined) }
    },
  })
  const authorizationSettled = Promise.withResolvers<undefined>()
  ctx.on('authorization/settled', (_key, status) => {
    if (window === 'fence' && status === 'authorized') blocker = hold()
    authorizationSettled.resolve(undefined)
  })
  const begin = vi.spyOn(ctx.authorization, 'begin')
  const modify = vi.spyOn(ctx.credentials, 'modifyRecord')
  const adapter = subscriptionAdapter(ctx, () => true)
  const enable = vi.fn(adapter.enable)
  const service = new Subscriptions({ ...adapter, enable })
  const controller = new AbortController()
  const frames: SubscriptionFrame[] = []
  let ended = false
  consuming = (async () => {
    for await (const frame of service.signIn('openai-codex', controller.signal)) frames.push(frame)
    ended = true
  })()
  await queued.promise
  if (window === 'fence') {
    expect(await begin.mock.results[0]!.value).toEqual({ status: 'authorized' })
    await holding.promise
    // The flow committed, begin returned, and the adapter queued its fence behind hold().
    expect(modify).toHaveBeenCalledTimes(3)
    expect(updated).toHaveBeenCalledTimes(1)
  }
  let disposed = false
  const disposing = action === 'dispose' ? service.dispose().then(() => { disposed = true }) : undefined
  if (action === 'cancel') controller.abort()
  await authorizationSettled.promise
  // Drain runnable continuations while the credential queue remains explicitly blocked.
  await setImmediate()
  expect(ended).toBe(false)
  expect(disposed).toBe(false)
  expect(frames.every(frame => frame.status === 'working')).toBe(true)
  expect(updated).toHaveBeenCalledTimes(window === 'commit' ? 0 : 1)
  expect(enable).not.toHaveBeenCalled()
  if (action === 'cancel') {
    const duplicate = service.signIn('openai-codex', new AbortController().signal)[Symbol.asyncIterator]()
    expect((await duplicate.next()).value).toEqual({ status: 'failed', error: 'busy' })
    await duplicate.return?.()
  }
  release.resolve(undefined)
  await blocker
  await consuming
  await disposing
  await flowDone.promise
  expect(updated).toHaveBeenCalledTimes(1)
  expect(await ctx.credentials.describeRecord(key)).toMatchObject({ configured: true, kind: 'grant' })
  expect(frames.at(-1)).toEqual({ status: 'cancelled' })
  expect(enable).not.toHaveBeenCalled()
  await service.dispose()
})
