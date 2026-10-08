/**
 * Turn-local provider fallback after delegated request recovery is exhausted.
 * @module @switchboard/fallback
 */

import { type Context } from './dsh.ts'
import { z } from './dsh.ts'
import { type Agent, type RequestErrorAction } from './dsh.ts'
import { type LlmCallConfig } from './dsh.ts'
import { type SessionId } from './dsh.ts'

/** Cordis plugin name. */
export const name = 'switchboard-fallback'
/** The plugin observes live agent recovery. */
export const inject = ['agents']

/** Provider routes and eligible quota policy for automatic fallback. */
export interface Config {
  /** Install fallback listeners. */
  enabled: boolean
  /** Provider routes eligible for fallback. */
  primaryProviders: string[]
  /** Registered replacement provider route. */
  fallbackProvider: string
  /** Exact primary model ids mapped to replacement model ids. */
  modelMap: Record<string, string>
  /** Permit switching billed providers on exhausted quota. */
  fallbackOnQuota: boolean
}

/** Runtime configuration with DeepSeek-to-OpenRouter defaults. */
export const Config: z<Partial<Config>, Config> = z.object({
  enabled: z.boolean().default(true),
  primaryProviders: z.array(z.string().min(1)).default(['deepseek-official']),
  fallbackProvider: z.string().min(1).default('openrouter'),
  modelMap: z.dict(z.string().min(1)).default({
    'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
    'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  }),
  fallbackOnQuota: z.boolean().default(false),
})

/** Process-local fallback decision; actual requests remain in core session events. */
export interface FallbackEvent {
  /** Session whose next attempt will use the replacement route. */
  sessionId: SessionId
  /** Turn receiving fallback. */
  turn: number
  /** Step whose primary request failed. */
  step: number
  /** Failed request route. */
  from: Pick<LlmCallConfig, 'provider' | 'model'>
  /** Replacement request route. */
  to: Pick<LlmCallConfig, 'provider' | 'model'>
  /** Normalized primary failure code. */
  code: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A terminal primary failure scheduled one turn-local fallback.
     * @mode emit
     * @param event - Selected routes, session position, and primary failure code.
     */
    'switchboard/fallback'(event: FallbackEvent): void
  }
}

interface PendingFallback {
  turn: number
  to: FallbackEvent['to']
  restore: LlmCallConfig
  dispose: () => void
}

const transientCodes = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'])

/**
 * Install turn-local fallback after downstream retry decisions; observer throws cannot block retry.
 * Restore primary stop sequences only after the next turn resolves to the original primary route.
 * @param ctx - Plugin context owning listeners and pending decisions.
 * @param config - Validated fallback configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const pending = new Map<Agent, PendingFallback>()
  let disposed = false

  function clear(agent: Agent): void {
    pending.get(agent)?.dispose()
    pending.delete(agent)
  }

  ctx.effect(() => () => {
    disposed = true
    for (const agent of pending.keys()) clear(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => { clear(agent) })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    // Only a started stream confirms that the next turn's route was logged.
    if (frame.type === 'start' && pending.get(agent)?.turn !== frame.turn) clear(agent)
  })

  ctx.on('agent/request', async ({ agent, turn, signal }, next) => {
    const resolved = await next()
    const fallback = pending.get(agent)
    if (disposed || signal.aborted || fallback === undefined) return resolved
    if (fallback.turn !== turn) {
      const { restore } = fallback
      return resolved.provider === restore.provider && resolved.model === restore.model && restore.stop !== undefined
        ? { stop: restore.stop, ...resolved } : resolved
    }
    // pi-ai rejects stop; reasoning effort ids belong to the exact source model.
    const { stop: _stop, reasoningEffort: _effort, ...portable } = resolved
    return { ...portable, ...fallback.to }
  }, { prepend: true })

  ctx.on('agent/request-error', async (
    { agent, turn, step, provider, failure, signal },
    next,
  ): Promise<RequestErrorAction> => {
    const decision = await next()
    if (decision?.kind === 'retry' || disposed || signal.aborted) return decision
    if (pending.get(agent)?.turn === turn || !config.primaryProviders.includes(provider)) return decision
    if (!transientCodes.has(failure.code) && !(config.fallbackOnQuota && failure.code === 'QUOTA')) return decision
    const header = agent.session.requestHeader()
    if (header === undefined || header.config.provider !== provider) return decision
    const from = header.config
    const model = Object.hasOwn(config.modelMap, from.model) ? config.modelMap[from.model] : undefined
    if (model === undefined) return decision
    const to = { provider: config.fallbackProvider, model }
    const { reasoningEffort: _effort, maxTokens: _cap, ...base } = from
    const restore: LlmCallConfig = {
      ...base,
      ...header.adapterDefaults?.reasoningEffort || from.reasoningEffort === undefined
        ? {} : { reasoningEffort: from.reasoningEffort },
      ...header.adapterDefaults?.maxTokens || from.maxTokens === undefined
        ? {} : { maxTokens: from.maxTokens },
    }

    // Installed after the current selection hook: restore the inherited proposal
    // inside that hook, so an explicit selection (even OpenRouter) still wins.
    const disposeRequest = ctx.on('agent/request', async (payload, nextRequest) => {
      const resolved = await nextRequest()
      if (disposed || payload.agent !== agent || payload.turn === turn) return resolved
      const { stop: _stop, ...proposal } = restore
      return resolved.provider === to.provider && resolved.model === to.model ? proposal : resolved
    })
    // Cordis prepends via unshift and executes outermost-first. Register at recovery,
    // after installModelSelection, so its post-next notice is visible to this wrapper.
    const disposeNotice = ctx.on('agent/pre-step', async (payload, nextStep) => {
      const decision = await nextStep()
      const previous = agent.session.requestHeader()?.config
      if (decision.kind === 'reject' || payload.agent !== agent || pending.get(agent)?.turn !== payload.turn
        || previous?.provider !== to.provider || previous.model !== to.model) return decision
      return {
        ...decision,
        messages: decision.messages.filter(message => message.source.kind !== 'model-selection' || message.source.form !== 'notice'),
      }
    }, { prepend: true })
    pending.set(agent, { turn, to, restore, dispose: () => { disposeRequest(); disposeNotice() } })
    const event: FallbackEvent = {
      sessionId: agent.session.id,
      turn,
      step,
      from: { provider: from.provider, model: from.model },
      to,
      code: failure.code,
    }
    try {
      ctx.emit('switchboard/fallback', event)
    } catch (error) {
      ctx.logger.warn('Fallback notification failed: %s', error)
    }
    ctx.logger.info('Fallback %s/%s -> %s/%s (%s), session %s turn %d step %d',
      from.provider, from.model, to.provider, to.model, failure.code, event.sessionId, turn, step)
    return { kind: 'retry' }
  }, { prepend: true })
}
