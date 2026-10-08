// @vitest-environment jsdom
import { Context } from '../src/client/dsh.ts'
import { TestRemote } from './fixtures/remote.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as host from '../src/index.ts'
import * as client from '../src/client/index.ts'

// Codec generation is checked by the built browser smoke; this test owns mount lifetime.
vi.mock('@switchboard/core/remote', () => ({ default: { namespace: 'switchboard' } }))
vi.mock('@switchboard/council/remote', () => ({ default: { namespace: 'switchboardCouncil' } }))

it('mounts and withdraws the generated Remote with its browser plugin', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const remote = new TestRemote(ctx)
  const unmount = vi.fn(async () => {})
  const mount = vi.spyOn(remote, '$mount').mockResolvedValue(unmount)
  const fiber = ctx.plugin(client)
  await fiber.await()
  expect(mount).toHaveBeenCalledWith({ namespace: 'switchboard' })
  expect(mount).toHaveBeenCalledWith({ namespace: 'switchboardCouncil' })
  expect(unmount).not.toHaveBeenCalled()
  await fiber.dispose()
  expect(unmount).toHaveBeenCalledTimes(2)
})

it('exposes the named empty Host entry', () => {
  expect(host).not.toHaveProperty('default')
  host.apply()
})
