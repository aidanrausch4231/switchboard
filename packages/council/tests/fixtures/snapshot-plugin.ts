/** Shipped-profile snapshot fixture: only model output and the elapsed-time clock are replaced. */
import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { type Context } from '../../src/dsh.ts'

import type {} from '@switchboard/council'
import type { CouncilAnswer, CouncilCallRequest } from '../../src/types.ts'
import { CouncilAdapter } from '../adapter.ts'

export const inject = ['llm', 'switchboardCouncil', 'sessionPersistence']
export function apply(ctx: Context): void {
  const source = process.env.COUNCIL_SNAPSHOT_FILE
  if (!source) throw new Error('Missing Council recorded Session')
  const exit = ctx.get('appExit')
  const ready = ctx.get('appReady')
  if (!exit || !ready) throw new Error('Council snapshot requires dsh launch')
  const now = Object.getOwnPropertyDescriptor(performance, 'now')
  ctx.effect(() => {
    Object.defineProperty(performance, 'now', { configurable: true, value: () => 0 })
    return () => {
      if (now) Object.defineProperty(performance, 'now', now)
      else Reflect.deleteProperty(performance, 'now')
    }
  })
  const work = async () => {
    const records = (await readFile(source, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
      type: string
      data: CouncilCallRequest | CouncilAnswer
    })
    const requests = records.filter(record => record.type === 'switchboard-council/request').map(record => record.data as CouncilCallRequest)
    const answers = records.filter(record => record.type === 'switchboard-council/answer').map(record => record.data as CouncilAnswer)
    const adapter = new CouncilAdapter()
    adapter.respond = (options, prompt) => {
      const requestIndex = requests.findIndex(request => request.seat.model === options.model)
      if (requestIndex < 0) throw new Error('Council used an unrecorded model')
      const request = requests.splice(requestIndex, 1)[0]
      if (!request || request.prompt !== prompt) throw new Error('Council request differs from recorded input')
      const answerIndex = answers.findIndex(answer => answer.seatId === request.seat.id)
      if (answerIndex < 0) throw new Error('Council recording has no matching answer')
      const answer = answers.splice(answerIndex, 1)[0]
      if (!answer) throw new Error('Council recording has no matching answer')
      return answer.text
    }
    ctx.llm.registerAdapter(['fake'], adapter)
    const questionLine = requests[0]?.prompt.split('\n').find(line => line.startsWith('Question: '))
    if (!questionLine) throw new Error('Council recording has no question')
    const question: unknown = JSON.parse(questionLine.slice('Question: '.length))
    if (typeof question !== 'string') throw new Error('Council recording question must be text')
    const id = await ctx.switchboardCouncil.ask({ question, mode: 'quick' })
    for await (const _event of ctx.switchboardCouncil.follow(id)) { /* Drain committed notifications. */ }
    if (ctx.switchboardCouncil.get(id).state !== 'done') throw new Error(JSON.stringify(ctx.switchboardCouncil.get(id)))
    if (requests.length || answers.length) throw new Error('Council left recorded calls unused')
    await writeFile('./council-diary.json', JSON.stringify(ctx.switchboardCouncil.callRecords(id), null, 2) + '\n')
  }
  ctx.effect(() => ready.onReady(() => {
    void work().then(() => { exit(0) }, (error: unknown) => { console.error(error); exit(1) })
  }))
}
