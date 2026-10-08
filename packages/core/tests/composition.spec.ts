import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '../src/dsh.ts'
import { Loader } from '../src/dsh.ts'
import { Include } from '../src/dsh.ts'
import { Group } from '../src/dsh.ts'
import { Timer } from '../src/dsh.ts'
import { AgentRegistry } from '../src/dsh.ts'
import { AgentLoop } from '../src/dsh.ts'
import { AgentPresets } from '../src/dsh.ts'
import { LlmRuntime } from '../src/dsh.ts'
import { SessionStore, SessionId } from '../src/dsh.ts'
import { SubagentRuntime } from '../src/dsh.ts'
import { SessionProjectionRegistry } from '../src/dsh.ts'
import { SystemPrompt } from '../src/dsh.ts'
import { ToolRuntime } from '../src/dsh.ts'
import { Storage } from '../src/dsh.ts'
import { DshStorageJson as StorageJson } from '../src/dsh.ts'
import { DshStorageDomain as StorageDomain } from '../src/dsh.ts'
import { LocalSubprocessRuntime } from '../src/dsh.ts'
import { LocalBashExecutor } from '../src/dsh.ts'
import { LocalFileSystem } from '../src/dsh.ts'
import { DshToolFs as ToolFs } from '../src/dsh.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from './fixtures/mock-adapter.ts'
import Switchboard from '../src/index.ts'
import { flowSchema } from '../src/recipe.ts'
import { recipe, temp } from './helpers.ts'

it('boots the Loader composition and runs fix-bug through real root agents and shell to the human gate', async () => {
  const root = await temp(); const cwd = join(root, 'workspace')
  await mkdir(join(cwd, 'src'), { recursive: true })
  await promisify(execFile)('git', ['init', '--quiet', cwd])
  await writeFile(join(cwd, 'src/bug.ts'), 'export const answer = 42\n')
  const adapter = new MockAdapter([
    toolCallResponse('map-write', 'write', { file_path: 'forbidden', content: 'no' }),
    textResponse('Map: inspect src/bug.ts'),
    toolCallResponse('outside-write', 'write', { file_path: 'outside', content: 'no' }),
    toolCallResponse('allowed-write', 'write', { file_path: 'src/fixed.ts', content: 'export const fixed = true\n' }),
    textResponse('Build: fixed'), textResponse('REFUTED: check again'),
    textResponse('Build: checked again'), textResponse('APPROVED: correct'),
  ])
  const native = { calls: 0, disposed: 0 }
  const fixture = {
    name: 'flow-fixture', inject: ['llm', 'agentPresets', 'subagents'],
    async apply(ctx: Context) {
      ctx.effect(() => ctx.llm.registerAdapter(['fake'], adapter))
      ctx.effect(() => ctx.agentPresets.register({ id: 'flow-test', plugins: [] }))
      ctx.effect(() => ctx.subagents.registerProvider({
        name: 'fake-native', inheritsParentContext: false,
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        async start(request) {
          expect(request.parent.session.header.cwd).toBe(cwd)
          expect(request.agentOptions).toBeUndefined()
          expect(request.toolFilter).toBeUndefined()
          native.calls++
          return {
            id: SessionId(`native-${native.calls}`), localAgent: undefined,
            result: Promise.resolve({ output: [{ type: 'text', text: 'Native complete' }], stopReason: 'completed' }),
            async dispose() { native.disposed++ },
          }
        },
      }))
    },
  }
  const modules = new Map<string, unknown>([
    ['timer', Timer], ['sessions', SessionStore], ['projections', SessionProjectionRegistry], ['llm', LlmRuntime], ['prompt', SystemPrompt], ['tools', ToolRuntime], ['agents', AgentRegistry], ['loop', AgentLoop], ['presets', AgentPresets], ['storage', Storage], ['json', StorageJson], ['domain', StorageDomain], ['subprocess', LocalSubprocessRuntime], ['shell', LocalBashExecutor], ['fixture', fixture], ['switchboard', Switchboard], ['fs', LocalFileSystem], ['tool-fs', ToolFs], ['subagents', SubagentRuntime],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: timer', '- name: sessions', '- name: projections', '- name: llm', '- name: prompt', '  config: { personaPrefix: "" }', '- name: tools', '- name: fs', '- name: tool-fs', '- name: agents', '- name: loop', '  config: { agents: [] }', '- name: presets', '  config: { default: flow-test }', '- name: storage', '- name: json', `  config: { root: ${JSON.stringify(join(root, 'storage'))} }`, '- name: domain', '  config: { backend: json }', '- name: subprocess', '- name: shell', '- name: subagents', '- name: fixture', '- name: switchboard', '  config: { agentPreset: flow-test }', '',
  ].join('\n'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() }, 60_000)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include; ctx.loader.builtins.group = Group
  const unsupported = (): never => { throw new Error('Fixture supports only Loader imports') }
  ctx.loader.internal = {
    version: 'v2',
    get loadCache() { return unsupported() },
    register: unsupported, getOrCreateModuleJob: unsupported, resolveSync: unsupported, load: unsupported,
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture import ${specifier}`)
      return modules.get(specifier)
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const flow = flowSchema.parse(JSON.parse(await readFile(new URL('../examples/fix-bug-with-review.json', import.meta.url), 'utf8')))
  for (const block of flow.blocks) {
    if (block.kind === 'agent') { block.provider = 'fake'; block.model = 'scripted' }
  }
  const board = ctx.switchboard
  expect((await board.preflightFlow(flow, { workspace: cwd, bug: 'wrong answer' })).ok).toBe(true)
  await board.saveFlow(flow)
  const automation = await board.saveAutomation({ name: 'Fix bug on demand', flowId: flow.id, inputs: { workspace: cwd, bug: 'wrong answer' }, schedule: { kind: 'manual' }, enabled: true })
  const firing = await board.runAutomationNow(automation.id)
  expect(firing.state, firing.error).toBe('started')
  const run = board.getRun(firing.id)
  expect(run.inputs.workspace).toBe(cwd)
  expect(board.getAutomationStats(automation.id).runs[0]?.id).toBe(run.id)
  const controller = new AbortController()
  const frames = board.followRuns(run.id, controller.signal)[Symbol.asyncIterator]()
  try {
    const first = await frames.next()
    if (first.done) throw new Error('Missing snapshot')
    expect(first.value.type).toBe('snapshot')
    while (board.getRun(run.id).state !== 'needs-you') {
      const next = await frames.next()
      if (next.done) throw new Error('Stream ended before gate')
      expect(next.value.run.state, next.value.run.error).not.toBe('failed')
    }
  } finally { controller.abort(); await frames.return?.() }
  const waiting = board.getRun(run.id)
  expect(waiting.state).toBe('needs-you')
  expect(waiting.rounds).toEqual({ 'review:build': 1 })
  expect(waiting.attempts.filter(attempt => attempt.sessionId)).toHaveLength(5)
  expect(waiting.tokens).toBeGreaterThan(0)
  expect(adapter.requests).toHaveLength(8)
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).not.toContain('write')
  expect(adapter.requests[2]?.tools?.map(tool => tool.name)).toContain('write')
  await expect(readFile(join(cwd, 'forbidden'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(cwd, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(cwd, 'src/fixed.ts'), 'utf8')).toBe('export const fixed = true\n')
  expect(adapter.requests[0]?.messages.some(message => JSON.stringify(message).includes('Flow step scope:'))).toBe(true)
  expect([...ctx.agents.list()]).toHaveLength(0)
  expect(await readFile(join(cwd, 'src/bug.ts'), 'utf8')).toBe('export const answer = 42\n')
  expect((await board.cancelRun(run.id)).state).toBe('cancelled')
  for (const harness of ['claude-code', 'codex'] as const) {
    const nativeFlow = recipe(cwd)
    const block = nativeFlow.blocks[0]!
    if (block.kind !== 'agent') throw new Error('fixture')
    block.harness = harness
    expect((await board.preflightFlow(nativeFlow, {})).items.some(item => item.code === 'harness')).toBe(true)
    block.provider = 'fake-native'
    await board.saveFlow(nativeFlow)
    const nativeRun = await board.startRun(nativeFlow.id, {})
    await vi.waitFor(() => { expect(board.getRun(nativeRun.id).state).toBe('succeeded') })
    expect(board.getRun(nativeRun.id).attempts[0]?.usage).toBeUndefined()
  }
  expect(native).toEqual({ calls: 2, disposed: 2 })
  expect(adapter.requests).toHaveLength(8)
  expect([...ctx.agents.list()]).toHaveLength(0)
}, 60_000)
