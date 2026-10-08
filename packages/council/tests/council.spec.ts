import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '../src/dsh.ts'
import { Loader } from '../src/dsh.ts'
import { Subagents } from '../src/dsh.ts'
import { DshClaude as UnsafeClaude } from '../src/dsh.ts'
import * as Claude from '../src/claude-code.ts'
import { SubprocessLocal } from '../src/dsh.ts'
import { availability, callSeat } from '../src/call.ts'
import { AgentRegistry } from '../src/dsh.ts'
import { AgentLoop } from '../src/dsh.ts'
import { SessionStore, type SessionId } from '../src/dsh.ts'
import { SessionProjectionRegistry } from '../src/dsh.ts'
import { Persistence } from '../src/dsh.ts'
import { LlmRuntime, type StreamChunk, type ToolCallId } from '../src/dsh.ts'
import { SystemPrompt } from '../src/dsh.ts'
import { Tools } from '../src/dsh.ts'
import { Storage } from '../src/dsh.ts'
import { DshJsonStorage as JsonStorage } from '../src/dsh.ts'
import { DshDomain as Domain } from '../src/dsh.ts'
import { brandString } from '../src/dsh.ts'
import Council, { Config } from '../src/index.ts'
import { councilDomain, resolveConfig } from '../src/spec.ts'
import type { CouncilEvent, CouncilSession, CouncilSessionId, Seat, SeatId } from '../src/types.ts'
import { CouncilAdapter } from './adapter.ts'

const seatId = (value: string) => brandString<SeatId>(value)
const seats: Seat[] = ['a', 'b', 'c'].map(value => ({
  id: seatId(value), label: `Model ${value.toUpperCase()}`, kind: 'llm', provider: 'fake', model: `model-${value}`, enabled: true,
}))
async function harness(timeoutMs = 120000, configuredSeats = seats) {
  const root = await mkdtemp(join(tmpdir(), 'council-test-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }, 60_000)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Persistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'storage') })
  await ctx.plugin(Domain, { backend: 'json' })
  const adapter = new CouncilAdapter()
  ctx.llm.registerAdapter(['fake'], adapter)
  const config = Config({ seats: configuredSeats, chair: configuredSeats[0]!.id, timeoutMs })
  const fiber = await ctx.plugin(Council, config)
  return { root, ctx, adapter, fiber, config, council: ctx.switchboardCouncil }
}
async function finish(council: Council, id: CouncilSessionId) {
  const events: CouncilEvent[] = []
  for await (const event of council.follow(id)) events.push(event)
  return { events, record: council.get(id) }
}

it('runs quick answers, records usage and a strict ruling, and persists across unload', async () => {
  const { council, ctx, fiber, config } = await harness()
  const id = await council.ask({ question: 'Which option?', mode: 'quick' })
  const { record, events } = await finish(council, id)
  expect(record, JSON.stringify(record)).toMatchObject({ state: 'done' })
  expect(record.state).toBe('done')
  expect(record.rounds[0]!.answers).toHaveLength(3)
  expect(record.rounds[0]!.answers[0]!.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
  expect(record.ruling?.confidence).toBe(0.8)
  expect(events[0]!.type).toBe('snapshot')
  expect(events.at(-1)).toEqual({ type: 'state', state: 'done' })
  expect(events.findIndex(event => event.type === 'round-done')).toBeGreaterThan(events.findLastIndex(event => event.type === 'seat-answered'))
  expect(events.findIndex(event => event.type === 'ruling')).toBeGreaterThan(events.findIndex(event => event.type === 'round-done'))
  for (const seat of seats) {
    expect(events.findIndex(event => event.type === 'seat-started' && event.seatId === seat.id)).toBeLessThan(events.findIndex(event => event.type === 'seat-answered' && event.answer.seatId === seat.id))
  }
  const calls = council.callRecords(id)
  expect(calls.filter(event => event.type === 'request')).toHaveLength(4)
  await fiber.dispose()
  expect(ctx.get('switchboardCouncil')).toBeUndefined()
  await ctx.plugin(Council, config)
  expect(ctx.switchboardCouncil.get(id)).toEqual(record)
  expect(ctx.switchboardCouncil.callRecords(id)).toEqual(calls)
  expect(ctx.switchboardCouncil.list()).toEqual([record])
  const copy = ctx.switchboardCouncil.get(id)
  copy.question = 'mutation'
  expect(ctx.switchboardCouncil.get(id).question).toBe('Which option?')
})

it('anonymizes only OTHER seats in later debate rounds and sends no tools', async () => {
  const { council, adapter } = await harness()
  const original = adapter.respond
  adapter.respond = (options, prompt) => prompt.includes('Write a ruling') ? original(options, prompt) : `Opinion from ${options.model} through FAKE; unique-${seats.findIndex(seat => seat.model === options.model) + 1}`
  const { record } = await finish(council, await council.ask({ question: 'Discuss', mode: 'debate', rounds: 3 }))
  expect(record.state).toBe('done')
  expect(record.rounds).toHaveLength(3)
  for (const request of adapter.requests) {
    expect(request.tools).toEqual([])
    const prompt = JSON.stringify(request.messages)
    if (!prompt.includes('Revise your answer')) continue
    expect(prompt).not.toMatch(/model-[abc]|FAKE|Model [ABC]/i)
    expect(prompt).not.toContain(`unique-${seats.findIndex(seat => seat.model === request.model) + 1}`)
    expect(prompt.match(/unique-\d/g)).toHaveLength(2)
    expect(prompt).toMatch(/Seat [ABC]/)
  }
  const prompts = adapter.requests.map(request => ({ model: request.model, messages: request.messages, tools: request.tools }))
  expect(prompts).toMatchSnapshot()
})

it.each(['debate', 'vote'] as const)('redacts configured and native identities from actual %s and chair requests', async (mode) => {
  const native: Seat = { id: seatId('claude'), label: 'Claude Code', kind: 'subagent', provider: 'plan-seat', subagent: 'claude-code', enabled: true }
  const configuredSeats = [{ ...seats[0]!, id: seatId('juror.one+') }, seats[1]!, native]
  const { council, ctx, adapter } = await harness(120000, configuredSeats)
  await ctx.plugin(Subagents, {})
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(Loader)
  const imported = vi.spyOn(ctx.loader, 'import').mockResolvedValue(Claude)
  onTestFinished(() => { imported.mockRestore() })
  await ctx.loader.create({ name: '@deepseek-ai/dsh-subagent-claude-code', config: {
    providerName: 'plan-seat', permissionMode: 'plan', model: 'opus-private-2026',
  } })
  await ctx.loader.await()
  const identities = 'As Claude, from CLAUDE CODE / Anthropic / GPT / OpenAI / Codex / DeepSeek / Gemini / Grok / Kimi; juror.one+ / Model A / FAKE / model-a / plan-seat / claude-code / OPUS-PRIVATE-2026.'
  const ordinary = 'alphabet anthropicology gptastic openair codexes deepseeking geminis grokking kimidoll jurorXonee'
  const original = adapter.respond
  let chairCalls = 0
  adapter.respond = (options, prompt) => {
    if (prompt.includes('Write a ruling')) return ++chairCalls === 1 ? 'invalid JSON' : original(options, prompt)
    if (prompt.includes('Select the best answer')) return original(options, prompt)
    return `${identities} ${ordinary}`
  }
  const start = vi.spyOn(ctx.subagents.getProvider('plan-seat')!, 'start').mockResolvedValue({
    id: brandString<SessionId>('anonymous-native-child'), localAgent: undefined, dispose: async () => {},
    result: Promise.resolve({ output: [{ type: 'text', text: `${identities} ${ordinary}` }], stopReason: 'completed' }),
  })
  const question = 'Compare gEmInI and opus-private-2026.'
  const { record } = await finish(council, await council.ask({ question, mode }))
  expect(record.state).toBe('done')
  expect(record.question).toBe(question)
  const prompts = adapter.requests.map(request => request.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
  const peerPrompts = prompts.filter(prompt => prompt.includes(mode === 'debate' ? 'Revise your answer' : 'Select the best answer'))
  const chairPrompts = prompts.filter(prompt => prompt.includes('Write a ruling'))
  expect(peerPrompts).toHaveLength(2)
  expect(chairPrompts).toHaveLength(2)
  for (const prompt of [...peerPrompts, ...chairPrompts]) {
    expect(prompt).not.toMatch(/\b(?:claude|anthropic|gpt|openai|codex|deepseek|gemini|grok|kimi)\b/i)
    expect(prompt).not.toMatch(/\b(?:fake|model-a|plan-seat|opus-private-2026)\b|juror\.one\+|Model A/i)
    expect(prompt).toContain(
      `As [model], from ${Array<string>(9).fill('[model]').join(' / ')}; ${Array<string>(7).fill('[model]').join(' / ')}.`,
    )
    expect(prompt).toContain(ordinary)
    expect(prompt).toMatch(/Seat [ABC]/)
  }
  for (const prompt of prompts) expect(prompt).not.toMatch(/\bgemini\b|opus-private-2026/i)
  for (const [request] of start.mock.calls) {
    const prompt = JSON.stringify(request.prompt)
    expect(prompt).not.toMatch(/\b(?:claude|anthropic|gemini)\b|opus-private-2026/i)
  }
  expect(record.rounds[0]!.answers.every(answer => answer.text.includes('As Claude'))).toBe(true)
}, 60_000)

it('tallies validated anonymous votes and gives them to the chair', async () => {
  const { council, adapter } = await harness()
  const { record } = await finish(council, await council.ask({ question: 'Vote', mode: 'vote' }))
  expect(record.state).toBe('done')
  expect(record.tally).toEqual({ 'Seat A': 0, 'Seat B': 3, 'Seat C': 0 })
  expect(record.votes?.map(vote => vote.choice)).toEqual(['Seat B', 'Seat B', 'Seat B'])
  expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toContain('Vote tally')
})

it.each([false, true])('retries malformed chair JSON once, raw fallback=%s', async (fallback) => {
  const { council, adapter } = await harness()
  let rulingCalls = 0
  const original = adapter.respond
  adapter.respond = (options, prompt) => {
    if (!prompt.includes('Write a ruling')) return original(options, prompt)
    rulingCalls++
    return fallback || rulingCalls === 1 ? 'raw ruling' : original(options, prompt)
  }
  const { record } = await finish(council, await council.ask({ question: 'Q', mode: 'quick' }))
  expect(record.state).toBe('done')
  expect(rulingCalls).toBe(2)
  expect(record.ruling?.confidence).toBe(fallback ? null : 0.8)
  if (fallback) expect(record.ruling?.ruling).toBe('raw ruling')
})

it.each([1, 2])('excludes %s failed seats and requires at least two answers', async (failures) => {
  const { council, adapter } = await harness()
  const original = adapter.respond
  adapter.respond = (options, prompt) => {
    if (options.model === 'model-c' || (failures === 2 && options.model === 'model-b')) throw new Error('seat down')
    return original(options, prompt)
  }
  const { record } = await finish(council, await council.ask({ question: 'Q', mode: 'debate' }))
  expect(record.state).toBe(failures === 1 ? 'done' : 'failed')
  expect(record.rounds[0]!.answers.filter(answer => answer.state === 'failed')).toHaveLength(failures)
  if (failures === 1) expect(record.rounds[1]!.answers.map(answer => answer.seatId).sort()).toEqual(['a', 'b'])
  else expect(record.error).toContain('at least two answered')
})

it('cancels active streams and drains ownership before returning', async () => {
  const { council, adapter, ctx } = await harness()
  const started = Promise.withResolvers<undefined>()
  let active = 0
  adapter.respond = async (options) => {
    active++
    started.resolve(undefined)
    try {
      await new Promise<void>((resolve) => {
        if (options.signal!.aborted) resolve()
        else options.signal!.addEventListener('abort', () =>{  resolve() }, { once: true })
      })
      return 'late output'
    } finally { active-- }
  }
  const id = await council.ask({ question: 'Q', mode: 'quick' })
  await started.promise
  const record = await council.cancel(id)
  expect(record.state).toBe('cancelled')
  expect(active).toBe(0)
  expect(ctx.agents.roots()).toHaveLength(0)
  expect(await council.cancel(id)).toEqual(record)
})

it('times out a seat while allowing two peers to finish', async () => {
  const { council, adapter } = await harness()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  onTestFinished(() => { vi.useRealTimers() })
  const original = adapter.respond
  adapter.respond = async (options, prompt) => {
    if (options.model !== 'model-c') return original(options, prompt)
    await new Promise<void>((resolve) => {
      if (options.signal!.aborted) resolve()
      else options.signal!.addEventListener('abort', () =>{  resolve() }, { once: true })
    })
    return 'late'
  }
  const id = await council.ask({ question: 'Q', mode: 'quick' })
  let answered = 0
  for await (const event of council.follow(id)) {
    if (event.type === 'seat-answered' && ++answered === 2) {
      await vi.advanceTimersByTimeAsync(120000)
      vi.useRealTimers()
    }
  }
  const record = council.get(id)
  expect(record.state).toBe('done')
  expect(record.rounds[0]!.answers.find(answer => answer.seatId === 'c')?.state).toBe('failed')
})

it('marks interrupted records failed on reload and refuses invalid inputs', async () => {
  const { council, ctx, fiber, config } = await harness()
  await expect(council.ask({ question: ' ', mode: 'quick' })).rejects.toThrow()
  await expect(council.ask({ question: 'Q', mode: 'quick', rounds: 2 })).rejects.toThrow()
  await expect(council.ask({ question: 'Q', mode: 'quick', seatIds: [seatId('a'), seatId('missing')] })).rejects.toThrow('unavailable')
  const id = await council.ask({ question: 'Q', mode: 'quick' })
  const { record } = await finish(council, id)
  await fiber.dispose()
  const domain = await ctx.storageDomain.open(councilDomain)
  await domain.table('council_sessions').put(id, { ...record, state: 'running' })
  await domain.close()
  await ctx.plugin(Council, config)
  expect(ctx.switchboardCouncil.get(id)).toMatchObject({ state: 'failed', error: 'Council interrupted by host restart' })
})


it('refuses Codex and non-plan Claude through the executor, and binds the exact native instance', async () => {
  const { ctx } = await harness()
  await ctx.plugin(Subagents, {})
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(Loader)
  const imported = vi.spyOn(ctx.loader, 'import').mockResolvedValue(Claude)
  onTestFinished(() =>{  imported.mockRestore() })
  await ctx.loader.create({ name: '@deepseek-ai/dsh-subagent-claude-code', disabled: true })
  const nativeFiber = await ctx.loader.create({ name: '@switchboard/council/claude-code', config: { providerName: 'plan-seat', permissionMode: 'bypassPermissions' } })
  await ctx.plugin(UnsafeClaude, { providerName: 'write-seat', permissionMode: 'bypassPermissions' })
  await ctx.loader.await()
  const seat: Seat = { id: seatId('native'), label: 'Claude', kind: 'subagent', subagent: 'claude-code', provider: 'plan-seat', enabled: true }
  expect(await availability(ctx, seat)).toMatchObject({ available: true })
  const unsafe = await availability(ctx, { ...seat, provider: 'write-seat' })
  expect(unsafe.available).toBe(false)
  expect(unsafe.reason).toContain('permissionMode plan')
  expect(await availability(ctx, { ...seat, subagent: 'codex' })).toMatchObject({ available: false, reason: 'codex has no read-only mode yet' })
  const parent = await ctx.agents.create({ sessionId: brandString<SessionId>('native-parent'), meta: { cwd: tmpdir() } })
  try {
    const write = vi.spyOn(ctx.subagents.getProvider('write-seat')!, 'start')
      .mockRejectedValue(new Error('unsafe dispatch reached fixture'))
    const denied = await callSeat(ctx, parent.agent, { ...seat, provider: 'write-seat' }, 'Do not write', 'round-1', new AbortController().signal, 120000)
    expect(denied.state).toBe('failed')
    expect(write.mock.calls.length).toBe(0)
    const codex = await callSeat(ctx, parent.agent, { ...seat, subagent: 'codex' }, 'Q', 'round-1', new AbortController().signal, 120000)
    expect(codex.error).toContain('codex has no read-only mode yet')
    const dispose = vi.fn(async () => {})
    const start = vi.spyOn(ctx.subagents.getProvider('plan-seat')!, 'start').mockResolvedValue({
      id: brandString<SessionId>('native-child'), localAgent: undefined, dispose,
      result: Promise.resolve({ output: [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'Read-only answer' }], stopReason: 'completed' }),
    })
    const answer = await callSeat(ctx, parent.agent, seat, 'Q', 'round-1', new AbortController().signal, 120000)
    expect(answer).toMatchObject({ state: 'answered', text: 'Read-only answer', usage: null })
    expect(start).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    start.mockResolvedValueOnce({
      id: brandString<SessionId>('native-failed'), localAgent: undefined, dispose,
      result: Promise.resolve({ output: [], stopReason: 'error' }),
    })
    const failed = await callSeat(ctx, parent.agent, seat, 'Q', 'round-1', new AbortController().signal, 120000)
    expect(failed.error).toContain('ended: error')
    await ctx.loader.resolve(nativeFiber).fiber!.dispose()
    await ctx.plugin(UnsafeClaude, { providerName: 'plan-seat', permissionMode: 'plan' })
    expect(await availability(ctx, seat)).toMatchObject({ available: false, reason: 'Claude Code instance must be Council-owned with permissionMode plan' })
  } finally { await parent.dispose() }
}, 60_000)

it('unload cancels active work and removes the private temporary cwd', async () => {
  const { council, ctx, adapter, fiber } = await harness()
  const started = Promise.withResolvers<undefined>()
  adapter.respond = async (options) => {
    started.resolve(undefined)
    await new Promise<void>((resolve) => {
      if (options.signal!.aborted) resolve()
      else options.signal!.addEventListener('abort', () =>{  resolve() }, { once: true })
    })
    return 'late'
  }
  await council.ask({ question: 'Q', mode: 'quick' })
  await started.promise
  const cwd = ctx.agents.roots()[0]!.session.header.cwd!
  expect((await stat(cwd)).isDirectory()).toBe(true)
  await fiber.dispose()
  expect(ctx.agents.roots()).toHaveLength(0)
  await expect(stat(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
})


it('reports disabled, missing, unknown-model, broken-catalog and unverifiable native routes', async () => {
  const { ctx, adapter, council } = await harness()
  expect(await availability(ctx, { ...seats[0]!, enabled: false })).toMatchObject({ available: false, reason: 'seat is disabled' })
  expect((await availability(ctx, { ...seats[0]!, provider: 'missing' })).reason).toContain('not registered')
  expect((await availability(ctx, { ...seats[0]!, model: 'missing' })).reason).toContain('not in the provider catalog')
  const broken = vi.spyOn(adapter, 'listModels').mockRejectedValue(new Error('catalog unavailable'))
  expect((await availability(ctx, seats[0]!)).reason).toContain('catalog unavailable')
  await expect(council.ask({ question: 'Q', mode: 'quick' })).rejects.toThrow('chair unavailable')
  broken.mockRestore()
  const native: Seat = { ...seats[0]!, kind: 'subagent', provider: 'missing', subagent: 'claude-code' }
  expect((await availability(ctx, native)).reason).toContain('not registered')
  await ctx.plugin(Subagents, {})
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(UnsafeClaude, { providerName: 'manual', permissionMode: 'plan' })
  expect((await availability(ctx, { ...native, provider: 'manual' })).reason).toContain('Council-owned')
  await ctx.plugin(Loader)
  expect((await availability(ctx, { ...native, provider: 'manual' })).reason).toContain('Council-owned')
}, 60_000)

it('validates route fields and unambiguous chair configuration at load', () => {
  const config = { seats, chair: 'a', timeoutMs: 120000 }
  expect(() => resolveConfig({ ...config, seats: [seats[0]!, seats[0]!] })).toThrow('unique')
  expect(() => resolveConfig({ ...config, chair: 'missing' })).toThrow('enabled seat')
  for (const incomplete of [
    { ...seats[0]!, provider: undefined }, { ...seats[0]!, model: undefined },
    { ...seats[0]!, kind: 'subagent' as const },
    { ...seats[0]!, kind: 'subagent' as const, subagent: 'claude-code' as const, provider: undefined },
  ]) expect(() => resolveConfig({ ...config, seats: [incomplete, seats[1]!] })).toThrow('require')
  expect(resolveConfig(Config({})).seats).toHaveLength(5)
})

it('refuses duplicate selection, omitted chair, unknown ids, and fewer than two available seats', async () => {
  const { ctx, council, adapter } = await harness()
  await expect(council.ask({ question: 'Q', mode: 'quick', seatIds: [seatId('a'), seatId('a')] })).rejects.toThrow('unique')
  await expect(council.ask({ question: 'Q', mode: 'quick', seatIds: [seatId('b'), seatId('c')] })).rejects.toThrow('include the chair')
  expect(() => council.get(brandString<CouncilSessionId>('unknown'))).toThrow('Unknown Council')
  vi.spyOn(adapter, 'listModels').mockResolvedValue([{ provider: 'fake', id: 'model-a', name: 'A' }])
  const id = await council.ask({ question: 'Q', mode: 'quick' })
  const { record } = await finish(council, id)
  expect(record.state).toBe('failed')
  expect(record.error).toContain('two available seats')
  expect(ctx.agents.roots()).toHaveLength(0)
  expect((await finish(council, id)).events).toEqual([{ type: 'snapshot', session: record }])
})

it.each(['unknown', 'multiline', 'failure'])('retains invalid votes without counting them: %s', async (kind) => {
  const { council, adapter } = await harness()
  const original = adapter.respond
  adapter.respond = (options, prompt) => {
    if (!prompt.includes('Select the best answer')) return original(options, prompt)
    if (kind === 'failure') throw new Error('vote offline')
    return JSON.stringify({ choice: kind === 'unknown' ? 'Seat Z' : 'Seat A', reason: kind === 'multiline' ? 'one\ntwo' : 'reason' })
  }
  const { record } = await finish(council, await council.ask({ question: 'Q', mode: 'vote' }))
  expect(record.state).toBe('done')
  expect(record.votes?.every(vote => vote.choice === null)).toBe(true)
  expect(Object.values(record.tally!)).toEqual([0, 0, 0])
})

it.each(['answer', 'ruling', 'dissent'])('handles chair %s failures explicitly', async (kind) => {
  const { council, adapter } = await harness()
  const original = adapter.respond
  adapter.respond = (options, prompt) => {
    if (options.model !== 'model-a') return original(options, prompt)
    if (kind === 'answer' || (kind === 'ruling' && prompt.includes('Write a ruling'))) throw new Error('chair offline')
    if (kind === 'dissent' && prompt.includes('Write a ruling')) return '{"ruling":"R","dissent":[{"seat":"Seat Z","point":"P"}],"confidence":0.5}'
    return original(options, prompt)
  }
  const { record } = await finish(council, await council.ask({ question: 'Q', mode: 'quick' }))
  expect(record.state).toBe(kind === 'dissent' ? 'done' : 'failed')
  if (kind === 'dissent') expect(record.ruling?.confidence).toBeNull()
  else expect(record.error).toContain('chair failed')
})

it.each(['missing', 'trailing', 'max-tokens', 'tool', 'empty', 'reasoning'])('settles malformed or incomplete LLM streams: %s', async (kind) => {
  const { ctx } = await harness()
  const parent = await ctx.agents.create({ sessionId: brandString<SessionId>('direct-call') })
  try {
    const chunks: StreamChunk[] = []
    if (kind === 'tool') chunks.push({ type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>('tool'), name: 'write', arguments: '{}' } })
    if (kind === 'reasoning') chunks.push(
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thought' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
    )
    if (kind !== 'missing') chunks.push({ type: 'finish', reason: { kind: kind === 'max-tokens' ? 'max-tokens' : 'stop' } })
    if (kind === 'trailing') chunks.push({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } })
    vi.spyOn(ctx.llm, 'stream').mockImplementation(async function* () { yield* chunks })
    const result = await callSeat(ctx, parent.agent, seats[0]!, 'Q', 'round', new AbortController().signal, 120000)
    expect(result.state).toBe(kind === 'reasoning' ? 'answered' : 'failed')
    expect(result.usage).toBeNull()
  } finally { await parent.dispose() }
})

it('fails closed without durable request or answer logging and drains sibling calls', async () => {
  const { ctx, council, adapter } = await harness()
  const flush = vi.spyOn(council, 'recordCall').mockRejectedValue(new Error('Council diary persistence failed'))
  const { record } = await finish(council, await council.ask({ question: 'Q', mode: 'quick' }))
  expect(record.state).toBe('failed')
  expect(record.error).toContain('Council diary persistence failed')
  expect(adapter.requests).toHaveLength(0)
  flush.mockRestore()
})

it('lists independent sessions and closes admission during asynchronous preflight', async () => {
  const { council, adapter, fiber } = await harness()
  await finish(council, await council.ask({ question: 'One', mode: 'quick' }))
  await finish(council, await council.ask({ question: 'Two', mode: 'quick' }))
  expect(council.list().map(record => record.question)).toEqual(['Two', 'One'])
  const ready = Promise.withResolvers<undefined>()
  const proceed = Promise.withResolvers<undefined>()
  const original = adapter.listModels.bind(adapter)
  vi.spyOn(adapter, 'listModels').mockImplementation(async () => { ready.resolve(undefined); await proceed.promise; return original() })
  const ask = council.ask({ question: 'Late', mode: 'quick' })
  const refused = expect(ask).rejects.toThrow('closing')
  await ready.promise
  await fiber.dispose()
  proceed.resolve(undefined)
  await refused
  await expect(council.ask({ question: 'After close', mode: 'quick' })).rejects.toThrow('closing')
})


it('surfaces terminal persistence failure to waiting cancellation and followers', async () => {
  const { ctx, council, adapter } = await harness()
  const started = Promise.withResolvers<undefined>()
  adapter.respond = async (options) => {
    started.resolve(undefined)
    await new Promise<void>((resolve) => {
      if (options.signal!.aborted) resolve()
      else options.signal!.addEventListener('abort', () => { resolve() }, { once: true })
    })
    return 'late'
  }
  const id = await council.ask({ question: 'Q', mode: 'quick' })
  const following = finish(council, id)
  const expectedFollow = expect(following).rejects.toThrow('terminal state')
  await started.promise
  const table = Reflect.get(council, 'table') as Domain.KvTable<CouncilSessionId, CouncilSession>
  const update = vi.spyOn(table, 'update').mockRejectedValue(new Error('disk failed'))
  await expect(council.cancel(id)).rejects.toThrow('terminal state')
  await expectedFollow
  expect(ctx.agents.roots()).toHaveLength(0)
  update.mockRestore()
})

it.each(['cancel', 'failure'])('settles cleanup before publishing terminal state: %s', async (kind) => {
  const { ctx, council } = await harness()
  const disposal = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const create = ctx.agents.create.bind(ctx.agents)
  vi.spyOn(ctx.agents, 'create').mockImplementation(async (options) => {
    const handle = await create(options)
    return { agent: handle.agent, dispose: async () => {
      await handle.dispose()
      disposal.resolve(undefined)
      await release.promise
      if (kind === 'failure') throw new Error('cleanup fault')
    } }
  })
  const id = await council.ask({ question: 'Q', mode: 'quick' })
  const following = finish(council, id)
  await disposal.promise
  const cancelled = kind === 'cancel' ? council.cancel(id) : undefined
  release.resolve(undefined)
  await cancelled
  const { record } = await following
  expect(record.state).toBe(kind === 'cancel' ? 'cancelled' : 'failed')
  if (kind === 'failure') expect(record.error).toContain('cleanup failed')
})

it('detaches an aborted follower without cancelling the Council', async () => {
  const { council, adapter } = await harness()
  adapter.respond = async (options) => {
    await new Promise<void>((resolve) => {
      if (options.signal!.aborted) resolve()
      else options.signal!.addEventListener('abort', () => { resolve() }, { once: true })
    })
    return 'late'
  }
  const controller = new AbortController()
  const remote = Object.create(council) as Council
  Object.defineProperty(remote, 'ctx', { configurable: true, value: { invocation: { signal: controller.signal } } })
  const id = await council.ask({ question: 'Q', mode: 'quick' })
  const iterator = Council.prototype.follow.call(remote, id)[Symbol.asyncIterator]()
  const first: IteratorResult<CouncilEvent, undefined> = await iterator.next()
  expect(first.value?.type).toBe('snapshot')
  expect((await iterator.next()).done).toBe(false)
  controller.abort()
  while (!(await iterator.next()).done) { /* Drain already committed items. */ }
  expect(council.get(id).state).toBe('running')
  expect((await council.cancel(id)).state).toBe('cancelled')
})


it('lets the chair synthesize two surviving answers after its answer call failed', async () => {
  const { council, adapter } = await harness()
  const original = adapter.respond
  adapter.respond = (options, prompt) => {
    if (options.model === 'model-a' && !prompt.includes('Write a ruling')) throw new Error('initial chair request failed')
    return original(options, prompt)
  }
  const { record } = await finish(council, await council.ask({ question: 'Q', mode: 'quick' }))
  expect(record.state).toBe('done')
  expect(record.rounds[0]!.answers.filter(answer => answer.state === 'answered')).toHaveLength(2)
  expect(record.ruling?.confidence).toBe(0.8)
})
