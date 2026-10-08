/** Council navigation and generated Remote callbacks. */
import { type Context } from './dsh.ts'
import type {} from '@switchboard/council/remote'
import { type MainPanelId } from './dsh.ts'
import { IconThinkOutlineRegular } from './dsh.ts'
import { CouncilPage } from './CouncilPage.tsx'
import { en, type CouncilKey } from './council-locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { switchboardCouncil: CouncilKey }
}

/** The Council page uses only its generated browser API. */
export type CouncilFace = Context['remote']['switchboardCouncil']

/** Council may activate independently of the connectivity page. */
export const inject = ['slots', 'locale', 'remote', 'remote.switchboardCouncil']

/**
 * Register Council for the sidebar and main-slot lifetimes.
 * @param ctx - browser context with the Council namespace mounted.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('switchboardCouncil', { en, zh: en }), 'council: dictionary')
  const t = ctx.locale.bind('switchboardCouncil')
  const panelId = 'switchboard-council' as MainPanelId
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, order: 11,
    label: () => t('title'), locale: 'switchboardCouncil',
  }, IconThinkOutlineRegular))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, locale: 'switchboardCouncil',
    inject: () => ({ api: ctx.remote.switchboardCouncil }),
  }, CouncilPage))
}
