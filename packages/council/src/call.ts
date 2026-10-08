/** Tool-less LLM calls and verified plan-only native calls, with Council-owned request logging. */
import { isCouncilClaude, type Context } from './dsh.ts'

import { type Agent } from './dsh.ts'
import { BlockAssembler } from './dsh.ts'

import { deadline } from './dsh.ts'
import type { CouncilAnswer, Seat, SeatAvailability } from './types.ts'

/**
 * Inspect the live route without contacting providers or reading credentials.
 * @param ctx - Council's injected services and optional Loader/native registry.
 * @param seat - configured route to inspect.
 * @returns availability with an actionable refusal reason.
 */
export async function availability(ctx: Context, seat: Seat): Promise<SeatAvailability> {
  let reason: string | undefined
  if (seat.kind === 'subagent' && seat.subagent === 'codex') reason = 'codex has no read-only mode yet'
  else if (!seat.enabled) reason = 'seat is disabled'
  else if (seat.kind === 'llm') {
    if (!ctx.llm.listProviders().some(value => value.id === seat.provider)) reason = `provider ${seat.provider} is not registered`
    else {
      try {
        if (!(await ctx.llm.listModels(seat.provider as string)).some(value => value.id === seat.model)) reason = `model ${seat.model} is not in the provider catalog`
      } catch (error) { reason = String(error) }
    }
  } else reason = nativeRefusal(ctx, seat)
  return { ...seat, available: reason === undefined, ...reason === undefined ? {} : { reason } }
}

function nativeRefusal(ctx: Context, seat: Seat): string | undefined {
  if (seat.subagent !== 'claude-code') return 'codex has no read-only mode yet'
  const provider = ctx.get('subagents')?.getProvider(seat.provider as string)
  if (!provider) return `provider ${seat.provider} is not registered`
  if (!isCouncilClaude(provider)) return 'Claude Code instance must be Council-owned with permissionMode plan'
  return undefined
}

/**
 * Execute one read-only call, retaining exact inputs before dispatch and outcomes after settlement.
 * @param ctx - injected Council services.
 * @param parent - log owner and native delegation parent, with a private temporary cwd.
 * @param seat - selected route snapshot.
 * @param prompt - complete anonymous request text.
 * @param phase - stable round, vote, or ruling label for replay.
 * @param signal - council cancellation signal.
 * @param timeoutMs - deadline for this call.
 * @returns answer or failed-call record; cancelled calls are settled before returning.
 */
export async function callSeat(
  ctx: Context, parent: Agent, seat: Seat, prompt: string, phase: string, signal: AbortSignal, timeoutMs: number,
): Promise<CouncilAnswer> {
  const started = performance.now()
  using limit = deadline(signal, timeoutMs, 'COUNCIL_SEAT_TIMEOUT')
  let answer: CouncilAnswer
  let usage: CouncilAnswer['usage'] = null
  try {
    limit.signal.throwIfAborted()
    await ctx.switchboardCouncil.recordCall(parent.session.id, { type: 'request', data: { seat, prompt, phase } })
    limit.signal.throwIfAborted()
    let text: string
    if (seat.kind === 'llm') {
      const assembler = new BlockAssembler()
      let finished = false
      for await (const chunk of ctx.llm.stream({
        provider: seat.provider as string, model: seat.model as string,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        tools: [], signal: limit.signal, sessionId: parent.session.id,
      })) {
        limit.signal.throwIfAborted()
        if (finished) throw new Error('Council received data after terminal finish')
        assembler.push(chunk)
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') finished = true
      }
      limit.signal.throwIfAborted()
      if (!finished) throw new Error('Council response has no terminal finish')
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
      if (finish.kind !== 'stop') throw new Error(`Council response incomplete: ${finish.kind}`)
      const blocks = assembler.blocks()
      if (blocks.some(block => block.type === 'tool-call')) throw new Error('Council models cannot call tools')
      text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      usage = assembler.usage ?? null
    } else {
      const refusal = nativeRefusal(ctx, seat)
      if (refusal) throw new Error(refusal)
      const subagents = ctx.get('subagents') as Context['subagents']
      const run = await subagents.start(seat.provider as string, {
        parent, prompt: [{ type: 'text', text: prompt }], signal: limit.signal,
      })
      try {
        const result = await run.result
        limit.signal.throwIfAborted()
        if (result.stopReason !== 'completed') throw new Error(`Council native seat ended: ${result.stopReason}`)
        text = result.output.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      } finally { await run.dispose() }
    }
    if (!text.trim()) throw new Error('Council seat returned an empty answer')
    answer = { seatId: seat.id, text, state: 'answered', usage, ms: performance.now() - started }
  } catch (error) {
    answer = { seatId: seat.id, text: '', state: 'failed', usage, ms: performance.now() - started, error: String(error) }
  }
  await ctx.switchboardCouncil.recordCall(parent.session.id, { type: 'answer', data: answer })
  return answer
}
