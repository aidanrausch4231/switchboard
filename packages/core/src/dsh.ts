/** Single dsh import boundary. Public package exports only; includes test fixtures. */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Inspect the launcher's installed pi-ai, not this plugin's development links. No credential reads. */
export function supportsCodexLogin(entry = process.argv[1]): boolean {
  try {
    if (!entry) return false
    const host = createRequire(resolve(entry)).resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')
    const manifestPath = createRequire(host).resolve.paths('@earendil-works/pi-ai')
      ?.map(path => resolve(path, '@earendil-works/pi-ai/package.json')).find(path => existsSync(path))
    if (!manifestPath) return false
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }
    return Number(manifest.version.split('.')[0]) >= 1
  } catch { return false }
}

/** Public replay entry resolved from the selected dsh installation, never its source tree. */
export function replayPlugin(runtime: string): string {
  return createRequire(resolve(runtime, 'package.json')).resolve('@deepseek-ai/dsh-llm-replay')
}

export { credentialKey } from '@deepseek-ai/dsh-credentials'
export { default as AuthorizationService } from '@deepseek-ai/dsh-authorization'
export { default as LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
export * as SessionSnapshot from '@deepseek-ai/dsh-session-snapshot'
export { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-llm'
export type { Domain } from '@deepseek-ai/dsh-storage-domain'
export { Context } from '@deepseek-ai/cordis'
export { brandString } from '@deepseek-ai/dsh-brand'
export { BlockAssembler } from '@deepseek-ai/dsh-llm'
export type { TokenUsage } from '@deepseek-ai/dsh-llm'
export { SessionId } from '@deepseek-ai/dsh-session'
export type { ToolDefinition } from '@deepseek-ai/dsh-tools'
export { defineDomain } from '@deepseek-ai/dsh-storage-domain'
export { domainTable } from '@deepseek-ai/dsh-storage-domain'
export type { Branded } from '@deepseek-ai/dsh-brand'
export { Service } from '@deepseek-ai/cordis'
export { default as z } from '@deepseek-ai/schemastery'
export { Remote } from '@deepseek-ai/dsh-typert-protocol'
export { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
export { defineTool } from '@deepseek-ai/dsh-tools'
export { createUserMessage } from '@deepseek-ai/dsh-llm'
export { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
export type { SessionEvent } from '@deepseek-ai/dsh-session'
export { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
export { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
export { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
export type { TokenUsage as DshTokenUsage } from '@deepseek-ai/dsh-llm/types'
export type { SessionId as DshSessionId } from '@deepseek-ai/dsh-session/types'
export { default as Loader } from '@deepseek-ai/cordis-plugin-loader'
export { default as Include } from '@deepseek-ai/cordis-plugin-include'
export { default as Group } from '@deepseek-ai/cordis-plugin-group'
export { default as Timer } from '@deepseek-ai/cordis-plugin-timer'
export { default as AgentRegistry } from '@deepseek-ai/dsh-agent'
export { default as AgentLoop } from '@deepseek-ai/dsh-agent-loop'
export { default as AgentPresets } from '@deepseek-ai/dsh-agent-preset-registry'
export { default as LlmRuntime } from '@deepseek-ai/dsh-llm'
export { default as SessionStore } from '@deepseek-ai/dsh-session'
export { default as SubagentRuntime } from '@deepseek-ai/dsh-subagent'
export { default as SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
export { default as SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
export { default as ToolRuntime } from '@deepseek-ai/dsh-tools'
export { default as Storage } from '@deepseek-ai/dsh-storage'
export * as DshStorageJson from '@deepseek-ai/dsh-storage-json'
export * as DshStorageDomain from '@deepseek-ai/dsh-storage-domain'
export { default as LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
export { default as LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
export { default as LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
export * as DshToolFs from '@deepseek-ai/dsh-tool-fs'
export { ToolCallId } from '@deepseek-ai/dsh-llm'
export type { GenerateOptions } from '@deepseek-ai/dsh-llm'
export type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
export type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
export type { StreamChunk } from '@deepseek-ai/dsh-llm'
export type { SystemPromptUpdate } from '@deepseek-ai/dsh-llm'
export type { ToolUpdate } from '@deepseek-ai/dsh-llm'
export { LlmAdapter } from '@deepseek-ai/dsh-llm'
export type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
export { default as Persistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
export { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
export { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
export * as DshToolBash from '@deepseek-ai/dsh-tool-bash'
export * as DshToolWeb from '@deepseek-ai/dsh-tool-web'
export * as DshToolPresentation from '@deepseek-ai/dsh-agent-tool-presentation'
export * as DshShellEnv from '@deepseek-ai/dsh-shell-env'
export { default as Web } from '@deepseek-ai/dsh-web'
export { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
export type { PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
export type { PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
export type { PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
export { default as AgentPreset } from '@deepseek-ai/dsh-agent-preset'
export type { Config } from '@deepseek-ai/dsh-agent-preset'
