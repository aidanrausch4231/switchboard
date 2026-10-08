import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from './fixtures/mock-adapter.ts'
import { SessionId } from '../src/dsh.ts'
import { flowSchema, validateFlow } from '../src/recipe.ts'
import { checkPath } from '../src/files.ts'
import { recipe, temp } from './helpers.ts'
import { runtimeHarness } from './runtime-harness.ts'

it.each(['read', 'write'] as const)('denies %s through a symlink followed by a parent traversal with real fs-local', async (tool) => {
  const root = await temp()
  const cwd = join(root, 'workspace')
  await mkdir(join(cwd, 'src'), { recursive: true })
  await mkdir(join(root, 'outside/subdir'), { recursive: true })
  await writeFile(join(root, 'outside/target'), 'private contents')
  await symlink(join(root, 'outside/subdir'), join(cwd, 'src/link'), 'junction')
  const { environment, adapter } = await runtimeHarness([
    toolCallResponse('escape', tool, { file_path: 'src/link/../target', ...(tool === 'write' ? { content: 'overwritten' } : {}) }),
    textResponse('done'),
  ], 'global')
  const block = recipe(cwd).blocks[0]!
  if (block.kind !== 'agent') throw new Error('fixture')
  block.provider = 'fake'; block.model = 'scripted'
  block.scope.read = ['src']; block.scope.write = ['src']; block.scope.sandbox = 'workspace-write'
  await environment.runAgent(block, 'Try the path', new AbortController().signal, () => {}, async () => {})
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('Path is outside this Flow scope')
  expect(JSON.stringify(adapter.requests[1]?.messages)).not.toContain('private contents')
  expect(await readFile(join(root, 'outside/target'), 'utf8')).toBe('private contents')
})

it('denies symlink escapes through the nearest existing ancestor of a missing write target', async () => {
  const root = await temp(); const cwd = join(root, 'workspace')
  await mkdir(join(cwd, 'src'), { recursive: true }); await mkdir(join(root, 'outside'))
  await symlink(join(root, 'outside'), join(cwd, 'src/link'), 'junction')
  const { environment, adapter } = await runtimeHarness([
    toolCallResponse('escape', 'write', { file_path: 'src/link/missing/target', content: 'bad' }), textResponse('done'),
  ], 'global')
  const block = recipe(cwd).blocks[0]!
  if (block.kind !== 'agent') throw new Error('fixture')
  block.provider = 'fake'; block.model = 'scripted'; block.scope.write = ['src']; block.scope.sandbox = 'workspace-write'
  await environment.runAgent(block, 'Try the path', new AbortController().signal, () => {}, async () => {})
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('Path is outside this Flow scope')
  await expect(readFile(join(root, 'outside/missing/target'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['standard', 'ptc'] as const)('runs native scoped tools from the shipped %s preset for both example recipes', async (preset) => {
  const cwd = await temp(); await mkdir(join(cwd, 'src')); await mkdir(join(cwd, 'notes'))
  await writeFile(join(cwd, 'src/input'), 'readable')
  const { ctx, environment } = await runtimeHarness([], preset)
  expect(ctx.tools.schemas()).toEqual([])
  for (const example of ['fix-bug-with-review', 'company-research']) {
    const flow = flowSchema.parse(JSON.parse(await readFile(new URL(`../examples/${example}.json`, import.meta.url), 'utf8')))
    for (const block of flow.blocks) {
      if (block.kind !== 'agent') continue
      block.scope.cwd = cwd; block.provider = 'fake'; block.model = 'scripted'
      const readable = join(block.scope.read[0] ?? '.', 'input')
      await writeFile(join(cwd, readable), 'readable')
      const script = new MockAdapter([
        ...(block.scope.read.length ? [toolCallResponse('read', 'read', { file_path: readable })] : []),
        ...(block.scope.write.length ? [toolCallResponse('write', 'write', { file_path: `${block.scope.write[0]}/result`, content: 'written' })] : []),
        ...(block.scope.commands.length ? [toolCallResponse('shell', 'bash', { command: block.scope.commands[0] })] : []),
        textResponse('done'),
      ])
      const dispose = ctx.llm.registerAdapter(['script'], script)
      block.provider = 'script'
      try {
        const result = await environment.runAgent(block, 'Use the granted tools', new AbortController().signal, () => {}, async () => {})
        expect(result.error).toBeUndefined()
        const names = script.requests[0]?.tools?.map(tool => tool.name) ?? []
        expect(names.includes('read')).toBe(block.scope.read.length > 0)
        expect(names.includes('write')).toBe(block.scope.write.length > 0)
        expect(names.includes('bash')).toBe(block.scope.commands.length > 0)
        expect(names.includes('web_search')).toBe(block.scope.web)
        expect(names).not.toContain('run_code')
        if (block.scope.read.length) expect(JSON.stringify(script.requests[1]?.messages)).toContain('1: readable')
        if (block.scope.write.length) expect(await readFile(join(cwd, block.scope.write[0]!, 'result'), 'utf8')).toBe('written')
        expect([...ctx.agents.list()]).toHaveLength(0)
      } finally { dispose() }
    }
  }
  const plain = await ctx.agents.create({ sessionId: SessionId(`ordinary-${preset}`), setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset) } })
  try {
    const presentation = await ctx.systemPrompt.assemble({ scope: plain.agent })
    expect(presentation.tools.map(tool => tool.name).includes('run_code')).toBe(preset === 'ptc')
  } finally { await plain.dispose() }
})

it.skipIf(process.platform === 'win32').each(['standard', 'ptc'] as const)('executes only the exact granted shell command with the %s preset', async (preset) => {
  const cwd = await temp()
  const command = 'printf flow-shell'
  const { environment, adapter } = await runtimeHarness([
    toolCallResponse('allowed', 'bash', { command, description: 'Print the fixture marker' }),
    toolCallResponse('denied', 'bash', { command: 'printf forbidden', description: 'Try an ungranted command' }),
    textResponse('done'),
  ], preset)
  const block = recipe(cwd).blocks[0]!
  if (block.kind !== 'agent') throw new Error('fixture')
  block.provider = 'fake'; block.model = 'scripted'; block.scope.commands = [command]
  const result = await environment.runAgent(block, 'Run the command', new AbortController().signal, () => {}, async () => {})
  expect(result.error).toBeUndefined()
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('bash')
  expect(JSON.stringify(adapter.requests[1]?.messages.findLast(message => message.role === 'tool')?.content)).toContain('flow-shell')
  expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('Command is outside this Flow scope')
})

it('rechecks cwd after preset acquisition before creating an agent', async () => {
  const cwd = await temp()
  const { ctx, environment, adapter } = await runtimeHarness([textResponse('not launched')], 'global')
  const block = recipe(cwd).blocks[0]!
  if (block.kind !== 'agent') throw new Error('fixture')
  block.provider = 'fake'; block.model = 'scripted'
  const create = vi.spyOn(ctx.agents, 'create')
  const checkCwd = vi.fn(async () => { throw new Error('Workspace cwd changed before launch') })
  await expect(environment.runAgent(block, 'Do not launch', new AbortController().signal, () => {}, checkCwd)).rejects.toThrow('cwd changed')
  expect(checkCwd).toHaveBeenCalledOnce()
  expect(create).not.toHaveBeenCalled()
  expect(adapter.requests).toEqual([])
})

it.skipIf(process.platform === 'win32')('rechecks cwd before every check command', async () => {
  const cwd = await temp()
  const { ctx, environment } = await runtimeHarness([], 'global')
  const execute = vi.spyOn(ctx.shell, 'execute')
  const checkCwd = vi.fn<() => Promise<void>>().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('Workspace cwd changed before launch'))
  await expect(environment.runChecks({ id: 'checks', kind: 'checks', label: 'Checks', cwd, commands: ['printf first', 'printf second'] }, new AbortController().signal, checkCwd)).rejects.toThrow('cwd changed')
  expect(checkCwd).toHaveBeenCalledTimes(2)
  expect(execute).toHaveBeenCalledTimes(1)
})

it('rejects parent traversal in saved grants and preflight paths before normalizing them', async () => {
  const cwd = await temp()
  const flow = recipe(cwd)
  const block = flow.blocks[0]!
  if (block.kind !== 'agent') throw new Error('fixture')
  block.scope.read = ['src/../target']
  expect(validateFlow(flow).items.some(item => item.code === 'scope-path')).toBe(true)
  await expect(checkPath(cwd, 'src/../target', true)).rejects.toThrow('parent traversal')
})
