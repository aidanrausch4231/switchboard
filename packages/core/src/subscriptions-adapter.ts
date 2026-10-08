/** dsh-only subscription integration: safe credential descriptions, OAuth, and live profile settings. */
import { credentialKey, supportsCodexLogin, type Context } from './dsh.ts'
import { subscriptionProviders, type SubscriptionAdapter } from './subscriptions.ts'

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}

/** Bind dsh services lazily so non-Web compositions can still use Flows.
 * @param ctx - owning Switchboard context; missing services fail explicitly when used.
 * @returns the only subscription component that knows dsh service names.
 */
export function subscriptionAdapter(ctx: Context, codexLogin = supportsCodexLogin): SubscriptionAdapter {
  return {
    async list() {
      const credentials = ctx.get('credentials')
      const llm = ctx.get('llm')
      if (!credentials || !llm) throw new Error('Subscription services unavailable')
      const routes = new Set(llm.listProviders().map(row => row.id))
      return Promise.all(subscriptionProviders.map(async (row) => {
        const info = await credentials.describeRecord(credentialKey('llm-pi-ai', row.id))
        return { ...row, signedIn: info.configured && info.kind === 'grant', routeEnabled: routes.has(row.id),
          ...(row.id === 'openai-codex' && !codexLogin() ? { needsPiAi: true } : {}) }
      }))
    },
    async login(id, interaction, signal) {
      if (id === 'openai-codex' && !codexLogin()) throw new Error('ChatGPT needs pi-ai >= 1.0')
      const authorization = ctx.get('authorization')
      const credentials = ctx.get('credentials')
      if (!authorization || !credentials) throw new Error('Subscription authorization unavailable')
      const key = credentialKey('llm-pi-ai', id)
      try { return (await authorization.begin({ key, method: 'oauth', interaction, signal })).status }
      finally {
        // Fence pi-ai's queued write: cancellation does not roll back an admitted commit.
        await credentials.modifyRecord(key, () => Promise.resolve(undefined))
      }
    },
    async logout(id) {
      const credentials = ctx.get('credentials')
      if (!credentials) throw new Error('Subscription credentials unavailable')
      await credentials.deleteRecord(credentialKey('llm-pi-ai', id))
    },
    async enable(id) {
      const settings = ctx.get('settings')
      const llm = ctx.get('llm')
      if (!settings || !llm) return { ok: false, error: 'unavailable' }
      const route = llm.listConfigurableProviders().find(row => row.provider === id && !row.declared)
      if (!route) return { ok: false, error: 'unavailable' }
      const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === route.settingsNs)
      if (!descriptor) return { ok: false, error: 'unavailable' }
      const profile = field(field(descriptor.value, 'providers'), id)
      // Do not silently change an existing route's billing or discard endpoint/model overrides.
      if (field(profile, 'apiKeyEnv') !== undefined) return { ok: false, error: 'apiKey' }
      if (profile === undefined) {
        await settings.mutate(route.settingsNs, [{ op: 'set', path: route.settingsPath, value: {} }], descriptor.revision)
      }
      return llm.listProviders().some(row => row.id === id) ? { ok: true } : { ok: false, error: 'route' }
    },
  }
}
