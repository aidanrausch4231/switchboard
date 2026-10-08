/** Single dsh import boundary. Public package exports only; includes test fixtures. */
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-cmdline'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyClaude, Config as ClaudeConfig } from '@deepseek-ai/dsh-subagent-claude-code'
export { ClaudeConfig }
const owned = new WeakMap<object, { model?: string }>()
/** The only native admission path: configure plan ourselves, then bind the exact public provider identity. */
export function registerCouncilClaude(ctx: Context, config: ClaudeConfig): void {
  applyClaude(ctx, { ...config, permissionMode: 'plan' })
  const provider = ctx.subagents.getProvider(config.providerName ?? 'claude-code')
  if (!provider) throw new Error('Council Claude provider registration failed')
  owned.set(provider, { ...config.model === undefined ? {} : { model: config.model } })
  ctx.effect(() => () => { owned.delete(provider) })
}
export function isCouncilClaude(provider: object): boolean { return owned.has(provider) }
export function councilNativeModel(ctx: Context, name: string): string | undefined {
  const provider = ctx.get('subagents')?.getProvider(name)
  return provider ? owned.get(provider)?.model : undefined
}
export { Context } from '@deepseek-ai/cordis'
export type { Agent } from '@deepseek-ai/dsh-agent'
export { BlockAssembler } from '@deepseek-ai/dsh-llm'
export { apply } from '@deepseek-ai/dsh-subagent-claude-code'
export { deadline } from '@deepseek-ai/dsh-timeout'
export { default as Schema } from '@deepseek-ai/schemastery'
export { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
export { Service } from '@deepseek-ai/cordis'
export { brandString } from '@deepseek-ai/dsh-brand'
export type { AgentHandle } from '@deepseek-ai/dsh-agent'
export type { SessionId } from '@deepseek-ai/dsh-session'
export type { Domain } from '@deepseek-ai/dsh-storage-domain'
export type { KvTable } from '@deepseek-ai/dsh-storage-domain'
export { Remote } from '@deepseek-ai/dsh-typert-protocol'
export { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
export type { TokenUsage } from '@deepseek-ai/dsh-llm'
export { defineDomain } from '@deepseek-ai/dsh-storage-domain'
export { domainTable } from '@deepseek-ai/dsh-storage-domain'
export type { Branded } from '@deepseek-ai/dsh-brand'
export { LlmAdapter } from '@deepseek-ai/dsh-llm'
export type { GenerateOptions } from '@deepseek-ai/dsh-llm'
export type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
export type { StreamChunk } from '@deepseek-ai/dsh-llm'
export { default as Loader } from '@deepseek-ai/cordis-plugin-loader'
export { default as Subagents } from '@deepseek-ai/dsh-subagent'
export * as DshClaude from '@deepseek-ai/dsh-subagent-claude-code'
export { default as SubprocessLocal } from '@deepseek-ai/dsh-subprocess-local'
export { default as AgentRegistry } from '@deepseek-ai/dsh-agent'
export { default as AgentLoop } from '@deepseek-ai/dsh-agent-loop'
export { default as SessionStore } from '@deepseek-ai/dsh-session'
export { default as SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
export { default as Persistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
export { default as LlmRuntime } from '@deepseek-ai/dsh-llm'
export type { ToolCallId } from '@deepseek-ai/dsh-llm'
export { default as SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
export { default as Tools } from '@deepseek-ai/dsh-tools'
export { default as Storage } from '@deepseek-ai/dsh-storage'
export * as DshJsonStorage from '@deepseek-ai/dsh-storage-json'
export * as DshDomain from '@deepseek-ai/dsh-storage-domain'
export { boot } from '@deepseek-ai/dsh-app-boot'
export { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
export { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
