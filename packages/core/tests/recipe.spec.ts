import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { flowSchema, renderPrompt, validateFlow } from '../src/recipe.ts'
import { preflight } from '../src/preflight.ts'
import type { Flow } from '../src/types.ts'
import { fakeEnvironment, recipe, temp } from './helpers.ts'

it('validates both shipped examples', async () => {
  for (const name of ['fix-bug-with-review', 'company-research']) {
    const flow: unknown = JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'))
    expect(validateFlow(flow)).toEqual({ ok: true, items: [] })
    expect(flowSchema.parse(flow)).toEqual(flow)
  }
})
it('renders once without interpreting references inside input text', () => {
  expect(renderPrompt('{{inputs.task}} / {{blocks.build.output}}', { task: '{{blocks.build.output}}' }, { build: 'done' })).toBe('{{blocks.build.output}} / done')
})
const bad: [string, (flow: Flow) => void, string][] = [
  ['empty', (flow) => { flow.blocks = [] }, 'empty-flow'],
  ['duplicate', (flow) => { flow.blocks.push(flow.blocks[0]!) }, 'duplicate-id'],
  ['unknown edge', (flow) => { flow.edges.push({ from: 'build', to: 'missing', kind: 'next' }) }, 'edge-reference'],
  ['cycle', (flow) => { flow.edges.push({ from: 'build', to: 'build', kind: 'next' }) }, 'cycle'],
  ['forward loop', (flow) => { flow.edges.push({ from: 'build', to: 'build', kind: 'loop', on: 'failed', maxRounds: 2 }) }, 'loop'],
  ['missing input', (flow) => { if (flow.blocks[0]!.kind === 'agent') flow.blocks[0]!.prompt = '{{inputs.absent}}' }, 'template-reference'],
  ['missing output', (flow) => { if (flow.blocks[0]!.kind === 'agent') flow.blocks[0]!.prompt = '{{blocks.missing.output}}' }, 'template-reference'],
  ['escaping path', (flow) => { if (flow.blocks[0]!.kind === 'agent') flow.blocks[0]!.scope.read = ['../outside'] }, 'scope-path'],
  ['read-only writes', (flow) => { if (flow.blocks[0]!.kind === 'agent') flow.blocks[0]!.scope.write = ['.'] }, 'scope-mode'],
  ['invalid default', (flow) => { flow.inputs[0]!.default = 2 }, 'input-default'],
]
describe('validation diagnostics', () => {
  it.each(bad)('%s', (_name, mutate, code) => {
    const flow = recipe('/workspace')
    mutate(flow)
    expect(validateFlow(flow).items).toContainEqual(expect.objectContaining({ code, level: 'error' }))
  })
  it('rejects untyped JSON', () => { expect(validateFlow({}).items[0]?.code).toBe('schema') })
})
describe('preflight diagnostics', () => {
  it('accepts existing reads and creatable writes', async () => {
    const flow = recipe(await temp())
    const block = flow.blocks[0]!
    if (block.kind !== 'agent') throw new Error('fixture')
    block.scope.write = ['new/note.md']; block.scope.sandbox = 'workspace-write'
    expect((await preflight(flow, {}, fakeEnvironment())).ok).toBe(true)
  })
  it.each(['inputs', 'cwd', 'checks-command', 'checks-executor', 'prompt-size', 'model', 'harness', 'scope-access', 'agent-count'])('blocks %s before launch', async (code) => {
    const cwd = await temp()
    const flow = recipe(cwd)
    const block = flow.blocks[0]!
    if (block.kind !== 'agent') throw new Error('fixture')
    const environment = fakeEnvironment()
    let inputs = {}
    switch (code) {
      case 'inputs': inputs = { undeclared: true }; break
      case 'cwd': block.scope.cwd = join(cwd, 'missing'); break
      case 'checks-command': flow.blocks = [{ kind: 'checks', id: 'check', label: 'Check', cwd, commands: [' '] }]; break
      case 'checks-executor':
        flow.blocks = [{ kind: 'checks', id: 'check', label: 'Check', cwd, commands: ['true'] }]
        environment.checkChecks = () => { throw new Error('Missing executor') }
        break
      case 'prompt-size': block.prompt = '€'.repeat(21846); break
      case 'model': environment.checkAgent = async () => { throw new Error('Unknown model') }; break
      case 'harness': block.harness = 'codex'; environment.checkAgent = async () => { throw new Error('Unavailable codex') }; break
      case 'scope-access': block.scope.read = ['missing']; break
      case 'agent-count': block.copies = 65; break
    }
    const result = await preflight(flow, inputs, environment)
    expect(result.ok).toBe(false)
    expect(result.items).toContainEqual(expect.objectContaining({ code, level: 'error' }))
  })
  it('rejects symlink escapes through existing or missing leaves', async () => {
    const cwd = await temp(); const outside = await temp()
    await writeFile(join(outside, 'secret'), 'not read')
    await symlink(outside, join(cwd, 'escape'), 'junction')
    const flow = recipe(cwd); const block = flow.blocks[0]!
    if (block.kind !== 'agent') throw new Error('fixture')
    block.scope.read = ['escape/secret']; block.scope.write = ['escape/new']; block.scope.sandbox = 'workspace-write'
    expect((await preflight(flow, {}, fakeEnvironment())).items.filter(item => item.code === 'scope-access')).toHaveLength(2)
  })
  it('accepts exactly 64 KiB and warns about native scope', async () => {
    const flow = recipe(await temp()); const block = flow.blocks[0]!
    if (block.kind !== 'agent') throw new Error('fixture')
    block.prompt = 'x'.repeat(65536); block.harness = 'codex'
    const result = await preflight(flow, {}, fakeEnvironment())
    expect(result.ok).toBe(true)
    expect(result.items.some(item => item.code === 'native-scope')).toBe(true)
  })
})
