import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../src/dsh.ts'
import { installModelSelection, type ModelSelectionRef, type PreStepDecision } from '../src/dsh.ts'
import { agentEvents } from '../src/dsh.ts'
import { createUserMessage, ReasoningEffortId, type LlmCallConfig } from '../src/dsh.ts'
import { SessionId } from '../src/dsh.ts'
import * as fallback from '../src/index.ts'
import { alternate, createAgent, failure, harness, primary, ScriptAdapter, textResponse, turn } from './harness.ts'

let ctx: Context
beforeEach(() => { ctx = new Context() })
afterEach(async () => { await ctx.fiber.dispose() })

describe('turn-local fallback', () => {
  it.each(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'])('exhausts native retries for %s before switching and logging the actual route', async (code) => {
    const first = new ScriptAdapter([failure(code), failure(code)])
    const second = new ScriptAdapter([textResponse()])
    await harness(ctx, first, second)
    const events: fallback.FallbackEvent[] = []
    ctx.on('switchboard/fallback', (event) => { events.push(event) })
    const agent = await createAgent(ctx)
    await turn(agent)

    expect(first.requests).toHaveLength(2)
    expect(second.requests).toHaveLength(1)
    expect(events).toEqual([{ sessionId: agent.session.id, turn: 1, step: 1, from: primary, to: alternate, code }])
    const log = agent.session.snapshotEvents()
    expect(log.filter(e => e.type === 'llm/retry')).toHaveLength(1)
    expect(log.filter(e => e.type === 'assistant/attempt')).toHaveLength(2)
    expect(log.flatMap(e => e.type === 'request/header' ? [e.data.header.config] : [])).toEqual([primary, alternate])
    expect(log.find(e => e.type === 'assistant/message')).toMatchObject({
      data: { message: { source: { kind: 'model', ...alternate }, content: [{ type: 'text', text: 'recovered' }] } },
    })
    expect(log.map(e => e.type)).not.toContain('switchboard/fallback')
  })

  it.each(['AUTH', 'INVALID_REQUEST', 'ABORTED', 'CONTEXT_WINDOW_EXCEEDED', 'QUOTA', 'UNKNOWN'])('does not switch for %s', async (code) => {
    const first = new ScriptAdapter([failure(code)])
    const second = new ScriptAdapter([])
    await harness(ctx, first, second)
    const observed = vi.fn()
    ctx.on('switchboard/fallback', observed)
    await turn(await createAgent(ctx))
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(0)
    expect(observed).not.toHaveBeenCalled()
  })

  it('retries on the fallback route even when a notification observer throws', async () => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER')])
    const second = new ScriptAdapter([textResponse()])
    await harness(ctx, first, second)
    ctx.on('switchboard/fallback', () => { throw new Error('observer failed') })
    const agent = await createAgent(ctx)
    await turn(agent)
    expect(second.requests).toHaveLength(1)
    expect(agent.session.requestHeader()?.config).toEqual(alternate)
  })

  it('permits quota only with explicit opt-in', async () => {
    const first = new ScriptAdapter([failure('QUOTA')])
    const second = new ScriptAdapter([textResponse()])
    await harness(ctx, first, second, { fallbackOnQuota: true })
    await turn(await createAgent(ctx))
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
  })

  it.each([
    { config: { modelMap: {} }, route: primary },
    { config: {}, route: { ...primary, provider: 'other' } },
    { config: { enabled: false }, route: primary },
    { config: {}, route: { ...primary, model: 'toString' } },
  ])('leaves excluded routes/configuration terminal: %j', async ({ config, route }) => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER')])
    const second = new ScriptAdapter([])
    await harness(ctx, first, second, config)
    await turn(await createAgent(ctx, route))
    expect(first.requests).toHaveLength(2)
    expect(second.requests).toHaveLength(0)
  })

  it.each([false, true])('composes native retry independently of mount order (fallback first=%s)', async (firstMount) => {
    const first = new ScriptAdapter([failure('SERVER'), textResponse('native recovered')])
    const second = new ScriptAdapter([])
    await harness(ctx, first, second, {}, firstMount)
    await turn(await createAgent(ctx))
    expect(first.requests).toHaveLength(2)
    expect(second.requests).toHaveLength(0)
  })

  it('honors always retry rather than switching providers', async () => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER'), textResponse()], {
      mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    })
    const second = new ScriptAdapter([])
    await harness(ctx, first, second)
    await turn(await createAgent(ctx))
    expect(first.requests).toHaveLength(3)
    expect(second.requests).toHaveLength(0)
  })

  it('restores the primary on the next turn without model-selection middleware', async () => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER'), textResponse('primary again')])
    const second = new ScriptAdapter([textResponse()])
    await harness(ctx, first, second)
    const agent = await createAgent(ctx)
    await turn(agent)
    await turn(agent)
    expect(first.requests).toHaveLength(3)
    expect(second.requests).toHaveLength(1)
    expect(agent.session.requestHeader()?.config).toEqual(primary)
  })

  it('can fall back again on a later turn after another primary outage', async () => {
    const first = new ScriptAdapter(Array.from({ length: 4 }, () => failure('SERVER')))
    const second = new ScriptAdapter([textResponse(), textResponse()])
    await harness(ctx, first, second)
    const events: fallback.FallbackEvent[] = []
    ctx.on('switchboard/fallback', (event) => { events.push(event) })
    const agent = await createAgent(ctx)
    await turn(agent)
    await turn(agent)
    expect(first.requests).toHaveLength(4)
    expect(second.requests).toHaveLength(2)
    expect(events.map(event => event.turn)).toEqual([1, 2])
  })

  it('keeps partial failed responses out of the replacement model history', async () => {
    const partial = [...textResponse('discarded').slice(0, -1), ...failure('TRANSPORT')]
    const first = new ScriptAdapter([partial, partial])
    const second = new ScriptAdapter([textResponse()])
    await harness(ctx, first, second)
    const agent = await createAgent(ctx)
    await turn(agent)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/attempt')).toHaveLength(2)
    expect(second.requests[0]?.messages.filter(message => message.role === 'assistant')).toEqual([])
  })

  it.each([primary, alternate, { provider: 'other', model: 'chosen' }])('preserves explicit next-turn model selection: %j', async (selected) => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER'), textResponse('selected')])
    const second = new ScriptAdapter([textResponse(), textResponse('selected')])
    await harness(ctx, first, second)
    const selection: ModelSelectionRef = { current: primary, assembled: undefined }
    const agent = await createAgent(ctx, primary, (agentCtx) => { installModelSelection(agentCtx, selection) })
    await turn(agent)
    expect(agent.session.requestHeader()?.config).toEqual(alternate)
    selection.current = selected
    await turn(agent)
    expect(agent.session.requestHeader()?.config).toEqual(selected)
  })

  it.each([primary, alternate])('restores stop sequences only for the selected primary route: %j', async (selected) => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER'), textResponse()])
    const second = new ScriptAdapter([textResponse(), textResponse()])
    await harness(ctx, first, second)
    const selection: ModelSelectionRef = { current: primary, assembled: undefined }
    const agent = await createAgent(ctx, primary, (agentCtx) => {
      installModelSelection(agentCtx, selection)
      agentCtx.on('agent/request', async (payload, next) => {
        const resolved = await next()
        return payload.turn === 1 ? { ...resolved, stop: ['END'] } : resolved
      })
    })
    await turn(agent)
    expect(first.requests[0]?.stop).toEqual(['END'])
    expect(second.requests[0]?.stop).toBeUndefined()
    selection.current = selected
    await turn(agent)
    const request = selected === primary ? first.requests.at(-1) : second.requests.at(-1)
    expect(request).toMatchObject(selected)
    expect(request?.stop).toEqual(selected === primary ? ['END'] : undefined)
  })

  it('strips model-specific controls for fallback and restores explicit primary controls', async () => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER'), textResponse()])
    const second = new ScriptAdapter([textResponse()])
    await harness(ctx, first, second)
    const controls = { stop: ['END'], reasoningEffort: ReasoningEffortId('high'), temperature: 0.4, maxTokens: 200 }
    const agent = await createAgent(ctx, primary, (agentCtx) => {
      agentCtx.on('agent/request', async (_payload, next) => ({ ...await next(), ...controls }))
    })
    await turn(agent)
    expect(second.requests[0]).toMatchObject({ ...alternate, temperature: 0.4, maxTokens: 200 })
    expect(second.requests[0]?.stop).toBeUndefined()
    expect(second.requests[0]?.reasoningEffort).toBeUndefined()
    await turn(agent)
    expect(first.requests.at(-1)).toMatchObject({ ...primary, ...controls })
  })

  it('re-resolves adapter defaults when restoring the primary route', async () => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER'), textResponse()])
    let cap = 256
    vi.spyOn(first, 'resolveModel').mockImplementation(async (provider, model) => ({
      provider, id: model, name: model, defaultMaxTokens: cap,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
        defaultEffort: ReasoningEffortId('high'),
      },
    }))
    const second = new ScriptAdapter([textResponse()])
    await harness(ctx, first, second)
    const agent = await createAgent(ctx)
    await turn(agent)
    expect(first.requests[0]?.maxTokens).toBe(256)
    expect(second.requests[0]?.maxTokens).toBeUndefined()
    expect(second.requests[0]?.reasoningEffort).toBeUndefined()
    cap = 128
    await turn(agent)
    expect(first.requests.at(-1)?.maxTokens).toBe(128)
    expect(first.requests.at(-1)?.reasoningEffort).toBe('high')
  })

  it('rejects empty provider and model identifiers at configuration validation', () => {
    expect(() => fallback.Config({ fallbackProvider: '' })).toThrow()
    expect(() => fallback.Config({ primaryProviders: [''] })).toThrow()
    expect(() => fallback.Config({ modelMap: { example: '' } })).toThrow()
  })

  it('never starts a second fallback in a turn, even if fallback is also a primary', async () => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER')])
    const second = new ScriptAdapter([failure('SERVER'), failure('SERVER')])
    await harness(ctx, first, second, {
      primaryProviders: [primary.provider, alternate.provider],
      modelMap: { [primary.model]: alternate.model, [alternate.model]: 'another' },
    })
    const observed = vi.fn()
    ctx.on('switchboard/fallback', observed)
    await turn(await createAgent(ctx))
    expect(second.requests).toHaveLength(2)
    expect(observed).toHaveBeenCalledTimes(1)
  })

  it('cancellation after downstream recovery prevents fallback', async () => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER')])
    const second = new ScriptAdapter([])
    await harness(ctx, first, second)
    ctx.on('agent/request-error', async ({ agent }, next) => { await next(); agent.cancel({ kind: 'user' }) })
    await turn(await createAgent(ctx))
    expect(second.requests).toHaveLength(0)
  })

  it('retains restoration when the next turn is cancelled before its request is logged', async () => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER'), textResponse('primary again')])
    await harness(ctx, first, new ScriptAdapter([textResponse()]))
    const agent = await createAgent(ctx)
    await turn(agent)
    const stop = ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      if (payload.turn === 2) agent.cancel({ kind: 'user' })
      return resolved
    }, { prepend: true })
    await turn(agent)
    expect(agent.session.requestHeader()?.config).toEqual(alternate)
    stop()
    await turn(agent)
    expect(first.requests).toHaveLength(3)
    expect(agent.session.requestHeader()?.config).toEqual(primary)
  })

  it('does not schedule fallback after disposal during downstream recovery', async () => {
    await harness(ctx, new ScriptAdapter([]), new ScriptAdapter([]), { enabled: false })
    const fiber = await ctx.plugin(fallback, fallback.Config({}))
    const agent = await createAgent(ctx)
    agent.session.append('request/header', { header: { config: primary }, reason: 'initial' })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('agent/request-error', async (_payload, next) => {
      entered.resolve(undefined)
      await release.promise
      return next()
    })
    const recovery = agentEvents(ctx, agent).waterfall('agent/request-error', {
      turn: 1, step: 1, provider: primary.provider, failure: { code: 'SERVER', message: 'busy' },
      retryPolicy: undefined, signal: new AbortController().signal,
    }, () => Promise.resolve(undefined))
    await entered.promise
    await fiber.dispose()
    release.resolve(undefined)
    expect(await recovery).toBeUndefined()
    expect(await agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, () => Promise.resolve(primary))).toBe(primary)
  })

  it.each([false, true])('keeps fallback continuations free of false switch notices and preserves the next turn switch notice (late mount=%s)', async (lateMount) => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER'), textResponse('primary again')])
    const second = new ScriptAdapter([textResponse(), textResponse('continuation')])
    await harness(ctx, first, second, { enabled: !lateMount })
    const selection: ModelSelectionRef = { current: primary, assembled: undefined }
    const agent = await createAgent(ctx, primary, (agentCtx) => { installModelSelection(agentCtx, selection) })
    if (lateMount) await ctx.plugin(fallback, fallback.Config({}))
    let steered = false
    ctx.on('llm/stream', (options, next) => {
      if (options.provider === alternate.provider && !steered) {
        steered = true
        agent.steer(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      }
      return next()
    })
    await turn(agent)
    expect(second.requests).toHaveLength(2)
    expect(second.requests[1]?.messages.filter(message => message.source?.kind === 'model-selection')).toEqual([])
    expect(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'model-selection')).toEqual([])
    expect(agent.session.snapshotEvents().flatMap(e => e.type === 'assistant/message' ? [{ turn: e.data.turn, step: e.data.step, provider: e.data.message.source.provider }] : [])).toEqual([
      { turn: 1, step: 1, provider: alternate.provider },
      { turn: 1, step: 2, provider: alternate.provider },
    ])
    await turn(agent)
    expect(first.requests.at(-1)).toMatchObject(primary)
    expect(first.requests.at(-1)?.messages.filter(message => message.source?.kind === 'model-selection')).toMatchObject([{
      source: { kind: 'model-selection', form: 'notice' },
      content: [{ type: 'text', text: '[model changed: assistant turns above this point were generated by openrouter/deepseek/deepseek-v4-flash; the session continues with deepseek-official/deepseek-v4-flash]' }],
    }])
    expect(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'model-selection')).toHaveLength(1)
  })

  it('filters only model-selection notices for the active fallback turn on an unchanged route', async () => {
    await harness(ctx, new ScriptAdapter([failure('SERVER'), failure('SERVER')]), new ScriptAdapter([textResponse()]))
    const agent = await createAgent(ctx)
    await turn(agent)
    const user = createUserMessage({ content: [{ type: 'text', text: 'keep user' }], source: { kind: 'user' } })
    const instructions = createUserMessage({ content: [{ type: 'text', text: 'keep instructions' }], source: { kind: 'model-selection', form: 'instructions' } })
    const notice = createUserMessage({ content: [{ type: 'text', text: 'switch' }], source: { kind: 'model-selection', form: 'notice', summary: 'switch' } })
    const messages = [user, instructions, notice]
    const decision: PreStepDecision = { kind: 'enter', messages, startsRequestSeries: true }
    const payload = { turn: 1, step: 2, messages, signal: new AbortController().signal }
    const dispatch = agentEvents(ctx, agent)
    expect(await dispatch.waterfall('agent/pre-step', payload, () => Promise.resolve(decision)))
      .toEqual({ ...decision, messages: [user, instructions] })
    expect(await dispatch.waterfall('agent/pre-step', { ...payload, turn: 2 }, () => Promise.resolve(decision))).toBe(decision)
    const reject = { kind: 'reject' as const }
    expect(await dispatch.waterfall('agent/pre-step', payload, () => Promise.resolve(reject))).toBe(reject)
    const other = await ctx.agents.create({ sessionId: SessionId('other-notice'), agentOptions: primary })
    expect(await agentEvents(ctx, other.agent).waterfall('agent/pre-step', payload, () => Promise.resolve(decision))).toBe(decision)
    for (const config of [{ ...alternate, provider: 'other' }, { ...alternate, model: 'other' }]) {
      agent.session.append('request/header', { header: { config }, reason: 'change' })
      expect(await dispatch.waterfall('agent/pre-step', payload, () => Promise.resolve(decision))).toBe(decision)
    }
  })

  it('removes pending restoration when an agent is disposed', async () => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER')])
    await harness(ctx, first, new ScriptAdapter([textResponse()]))
    const handle = await ctx.agents.create({ sessionId: SessionId('disposed-agent'), agentOptions: primary })
    await turn(handle.agent)
    await handle.dispose()
    expect(await agentEvents(ctx, handle.agent).waterfall('agent/request', { turn: 2, step: 1, signal: new AbortController().signal }, () => Promise.resolve(alternate))).toBe(alternate)
  })

  it('does not invent a failed model when no matching request header exists', async () => {
    await harness(ctx, new ScriptAdapter([textResponse()]), new ScriptAdapter([]), { primaryProviders: ['other'] })
    const current = await createAgent(ctx)
    const dispatch = () => agentEvents(ctx, current).waterfall('agent/request-error', {
      turn: 1, step: 1, provider: 'other', failure: { code: 'SERVER', message: 'busy' },
      signal: new AbortController().signal, retryPolicy: undefined,
    }, () => Promise.resolve(undefined))
    expect(await dispatch()).toBeUndefined()
    await turn(current)
    expect(await dispatch()).toBeUndefined()
  })

  it('preserves an independently replaced proposal on the next turn', async () => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER'), textResponse()])
    await harness(ctx, first, new ScriptAdapter([textResponse()]))
    const agent = await createAgent(ctx)
    await turn(agent)
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'other', model: 'chosen' }))
    await turn(agent)
    expect(first.requests.at(-1)).toMatchObject({ provider: 'other', model: 'chosen' })
  })

  it('does not affect another agent and removes pending listeners on disposal', async () => {
    const first = new ScriptAdapter([failure('SERVER'), failure('SERVER'), textResponse('other')])
    const second = new ScriptAdapter([textResponse()])
    const fiber = await harness(ctx, first, second)
    const agent = await createAgent(ctx)
    await turn(agent)
    const other = await ctx.agents.create({ sessionId: SessionId('other'), agentOptions: primary })
    await turn(other.agent)
    expect(other.agent.session.requestHeader()?.config).toEqual(primary)
    await fiber.dispose()
    const seed: LlmCallConfig = alternate
    expect(await agentEvents(ctx, agent).waterfall('agent/request', { turn: 2, step: 1, signal: new AbortController().signal }, () => Promise.resolve(seed))).toBe(seed)
  })
})
