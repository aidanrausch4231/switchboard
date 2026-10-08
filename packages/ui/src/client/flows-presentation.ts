/** Register the Flows page and Session-scoped Flow dock without changing the shell. */
import { type Context } from './dsh.ts'
import { type MainPanelId } from './dsh.ts'



import { type RemoteResult } from './dsh.ts'
import type { FlowRun } from '@switchboard/core/types'
import { type SessionId } from './dsh.ts'
import type { FlowsFace } from './flow-types.ts'
import { FlowsPage } from './FlowsPage.tsx'
import { SwitchboardIcon } from './SwitchboardPage.tsx'
import { RunPanel, FlowTitle, type RunInjection } from './RunPanel.tsx'
import { RunModel } from './run-model.ts'
import { RunCard, runDefinition } from './run-card.tsx'


/** Resolve transport failure before it reaches presentation state.
 * @param request - one generated unary call.
 * @returns its successful value.
 */
export async function valueOf<T>(request: Promise<RemoteResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Dependencies consumed only by the full editor and dock. */
export const inject = ['slots', 'locale', 'remote', 'remote.switchboard', 'sidebarRight', 'sidebarRightTabs', 'layout', 'sessions', 'uiWorkspace']
/** Install reversible page and dock contributions.
 * @param ctx - browser service context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('switchboard')
  const remote = ctx.remote.switchboard
  const model = new RunModel(id => ctx.remote.$stream({ name: `switchboard run ${id}`,
    open: signal => remote.followRuns(id, signal), ended: () => new Error('Flow stream ended before completion'),
  }))
  const lifetime = new AbortController()
  ctx.effect(() => async () => { lifetime.abort(); await model.dispose() }, 'switchboard.run-model')
  let lastSession: SessionId | undefined
  const openRun = async (run: FlowRun): Promise<void> => {
    const cwd = run.flow.blocks.find(block => block.kind === 'agent')?.scope.cwd
    const existing = ctx.sidebarRight.mounted.getSnapshot() ?? lastSession ?? run.attempts.find(attempt => attempt.sessionId)?.sessionId
    const sessionId = existing ?? await ctx.sessions.create(cwd ? { cwd } : {})
    lifetime.signal.throwIfAborted()
    lastSession = sessionId
    // The dock belongs to a Conversation, never the root-scoped Flows page.
    if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) {
      await new Promise<void>((resolve, reject) => {
        const finish = (): void => { if (ctx.sidebarRight.mounted.getSnapshot() === sessionId) { dispose(); lifetime.signal.removeEventListener('abort', abort); resolve() } }
        const abort = (): void => { dispose(); reject(new Error('Flow navigation disposed')) }
        const dispose = ctx.sidebarRight.mounted.subscribe(finish)
        lifetime.signal.addEventListener('abort', abort, { once: true })
        ctx.uiWorkspace.openSession(sessionId)
        finish()
      })
    }
    ctx.sidebarRight.openTab('switchboard-flow', { params: { runId: run.id } })
  }
  const face: FlowsFace = {
    workspace: () => Object.values(ctx.sessions.list.getSnapshot().byId).find(session => session.retainedBy.mainView)?.cwd,
    listFlows: () => valueOf(remote['flows.list']()), saveFlow: flow => valueOf(remote['flows.save'](flow)),
    getLayout: id => valueOf(remote['flows.layout.get'](id)), saveLayout: (id, layout) => valueOf(remote['flows.layout.save'](id, layout)),
    preflight: async (flow, inputs) => {
      const structural = await valueOf(remote['flows.validate'](flow))
      return structural.ok ? valueOf(remote['flows.preflight'](flow, inputs)) : structural
    }, validate: flow => valueOf(remote['flows.validate'](flow)),
    start: (id, inputs) => valueOf(remote['runs.start'](id, inputs)), listRuns: () => valueOf(remote['runs.list']()), openRun,
  }
  const runs: RunInjection = { hooks: { runs: model.source }, watch: id => model.watch(id), approve: (id, block, approve) => valueOf(remote['runs.approveGate'](id, block, approve)), cancel: id => valueOf(remote['runs.cancel'](id)) }
  const panelId = 'switchboard-flows' as MainPanelId
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panelId, order: 21, label: () => t('flows') }, SwitchboardIcon))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId, locale: 'switchboard', inject: () => face }, FlowsPage))
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: 'switchboard-flow', kind: 'switchboard-flow', title: () => t('flow') }), 'switchboard.flow-tab')
  ctx.inject(['uiConversation'], (scope) => {
    scope.effect(() => scope.uiConversation.events.register(runDefinition), 'switchboard.run-definition')
    scope.slots.inject('conversation.chat.node', () => scope.slots.register({ name: 'conversation.chat.node', key: 'switchboard-run', locale: 'switchboard', inject: () => ({ ...runs, openRun }) }, RunCard))
  })
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'switchboard-flow', locale: 'switchboard' }, FlowTitle))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'switchboard-flow', locale: 'switchboard', inject: () => runs }, RunPanel))
}
