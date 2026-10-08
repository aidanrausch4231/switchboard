import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '../src/dsh.ts'
import type { CouncilCallRequest, CouncilSession, SeatAvailability } from '../src/types.ts'

it('boots the published Council with two Claude instances, refuses unsafe native seats, and retains exact model inputs', async () => {
  const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
  await runLoaderSmoke({
    label: 'Council Loader composition', tempDirPrefix: 'council-loader-', binScript: driver, libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url)),
    inspect: async (cwd) => {
      const report = JSON.parse(await readFile(join(cwd, 'council-report.json'), 'utf8')) as {
        result: CouncilSession
        events: string[]
        requests: CouncilCallRequest[]
        seats: SeatAvailability[]
      }
      expect(report.result.state).toBe('done')
      expect(report.result.tally).toEqual({ 'Seat A': 0, 'Seat B': 2 })
      expect(report.result.ruling?.confidence).toBe(0.8)
      expect(report.requests).toHaveLength(5)
      expect(report.requests).toMatchSnapshot()
      expect(report.seats.find(seat => seat.id === 'native')).toMatchObject({ available: true })
      expect(report.seats.find(seat => seat.id === 'unsafe')?.available).toBe(false)
      expect(report.seats.find(seat => seat.id === 'unsafe')?.reason).toContain('permissionMode plan')
      expect(report.seats.find(seat => seat.id === 'codex')).toMatchObject({ available: false, reason: 'codex has no read-only mode yet' })
      expect(report.events[0]).toBe('snapshot')
      expect(report.events.at(-1)).toBe('state')
    },
  })
}, 60_000)
