/** Browser dsh adapter for subscription operations and reversible navigation/slot registrations. */
import type { Context } from './dsh.ts'
import type {} from '@switchboard/core/remote'
import type { MainPanelId } from './dsh.ts'
import { IconLinkOutlineRegular } from './dsh.ts'
import { SubscriptionsCard, SubscriptionsPage, type SubscriptionsFace } from './Subscriptions.tsx'
import { en, type SubscriptionKey } from './subscription-locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { switchboardSubscriptions: SubscriptionKey }
  interface SlotMap {
    /** Register the Home subscription card. Receives only root scope props; provide operations through inject.
     * A registration replaces the single card; without one Home omits the section.
     */
    'switchboard.subscriptions': { kind: 'single'; scope: 'root' }
  }
}
/** Subscribe only after the generated Switchboard Remote namespace is mounted. */
export const inject = ['slots', 'locale', 'remote', 'remote.switchboard']

/** Bind safe browser callbacks without exposing transport errors to React.
 * @param ctx - browser plugin context.
 * @returns subscription operations for both Home and the settings-style page.
 */
export function subscriptionsFace(ctx: Context): SubscriptionsFace {
  const api = ctx.remote.switchboard
  return {
    list: async () => { const result = await api['subscriptions.list'](); return result.ok ? result.value : { ok: false, error: 'unavailable' } },
    signIn: id => api.signInSubscription(id),
    answer: async (id, promptId, value) => { const result = await api['subscriptions.answer'](id, promptId, value); return result.ok ? result.value : { ok: false, error: 'answer' } },
    signOut: async (id) => { const result = await api['subscriptions.signOut'](id); return result.ok ? result.value : { ok: false, error: 'signout' } },
    enable: async (id) => { const result = await api['subscriptions.enableRoute'](id); return result.ok ? result.value : { ok: false, error: 'route' } },
  }
}

/** Register the shared card for either page's slot lifetime.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('switchboardSubscriptions', { en, zh: en }), 'subscriptions: dictionary')
  const t = ctx.locale.bind('switchboardSubscriptions')
  const api = subscriptionsFace(ctx)
  const panel = 'switchboard-subscriptions' as MainPanelId
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panel, order: 22,
    label: () => t('title'), locale: 'switchboardSubscriptions' }, IconLinkOutlineRegular))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panel, locale: 'switchboardSubscriptions',
    inject: () => ({ api }),
  }, SubscriptionsPage))
  ctx.slots.inject('switchboard.subscriptions', () => ctx.slots.register({ name: 'switchboard.subscriptions', locale: 'switchboardSubscriptions',
    inject: () => ({ api }),
  }, SubscriptionsCard))
}
