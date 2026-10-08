/** Switchboard sidebar and page registrations. */
import { type Context } from './dsh.ts'

import type {} from '@switchboard/core/remote'

import { type MainPanelId } from './dsh.ts'


import { SwitchboardPage, SwitchboardIcon } from './SwitchboardPage.tsx'
import { en, type SwitchboardKey } from './locales.ts'
import { registerVoice } from './voice/register.ts'
import * as flows from './flows-presentation.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    switchboard: SwitchboardKey
  }
}

/** Injected callbacks used by the page; no Host services enter React. */
export interface PageFace {
  ping: Context['remote']['switchboard']['ping']
  selectPanel: (id: MainPanelId) => void
}

/** Dependencies read by the presentation consumer. */
export const inject = ['slots', 'locale', 'remote', 'remote.switchboard', 'layout']

/**
 * Contribute a navigation entry and its page for each owner-slot lifetime.
 * @param ctx - browser Cordis context with the Switchboard Remote namespace.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('switchboard', { en, zh: en }), 'switchboard: dictionary')
  ctx.plugin(flows)
  const t = ctx.locale.bind('switchboard')
  const panelId = 'switchboard' as MainPanelId
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, order: 20,
    label: () => t('title'), locale: 'switchboard',
  }, SwitchboardIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, locale: 'switchboard',
    children: { 'switchboard.subscriptions': { kind: 'single', scope: 'root' } },
    inject: (): PageFace => ({
      ping: () => ctx.remote.switchboard.ping(),
      selectPanel: (id) => { ctx.layout.selectPanel(id) },
    }),
  }, SwitchboardPage))
  registerVoice(ctx)
}
