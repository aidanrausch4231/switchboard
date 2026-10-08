/** Plugin-owned keyless Host fixture using only exported dsh services. */
import { Context } from '../../src/dsh.ts'
import { Loader } from '../../src/dsh.ts'
import { Group } from '../../src/dsh.ts'
import { LlmRuntime } from '../../src/dsh.ts'
import { SessionStore } from '../../src/dsh.ts'
import { SessionProjectionRegistry } from '../../src/dsh.ts'
import { SystemPrompt } from '../../src/dsh.ts'
import { ToolRuntime } from '../../src/dsh.ts'
import { AgentRegistry } from '../../src/dsh.ts'
import { AgentLoop } from '../../src/dsh.ts'
import { AgentPresets } from '../../src/dsh.ts'

export async function harness(): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = new URL('./', import.meta.url).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'standard' })
  return ctx
}
