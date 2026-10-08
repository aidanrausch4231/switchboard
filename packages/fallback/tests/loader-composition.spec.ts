import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '../src/dsh.ts'
import { Loader } from '../src/dsh.ts'
import { Include } from '../src/dsh.ts'
import { AgentRegistry } from '../src/dsh.ts'
import { AgentLoop } from '../src/dsh.ts'
import { LlmRuntime, type LlmCallConfig } from '../src/dsh.ts'
import { Dshretry as retry } from '../src/dsh.ts'
import { SessionStore } from '../src/dsh.ts'
import { SessionProjectionRegistry } from '../src/dsh.ts'
import { SystemPrompt } from '../src/dsh.ts'
import { ToolRuntime } from '../src/dsh.ts'
import * as fallback from '../src/index.ts'
import { alternate, createAgent, failure, primary, ScriptAdapter, textResponse, turn } from './harness.ts'

const ctx = new Context()
afterEach(async () => { await ctx.fiber.dispose(); vi.restoreAllMocks() }, 60_000)

it('loads the YAML plugin composition and records fallback plus primary restoration', async () => {
  ctx.baseUrl = new URL('./fixtures/', import.meta.url).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-llm-retry', retry],
    ['@switchboard/fallback', fallback],
  ])
  // Keep Vite's source-plane module identities while exercising Loader activation.
  ctx.loader.internal = {
    version: 'v2',
    loadCache: new Map(),
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`Unexpected plugin: ${specifier}`)
      return modules.get(specifier)
    },
    register() { throw new Error('Unexpected register') },
    getOrCreateModuleJob() { throw new Error('Unexpected module job') },
    resolveSync() { throw new Error('Unexpected resolve') },
    load() { throw new Error('Unexpected load') },
  }
  await ctx.loader.create({
    name: 'cordis:include', config: { path: new URL('./fixtures/cordis.yml', import.meta.url).href },
  })
  await ctx.loader.await()
  const unloaded = [...ctx.loader.entries()]
    .filter(entry => !entry.disabled && entry.fiber === undefined)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  const first = new ScriptAdapter([failure('SERVER'), failure('SERVER'), textResponse('primary again')])
  const second = new ScriptAdapter([textResponse()])
  ctx.llm.registerAdapter([primary.provider], first)
  ctx.llm.registerAdapter([alternate.provider], second)
  const observed = vi.fn()
  ctx.on('switchboard/fallback', observed)
  const agent = await createAgent(ctx)
  await turn(agent)
  await turn(agent)
  expect(first.requests).toHaveLength(3)
  expect(second.requests).toHaveLength(1)
  expect(observed).toHaveBeenCalledExactlyOnceWith({
    sessionId: agent.session.id, turn: 1, step: 1, from: primary, to: alternate, code: 'SERVER',
  })
  expect(agent.session.snapshotEvents().flatMap<{ type: string; config: LlmCallConfig }>((event) => {
    if (event.type === 'request/header') return [{ type: event.type, config: event.data.header.config }]
    if (event.type === 'assistant/message') return [{ type: event.type, config: {
      provider: event.data.message.source.provider, model: event.data.message.source.model,
    } }]
    return []
  })).toEqual([
    { type: 'request/header', config: primary },
    { type: 'request/header', config: alternate },
    { type: 'assistant/message', config: alternate },
    { type: 'request/header', config: primary },
    { type: 'assistant/message', config: primary },
  ])
}, 60_000)
