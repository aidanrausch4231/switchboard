/** Graphs navigation and generated Remote callbacks. */
import { type Context } from './dsh.ts'
import type {} from '@switchboard/core/remote'
import { type MainPanelId } from './dsh.ts'
import { IconThinkOutlineRegular } from './dsh.ts'
import { GraphsPage } from './GraphsPage.tsx'
import { en, type GraphsKey } from './graphs-locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { switchboardGraphs: GraphsKey }
}
/** Only generated API operations used by Graphs. */
export type GraphsFace = Pick<Context['remote']['switchboard'], 'graphs.list' | 'graphs.save' | 'graphs.delete' | 'graphs.memory' | 'flows.list' | 'cards.create' | 'cards.approve' | 'cards.reject' | 'cards.reroute' | 'followCards' | 'router.test'>
/** Graphs activates after its generated namespace is mounted. */
export const inject = ['slots', 'locale', 'remote', 'remote.switchboard']
/** Register page and navigation for the owner-slot lifetime.
 * @param ctx - browser context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('switchboardGraphs', { en, zh: en }), 'graphs: dictionary')
  const t = ctx.locale.bind('switchboardGraphs')
  const panelId = 'switchboard-graphs' as MainPanelId
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panelId, order: 10, label: () => t('title'), locale: 'switchboardGraphs' }, IconThinkOutlineRegular))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId, locale: 'switchboardGraphs', inject: () => ({ api: ctx.remote.switchboard }) }, GraphsPage))
}
