import { expect, it, vi } from 'vitest'
import { Subscriptions, subscriptionProviders, type SubscriptionAdapter, type SubscriptionInteraction } from '../src/subscriptions.ts'
import type { SubscriptionFrame, SubscriptionId, SubscriptionPromptId } from '../src/subscription-types.ts'

function fixture(login: SubscriptionAdapter['login']) {
  const adapter: SubscriptionAdapter = {
    list: async () => subscriptionProviders.map(row => ({ ...row, signedIn: false, routeEnabled: false })),
    login, enable: vi.fn(async () => ({ ok: true as const })), logout: vi.fn(async () => {}),
  }
  return { adapter, service: new Subscriptions(adapter) }
}
async function next(iterator: AsyncIterator<SubscriptionFrame>, test: (frame: SubscriptionFrame) => boolean): Promise<SubscriptionFrame> {
  for (;;) {
    const frame = await iterator.next()
    if (frame.done) throw new Error('Expected another sign-in frame')
    if (test(frame.value)) return frame.value
  }
}

it.each(['openai-codex', 'anthropic'] as const)('runs %s browser login, masks pasted answers and enables models after authorization', async (id) => {
  let answer = ''
  const { service, adapter } = fixture(async (_id, interaction) => {
    interaction.notify({ url: `https://example.com/authorize?state=public-pkce-state&${id === 'anthropic' ? 'code=true' : 'id_token_add_organizations=true'}` })
    answer = await interaction.prompt({ kind: 'text' })
    return 'authorized'
  })
  const stream = service.signIn(id, new AbortController().signal)[Symbol.asyncIterator]()
  const question = await next(stream, frame => Boolean(frame.prompt))
  expect(question.url).toContain(id === 'anthropic' ? 'code=true' : 'id_token_add_organizations=true')
  expect(question.prompt?.kind).toBe('code')
  expect(service.answer(id, question.prompt!.id, 'private-redirect-code')).toEqual({ ok: true })
  const terminal = await next(stream, frame => frame.status !== 'working')
  expect(terminal).toEqual({ status: 'authorized' })
  expect(answer).toBe('private-redirect-code')
  expect(JSON.stringify([question, terminal])).not.toContain(answer)
  expect(adapter.enable).toHaveBeenCalledWith(id)
  expect((await stream.next()).done).toBe(true)
})

it.each(subscriptionProviders.flatMap(({ id }) => ['plain', 'encoded', 'duplicated'].map(encoding => ({ id, encoding }))))('rejects $encoding exchange secrets and unknown URL parameters for $id', async ({ id, encoding }) => {
  const keys = ['device_code', 'code_verifier', 'client_secret', 'access_token', 'refresh_token', 'future_exchange_secret', 'code']
  const { service } = fixture(async (_id, interaction) => {
    for (const key of keys) {
      const secret = encoding === 'encoded' ? `${key.replaceAll('_', '%5F')}=%50RIVATE_EXCHANGE_SECRET`
        : `${encoding === 'duplicated' ? `${key}=true&` : ''}${key}=PRIVATE_EXCHANGE_SECRET`
      interaction.notify({ url: `https://example.com/device?${secret}`, code: 'ABCD-1234' })
      await interaction.prompt({ kind: 'text' })
    }
    return 'authorized'
  })
  const stream = service.signIn(id, new AbortController().signal)[Symbol.asyncIterator]()
  for (const _key of keys) {
    const frame = await next(stream, frame => Boolean(frame.prompt))
    expect(frame.url).toBeUndefined()
    expect(JSON.stringify(frame)).not.toContain('PRIVATE_EXCHANGE_SECRET')
    expect(service.answer(id, frame.prompt!.id, 'continue')).toEqual({ ok: true })
  }
  await next(stream, frame => frame.status === 'authorized')
  await stream.next()
})

it.each(['github-copilot', 'kimi-coding', 'meta', 'xai'] as const)('preserves the public user code URL for %s', async (id) => {
  const url = 'https://example.com/device?user_code=ABCD-1234'
  const { service } = fixture(async (_id, interaction) => {
    interaction.notify({ url })
    await interaction.prompt({ kind: 'text' })
    return 'authorized'
  })
  const stream = service.signIn(id, new AbortController().signal)[Symbol.asyncIterator]()
  const frame = await next(stream, frame => Boolean(frame.prompt))
  expect(frame.url).toBe(url)
  service.answer(id, frame.prompt!.id, 'continue')
  await next(stream, frame => frame.status === 'authorized')
  await stream.next()
})

it('offers known methods, retains a device code across progress, and never returns token-bearing errors or logs', async () => {
  const token = 'secret-access-refresh-token-12345'
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
  try {
    let notify!: SubscriptionInteraction['notify']
    let fail!: (error: Error) => void
    const { service } = fixture(async (_id, interaction) => {
      notify = interaction.notify
      const method = await interaction.prompt({ kind: 'select', options: [{ id: 'browser' }, { id: 'device_code' }] })
      expect(method).toBe('device_code')
      interaction.notify({ url: 'https://example.com/device', code: 'ABCD-1234' })
      await new Promise<void>((_resolve, reject) => { fail = reject })
      return 'authorized'
    })
    const stream = service.signIn('openai-codex', new AbortController().signal)[Symbol.asyncIterator]()
    const question = await next(stream, frame => Boolean(frame.prompt))
    expect(service.answer('openai-codex', question.prompt!.id, token)).toEqual({ ok: false, error: 'answer' })
    expect(service.answer('openai-codex', question.prompt!.id, 'device_code')).toEqual({ ok: true })
    const device = await next(stream, frame => Boolean(frame.code))
    notify({})
    const progress = await next(stream, frame => Boolean(frame.code))
    expect(progress).toEqual(device)
    fail(new Error(`Token exchange failed: ${token}`))
    const terminal = await next(stream, frame => frame.status === 'failed')
    expect(terminal).toEqual({ status: 'failed', error: 'signin' })
    await stream.next()
    expect(JSON.stringify([question, device, progress, terminal, logs.flatMap(log => log.mock.calls)])).not.toContain(token)
  } finally { for (const log of logs) log.mockRestore() }
})

it('cancels pending prompts, refuses concurrent sign-in, and rejects answers from a previous attempt', async () => {
  const { service, adapter } = fixture(async (_id, interaction) => { await interaction.prompt({ kind: 'text' }); return 'authorized' })
  const lifetime = new AbortController()
  const stream = service.signIn('anthropic', lifetime.signal)[Symbol.asyncIterator]()
  const first = await next(stream, frame => Boolean(frame.prompt))
  const duplicate = service.signIn('anthropic', lifetime.signal)[Symbol.asyncIterator]()
  expect((await duplicate.next()).value).toEqual({ status: 'failed', error: 'busy' })
  lifetime.abort()
  expect((await next(stream, frame => frame.status !== 'working')).status).toBe('cancelled')
  await stream.next()
  expect(adapter.enable).not.toHaveBeenCalled()
  const second = service.signIn('anthropic', new AbortController().signal)[Symbol.asyncIterator]()
  const current = await next(second, frame => Boolean(frame.prompt))
  expect(current.prompt!.id).not.toBe(first.prompt!.id)
  expect(service.answer('anthropic', first.prompt!.id, 'old')).toEqual({ ok: false, error: 'answer' })
  await service.dispose()
  expect((await next(second, frame => frame.status !== 'working')).status).toBe('cancelled')
  await second.next()
})

it('withdraws only the losing callback prompt without cancelling the successful browser login', async () => {
  const question = new AbortController()
  let finish!: () => void
  const { service } = fixture(async (_id, interaction) => {
    void interaction.prompt({ kind: 'text', signal: question.signal }).catch(() => {})
    await new Promise<void>((resolve) => { finish = resolve })
    return 'authorized'
  })
  const stream = service.signIn('anthropic', new AbortController().signal)[Symbol.asyncIterator]()
  await next(stream, frame => Boolean(frame.prompt))
  question.abort()
  expect((await next(stream, frame => !frame.prompt)).status).toBe('working')
  finish()
  expect((await next(stream, frame => frame.status !== 'working')).status).toBe('authorized')
  await stream.next()
})

it('keeps failed route enablement distinct from successful authorization and safely signs out', async () => {
  const { service, adapter } = fixture(async () => 'authorized')
  vi.mocked(adapter.enable).mockResolvedValue({ ok: false, error: 'apiKey' })
  const frames = []
  for await (const frame of service.signIn('xai', new AbortController().signal)) frames.push(frame)
  expect(frames.at(-1)).toEqual({ status: 'failed', error: 'apiKey' })
  expect(await service.signOut('xai')).toEqual({ ok: true })
  expect(adapter.logout).toHaveBeenCalledWith('xai')
  vi.mocked(adapter.logout).mockRejectedValue(new Error('secret-from-credential-store'))
  expect(await service.signOut('xai')).toEqual({ ok: false, error: 'signout' })
  const listed = await service.list()
  expect(listed.ok).toBe(true)
  if (listed.ok) expect(listed.providers[0]).toEqual({ id: 'openai-codex', label: 'ChatGPT', signedIn: false, routeEnabled: false })
})

it('rejects unknown routes, stale or oversized answers, unsafe links and unsupported methods', async () => {
  const { service } = fixture(async (_id, interaction) => {
    interaction.notify({ url: 'javascript:alert(1)', code: 'secret with spaces' })
    interaction.notify({ url: 'https://example.com/?access_token=private' })
    await interaction.prompt({ kind: 'select', options: [{ id: 'private-token' }] })
    return 'authorized'
  })
  const frames = []
  for await (const frame of service.signIn('meta', new AbortController().signal)) frames.push(frame)
  expect(frames).toEqual([{ status: 'working' }, { status: 'failed', error: 'signin' }])
  expect(await service.enableRoute('bad' as SubscriptionId)).toEqual({ ok: false, error: 'unavailable' })
  expect(service.answer('meta', 'old' as SubscriptionPromptId, 'x'.repeat(9000))).toEqual({ ok: false, error: 'answer' })
})
