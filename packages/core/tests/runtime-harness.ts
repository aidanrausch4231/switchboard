import { readFile } from 'node:fs/promises'
import { applyEntryPatches, entryListSchema } from '../src/dsh.ts'
import { load } from 'js-yaml'
import { LocalFileSystem } from '../src/dsh.ts'
import { LocalSubprocessRuntime } from '../src/dsh.ts'
import { LocalBashExecutor } from '../src/dsh.ts'
import { DshToolFs as ToolFs } from '../src/dsh.ts'
import { DshToolBash as ToolBash } from '../src/dsh.ts'
import { DshToolWeb as ToolWeb } from '../src/dsh.ts'
import { DshToolPresentation as ToolPresentation } from '../src/dsh.ts'
import { DshShellEnv as ShellEnv } from '../src/dsh.ts'
import { Web } from '../src/dsh.ts'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec, type PtcRunResult } from '../src/dsh.ts'
import { AgentPreset, type Config as PresetDefinition } from '../src/dsh.ts'
import { onTestFinished } from 'vitest'
import { harness } from './fixtures/preset-harness.ts'
import { executionEnvironment } from '../src/runtime.ts'
import { MockAdapter } from './fixtures/mock-adapter.ts'

class UnusedPtcRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? null }
  }
  run(): Promise<PtcRunResult> { throw new Error('Flow agents must use native tools') }
}

export async function runtimeHarness(responses: ConstructorParameters<typeof MockAdapter>[0], preset: 'standard' | 'ptc' | 'global' = 'standard') {
  const ctx = await harness()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor)
  await ctx.plugin(ShellEnv)
  await ctx.plugin(Web)
  await ctx.plugin(UnusedPtcRuntime)
  const adapter = new MockAdapter(responses)
  ctx.effect(() => ctx.llm.registerAdapter(['fake'], adapter))
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent-preset', AgentPreset],
    ['@deepseek-ai/dsh-tool-fs', ToolFs],
    ['@deepseek-ai/dsh-tool-bash', ToolBash],
    ['@deepseek-ai/dsh-tool-web', ToolWeb],
    ['@deepseek-ai/dsh-agent-tool-presentation', ToolPresentation],
  ])
  const unsupported = (): never => { throw new Error('Only Loader imports are supported') }
  ctx.loader.internal = {
    version: 'v2', get loadCache() { return unsupported() }, register: unsupported,
    getOrCreateModuleJob: unsupported, resolveSync: unsupported, load: unsupported,
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected plugin ${specifier}`)
      return modules.get(specifier)
    },
  }
  if (preset === 'global') {
    await ctx.plugin(ToolFs)
    ctx.effect(() => ctx.agentPresets.register({ id: preset, plugins: [] }))
  } else {
    const patches = load(await readFile(new URL(`./fixtures/presets/${preset}.patch.yml`, import.meta.url), 'utf8'), { schema: entryListSchema })
    const rows = applyEntryPatches([], patches as Parameters<typeof applyEntryPatches>[1], (message) => { throw new Error(message) })
    const declaration = rows[0]!
    const config = AgentPreset.Config(declaration.config as PresetDefinition)
    // Keep shipped capability/presentation rows unchanged; unrelated interactive,
    // delegation and compaction features are disabled in this headless fixture.
    for (const row of config.plugins) if (!modules.has(row.name)) row.disabled = true
    await ctx.loader.create({ ...declaration, config })
    await ctx.loader.await()
  }
  const environment = executionEnvironment(ctx, {
    agentPreset: preset, maxAgents: 64, commandTimeoutMs: 1000, outputBytes: 32768, maxRunMinutes: 1,
  })
  return { ctx, adapter, environment }
}
