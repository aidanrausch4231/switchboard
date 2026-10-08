import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import Switchboard, { exampleFlows } from '../src/index.ts'
import { validateFlow } from '../src/recipe.ts'
import { recipe, storageContext, temp } from './helpers.ts'

it('ships the same validated recipes as the source JSON examples', async () => {
  expect(exampleFlows).toHaveLength(2)
  for (const flow of exampleFlows) {
    const json: unknown = JSON.parse(await readFile(new URL(`../examples/${flow.id}.json`, import.meta.url), 'utf8'))
    expect(flow).toEqual(json)
    expect(validateFlow(flow).ok).toBe(true)
  }
})

it('seeds an empty store and preserves edits and deletions across restarts', async () => {
  const root = await temp()
  const ctx = await storageContext(root)
  const fiber = ctx.plugin(Switchboard)
  await fiber.await()
  expect(ctx.switchboard.listFlows()).toEqual(exampleFlows)
  const edited = { ...exampleFlows[0]!, name: 'My edited flow' }
  await ctx.switchboard.saveFlow(edited)
  await ctx.switchboard.deleteFlow(exampleFlows[1]!.id)
  await fiber.dispose()
  const reopened = await storageContext(root)
  await reopened.plugin(Switchboard).await()
  expect(reopened.switchboard.listFlows()).toEqual([edited])
})

it('does not seed a nonempty store containing only a user recipe', async () => {
  const root = await temp()
  const ctx = await storageContext(root)
  const fiber = ctx.plugin(Switchboard)
  await fiber.await()
  const custom = recipe(await temp())
  await ctx.switchboard.saveFlow(custom)
  for (const flow of exampleFlows) await ctx.switchboard.deleteFlow(flow.id)
  await fiber.dispose()
  await ctx.plugin(Switchboard).await()
  expect(ctx.switchboard.listFlows()).toEqual([custom])
})
