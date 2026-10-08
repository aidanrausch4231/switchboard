/** Independent Automations navigation, Remote callbacks and app-wide outcome notices. */
import { useSyncExternalStore, type ReactNode } from 'react'
import { type Context } from './dsh.ts'

import type {} from '@switchboard/core/remote'



import { type MainPanelId } from './dsh.ts'
import { type PropsLocale, type PropsRuntime } from './dsh.ts'
import { IconClockOutlineRegular, Toast } from './dsh.ts'
import { AutomationsPage } from './AutomationsPage.tsx'
import { automationEn, automationZh, type AutomationKey } from './automation-locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { switchboardAutomations: AutomationKey }
}

/** Remote-only page capabilities, independent of Sessions and the Flows editor. */
export interface AutomationsFace {
  api: Pick<Context['remote']['switchboard'], 'automations.list' | 'automations.save' | 'automations.delete' | 'automations.setEnabled' | 'automations.runNow' | 'automations.stats' | 'flows.list' | 'flows.preflight' | 'followRuns'>
  notify: (message: AutomationKey) => void
}
interface Notices {
  subscribe: (listener: () => void) => () => void
  snapshot: () => { key: number; message: AutomationKey } | null
  dismiss: () => void
}

function NoticesView({ notices, t }: { notices: Notices } & PropsLocale<'switchboardAutomations'>): ReactNode {
  const notice = useSyncExternalStore(notices.subscribe, notices.snapshot)
  return notice && <Toast key={notice.key} holdMs={4000} onDone={notices.dismiss} text={t(notice.message)} />
}

function AutomationIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode { return <IconClockOutlineRegular size={size} /> }

/** Browser services used by this presentation. */
export const inject = ['slots', 'locale', 'remote', 'remote.switchboard']

/** Register one page and a notice host whose lifetime outlasts navigation.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('switchboardAutomations', { en: automationEn, zh: automationZh }), 'automations: dictionary')
  const t = ctx.locale.bind('switchboardAutomations')
  let value: ReturnType<Notices['snapshot']> = null
  let key = 0
  const listeners = new Set<() => void>()
  const notify = (message: AutomationKey): void => { value = { key: ++key, message }; for (const listener of listeners) listener() }
  const notices: Notices = {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: () => value,
    dismiss: () => { value = null; for (const listener of listeners) listener() },
  }
  const panelId = 'switchboard-automations' as MainPanelId
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panelId, order: 12, label: () => t('title'), locale: 'switchboardAutomations' }, AutomationIcon))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId, locale: 'switchboardAutomations', inject: (): AutomationsFace => ({ api: ctx.remote.switchboard, notify }) }, AutomationsPage))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'switchboard-automation-notices', locale: 'switchboardAutomations', inject: () => ({ notices }) }, NoticesView))
}
