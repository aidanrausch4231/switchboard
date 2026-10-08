/** Keyless OAuth fixture; profile settings, catalog registration, credentials and Remote remain real. */
import { credentialKey, type Context } from '../../src/dsh.ts'

/** External sign-in replacement depends on the real Host services it drives. */
export const inject = ['authorization', 'credentials']
/** Replace network OAuth only; all records stay in the smoke's isolated DSH_HOME.
 * @param ctx - disposable browser-test composition.
 */
export function apply(ctx: Context): void {
  const original = ctx.authorization.begin.bind(ctx.authorization)
  let xaiFailed = false
  ctx.effect(() => {
    ctx.authorization.begin = async (request) => {
      if (!request.key.startsWith('llm-pi-ai/')) return original(request)
      const id = request.key.slice('llm-pi-ai/'.length)
      if (id === 'xai' && !xaiFailed) {
        xaiFailed = true
        throw new Error('Fixture provider error: MOCK_PRIVATE_ACCESS_TOKEN')
      }
      const signal = request.signal ?? new AbortController().signal
      const method = ['anthropic', 'openai-codex'].includes(id)
        ? await request.interaction.prompt({ kind: 'select', message: 'MOCK_PRIVATE_ACCESS_TOKEN', options: [
          { id: 'browser', label: 'Browser login' }, { id: id === 'anthropic' ? 'copy_code' : 'device_code', label: 'Headless login' },
        ] }) : 'device_code'
      if (id === 'github-copilot') await request.interaction.prompt({ kind: 'text', message: 'GitHub Enterprise domain' })
      if (method === 'device_code') {
        const query = ['kimi-coding', 'meta', 'xai'].includes(id) ? '?device_code=MOCK_PRIVATE_DEVICE_CODE&exchange_secret=MOCK_PRIVATE_EXCHANGE_SECRET' : ''
        request.interaction.notify({ message: 'MOCK_PRIVATE_ACCESS_TOKEN', url: `https://example.com/device${query}`, code: 'ABCD-1234' })
        await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        return { status: 'cancelled' }
      }
      request.interaction.notify({ message: 'MOCK_PRIVATE_ACCESS_TOKEN', url: 'https://example.com/authorize?state=fixture' })
      await request.interaction.prompt({ kind: 'text', message: 'Paste callback', signal })
      if (signal.aborted) return { status: 'cancelled' }
      await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', id), async () => ({ kind: 'grant', payload: {
        type: 'oauth', access: 'MOCK_PRIVATE_ACCESS_TOKEN', refresh: 'MOCK_PRIVATE_REFRESH_TOKEN', expires: Date.now() + 3600_000,
      } }))
      return { status: 'authorized' }
    }
    return () => { ctx.authorization.begin = original }
  }, 'subscriptions fixture')
}
