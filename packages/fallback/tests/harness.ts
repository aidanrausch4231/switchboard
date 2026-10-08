import { Context } from '../src/dsh.ts'
import { AgentRegistry, type Agent, type AgentOptions, type AgentSetup } from '../src/dsh.ts'
import { AgentLoop } from '../src/dsh.ts'
import { LlmRuntime, createUserMessage, LlmAdapter, ReasoningEffortId, resolveRetryPolicy } from '../src/dsh.ts'
import { type GenerateOptions, type RetryPolicyConfig, type StreamChunk } from '../src/dsh.ts'
import { Dshretry as retry } from '../src/dsh.ts'
import { SessionStore, SessionId } from '../src/dsh.ts'
import { SessionProjectionRegistry } from '../src/dsh.ts'
import { SystemPrompt } from '../src/dsh.ts'
import { ToolRuntime } from '../src/dsh.ts'
import * as fallback from '../src/index.ts'

export const primary = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
export const alternate = { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' }

export function textResponse(text = 'recovered'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function failure(code: string): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: code === 'ABORTED' ? 'aborted' : 'error', failure: { code, message: code } } }]
}

export class ScriptAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(
    private readonly script: StreamChunk[][],
    private readonly policy: RetryPolicyConfig = {
      mode: 'normal', maxRetries: 1,
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    },
  ) { super() }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] },
    })
  }

  override providerRetryPolicy() {
    return resolveRetryPolicy(this.policy, 'fallback test')
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.script.shift()
    if (response === undefined) throw new Error('Script exhausted')
    yield* response
  }
}

export async function baseHarness(ctx: Context): Promise<void> {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
}

export async function harness(
  ctx: Context,
  primaryAdapter: ScriptAdapter,
  alternateAdapter: ScriptAdapter,
  config: Partial<fallback.Config> = {},
  fallbackFirst = false,
) {
  await baseHarness(ctx)
  const resolved = fallback.Config(config)
  const fiber = fallbackFirst ? await ctx.plugin(fallback, resolved) : undefined
  await ctx.plugin(retry)
  const fallbackFiber = fiber ?? await ctx.plugin(fallback, resolved)
  ctx.llm.registerAdapter([primary.provider, 'other'], primaryAdapter)
  ctx.llm.registerAdapter([alternate.provider], alternateAdapter)
  return fallbackFiber
}

export async function createAgent(ctx: Context, options: AgentOptions = primary, setup?: AgentSetup) {
  const handle = await ctx.agents.create({ sessionId: SessionId('fallback-test'), agentOptions: options, ...setup === undefined ? {} : { setup } })
  return handle.agent
}

export async function turn(agent: Agent): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}
