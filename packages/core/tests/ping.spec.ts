import { createRequire } from 'node:module'
import { expect, it, onTestFinished, vi } from 'vitest'
import Switchboard from '../src/index.ts'
import { storageContext, temp } from './helpers.ts'

it('returns a successful ping with the Host timestamp and package version', async () => {
  const ctx = await storageContext(await temp())
  const fiber = ctx.plugin(Switchboard)
  await fiber.await()
  vi.useFakeTimers({ toFake: ['Date'] })
  onTestFinished(() => { vi.useRealTimers() })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  const { version } = createRequire(import.meta.url)('../package.json') as { version: string }
  expect(ctx.switchboard.ping()).toEqual({ ok: true, version, time: '2026-01-01T00:00:00.000Z' })
  await fiber.dispose()
  expect(ctx.get('switchboard')).toBeUndefined()
})
