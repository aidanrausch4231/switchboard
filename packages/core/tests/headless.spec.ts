import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Timer, Persistence, Storage, DshStorageJson, DshStorageDomain } from '../src/dsh.ts'
import Switchboard from '../src/index.ts'
import Council, { Config } from '@switchboard/council'
import type { CouncilAnswer, CouncilCallRequest } from '@switchboard/council'
import { CouncilAdapter } from '../../council/tests/adapter.ts'
import { runtimeHarness } from './runtime-harness.ts'
import { textResponse } from './fixtures/mock-adapter.ts'
import { temp } from './helpers.ts'
import { replayFlow } from './flow-replay.ts'

it('replays the full parent/child Flow sessions with pinned prompts and tool schemas', replayFlow, 60000)

it('replays Council and routes a graph card using only the owned diary, not custom Session events', async () => {
  const root = await temp()
  const cwd = await temp()
  const { ctx, adapter } = await runtimeHarness([textResponse('{"target":"you","confidence":0.8,"reason":"Human review"}')])
  await ctx.plugin(Timer)
  await ctx.plugin(Persistence, { root: join(root, 'sessions') })
  await ctx.plugin(Storage)
  await ctx.plugin(DshStorageJson, { root: join(root, 'storage') })
  await ctx.plugin(DshStorageDomain, { backend: 'json' })
  await ctx.plugin(Switchboard, { agentPreset: 'standard', graphMemoryRoot: join(root, 'memory'), routerProvider: 'fake', routerModel: 'scripted' })
  const board = ctx.switchboard
  expect(board.listFlows()).toHaveLength(2)
  adapter.listModels = async () => [{ id: 'scripted', provider: 'fake', name: 'Scripted' }]
  const card = await board.createCard({ title: 'Choose an owner', body: 'Review', source: 'manual', workspace: cwd })
  for await (const frame of board.followCards(new AbortController().signal)) {
    if (frame.cards.some(value => value.id === card.id && value.state === 'needs-you')) break
  }
  const domain = ctx.storageDomain.get('switchboard')!
  expect([...domain.table('router_calls').entries()].map(([, value]) => value)).toMatchObject([{ request: { cardId: card.id }, answer: { text: expect.stringContaining('Human review') } }])

  const recorded = (await readFile(new URL('../../../tests/snapshots/switchboard-council/session.v4.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const requests: CouncilCallRequest[] = recorded.filter(row => row.type === 'switchboard-council/request').map(row => row.data)
  const answers: CouncilAnswer[] = recorded.filter(row => row.type === 'switchboard-council/answer').map(row => row.data)
  const seats = [...new Map(requests.map(request => [request.seat.id, request.seat])).values()]
  const replay = new CouncilAdapter()
  const remaining = [...requests]
  const remainingAnswers = [...answers]
  replay.respond = (options, prompt) => {
    const index = remaining.findIndex(request => request.seat.model === options.model)
    const request = remaining.splice(index, 1)[0]!
    expect(prompt).toBe(request.prompt)
    const answerIndex = remainingAnswers.findIndex(value => value.seatId === request.seat.id)
    return remainingAnswers.splice(answerIndex, 1)[0]!.text
  }
  adapter.stream = replay.stream.bind(replay)
  adapter.listModels = replay.listModels.bind(replay)
  await ctx.plugin(Council, Config({ seats, chair: seats[0]!.id }))
  const question = JSON.parse(requests[0]!.prompt.split('\n').find(line => line.startsWith('Question: '))!.slice(10))
  const id = await ctx.switchboardCouncil.ask({ question, mode: 'quick' })
  for await (const _event of ctx.switchboardCouncil.follow(id)) { /* drain */ }
  expect(ctx.switchboardCouncil.get(id).state).toBe('done')
  expect(remaining).toEqual([]); expect(remainingAnswers).toEqual([])
  expect(ctx.switchboardCouncil.callRecords(id).filter(row => row.type === 'request').map(row => row.data)).toEqual(requests)
  const actualAnswers = ctx.switchboardCouncil.callRecords(id).filter(row => row.type === 'answer').map(row => row.data)
  expect(actualAnswers.map(({ ms, ...value }) => value)).toEqual(answers.map(({ ms, ...value }) => value))
  expect(actualAnswers.every(value => value.ms >= 0)).toBe(true)
  const headers = await ctx.sessionPersistence.list()
  // Tool-less router/Council calls no longer manufacture log-only Sessions.
  expect(headers).toHaveLength(0)
  await ctx.fiber.dispose()
}, 60000)
