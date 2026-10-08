/** Test-only app boot; persists an externally inspected Council report after real Loader composition. */
import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '../../src/dsh.ts'
import { brandString } from '../../src/dsh.ts'
import type { SeatId } from '@switchboard/council'
const path = process.argv[2]
if (!path) throw new Error('Council test driver requires a config path')
const ctx = await boot('council-loader-smoke', resolveConfigPath(path, undefined))
try {
  const seats = await ctx.switchboardCouncil.seats()
  const id = await ctx.switchboardCouncil.ask({ question: 'Which option?', mode: 'vote', seatIds: [brandString<SeatId>('a'), brandString<SeatId>('b')] })
  const events = []
  for await (const event of ctx.switchboardCouncil.follow(id)) events.push(event.type)
  const result = ctx.switchboardCouncil.get(id)
  const requests = ctx.switchboardCouncil.callRecords(id).filter(event => event.type === 'request').map(event => event.data)
  await writeFile('./council-report.json', JSON.stringify({ result, events, requests, seats }))
} finally { await ctx.fiber.dispose() }
