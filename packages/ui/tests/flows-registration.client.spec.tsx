// @vitest-environment jsdom
import { Context } from '../src/client/dsh.ts'
import { expect, it, onTestFinished } from 'vitest'
import { LocaleRuntime } from '../src/client/dsh.ts'
import { SlotRegistry } from '../src/client/dsh.ts'
import { ConversationEventRegistry } from '../src/client/dsh.ts'
import { SidebarRightTabRegistry } from './fixtures/tab-registry.ts'
import { createSnapshotStore } from '../src/client/dsh.ts'
import { TestRemote } from './fixtures/remote.ts'
import * as presentation from '../src/client/presentation.ts'

it('removes page, dock title/body, tab type and chat definition when the plugin unloads', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  new TestRemote(ctx, { switchboard: {} })
  ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx))
  ctx.provide('sidebarRight', { mounted: createSnapshotStore(undefined) })
  ctx.provide('layout', {})
  ctx.provide('sessions', {})
  ctx.provide('uiWorkspace', {})
  ctx.provide('uiConversation', { events: new ConversationEventRegistry(ctx) })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
    'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
  } } as never, () => null)
  const fiber = ctx.plugin(presentation)
  await fiber.await()
  expect(slots.entries('main').map(entry => entry.options.key)).toContain('switchboard-flows')
  expect(slots.entries('sidebar.right.pane.tab')).toHaveLength(1)
  expect(slots.entries('sidebar.right.pane.tab.title')).toHaveLength(1)
  expect(slots.entries('conversation.chat.node')).toHaveLength(1)
  expect(ctx.sidebarRightTabs.get('switchboard-flow')).toBeDefined()
  expect(ctx.uiConversation.events.entries().map(entry => entry.kind)).toEqual(['switchboard-run'])
  await fiber.dispose()
  expect(slots.entries('main')).toHaveLength(0)
  expect(slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
  expect(slots.entries('sidebar.right.pane.tab.title')).toHaveLength(0)
  expect(slots.entries('conversation.chat.node')).toHaveLength(0)
  expect(ctx.sidebarRightTabs.get('switchboard-flow')).toBeUndefined()
  expect(ctx.uiConversation.events.entries()).toHaveLength(0)
})
