import { expect, it } from 'vitest'
import { ToolRuntime as Tools } from '../src/dsh.ts'
import { SystemPrompt } from '../src/dsh.ts'
import { ToolCallId } from '../src/dsh.ts'
import Switchboard from '../src/index.ts'
import type { Flow, FlowId } from '../src/types.ts'
import { storageContext, temp } from './helpers.ts'

it('persists finite editor placement independently of recipe and run records', async () => {
  const root = await temp()
  const ctx = await storageContext(root)
  const fiber = ctx.plugin(Switchboard)
  await fiber.await()
  const flow = ctx.switchboard.listFlows()[0]!
  expect(ctx.switchboard.getLayout(flow.id)).toEqual({ positions: [] })
  const layout = { positions: [{ id: flow.blocks[0]!.id, x: 123, y: -45 }] }
  await ctx.switchboard.saveLayout(flow.id, layout)
  await expect(ctx.switchboard.saveLayout(flow.id, { positions: [{ id: 'a', x: Infinity, y: 0 }] })).rejects.toThrow()
  expect(ctx.switchboard.getFlow(flow.id)).toEqual(flow)
  await fiber.dispose()
  await ctx.plugin(Switchboard).await()
  expect(ctx.switchboard.getLayout(flow.id)).toEqual(layout)
  await expect(ctx.switchboard.saveLayout('absent' as FlowId, layout)).rejects.toThrow('Unknown flow')
})

it('starts a saved gate-only recipe through run_flow and removes the tool on unload', async () => {
  const ctx = await storageContext(await temp())
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(Tools).await()
  const fiber = ctx.plugin(Switchboard)
  await fiber.await()
  const flow: Flow = { id: 'chat-gate' as FlowId, name: 'Chat gate', version: 1, inputs: [], blocks: [{ id: 'you', kind: 'gate', label: 'Approve' }], edges: [], limits: {} }
  await ctx.switchboard.saveFlow(flow)
  const result = await ctx.tools.execute({ callId: ToolCallId('start'), signal: new AbortController().signal, name: 'run_flow', arguments: { name: flow.name, inputs: {} } })
  expect(result.isError).not.toBe(true)
  expect(result.meta).toMatchObject({ switchboardRun: { name: flow.name } })
  expect(ctx.switchboard.listRuns()).toHaveLength(1)
  const invalid = await ctx.tools.execute({ callId: ToolCallId('invalid'), signal: new AbortController().signal, name: 'run_flow', arguments: { name: flow.name, inputs: { nested: {} } } })
  expect(invalid.isError).toBe(true)
  expect(ctx.switchboard.listRuns()).toHaveLength(1)
  await fiber.dispose()
  expect(ctx.tools.get('run_flow')).toBeUndefined()
})
