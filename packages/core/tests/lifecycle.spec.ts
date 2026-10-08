import { expect, it, vi } from 'vitest'
import { FlowEngine } from '../src/engine.ts'
import { outputTail } from '../src/runtime.ts'
import { renderPrompt } from '../src/recipe.ts'
import { engineHarness, fakeEnvironment, recipe } from './helpers.ts'

it('keeps a human checkpoint durable across orderly Host disposal', async () => {
  const { engine, domain, cwd } = await engineHarness()
  const flow = recipe(cwd)
  flow.blocks = [{ kind: 'gate', id: 'gate', label: 'Gate' }]
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  await vi.waitFor(() => { expect(engine.getRun(run.id).state).toBe('needs-you') })
  await engine.dispose()
  expect(engine.getRun(run.id).state).toBe('needs-you')
  const resumed = new FlowEngine(domain, fakeEnvironment())
  try {
    await resumed.recover()
    resumed.approveGate(run.id, 'gate', true)
    await vi.waitFor(() => { expect(resumed.getRun(run.id).state).toBe('succeeded') })
  } finally { await resumed.dispose() }
})
it('rechecks fully rendered prompts before each later agent launch', async () => {
  const launched = vi.fn(async () => ({ output: 'x'.repeat(32768) }))
  const { engine, cwd } = await engineHarness(fakeEnvironment({ runAgent: launched }))
  const flow = recipe(cwd)
  const first = flow.blocks[0]!
  if (first.kind !== 'agent') throw new Error('fixture')
  flow.blocks.push({ ...first, id: 'later', prompt: '{{blocks.build.output}}{{blocks.build.output}}x' })
  flow.edges.push({ from: 'build', to: 'later', kind: 'next' })
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  await vi.waitFor(() => { expect(engine.getRun(run.id).state).toBe('failed') })
  expect(engine.getRun(run.id).error).toContain('64 KiB')
  expect(launched).toHaveBeenCalledTimes(1)
})
it('retains review feedback when a loop repeats an earlier build', async () => {
  const prompts: string[] = []
  let reviews = 0
  const { engine, cwd } = await engineHarness(fakeEnvironment({ async runAgent(block, prompt) {
    prompts.push(prompt)
    return { output: block.id === 'review' && reviews++ === 0 ? 'REFUTED: add a regression' : 'APPROVED' }
  } }))
  const flow = recipe(cwd)
  const build = flow.blocks[0]!
  if (build.kind !== 'agent') throw new Error('fixture')
  build.prompt = 'Previous review: {{blocks.review.output}}'
  flow.blocks.push({ ...build, id: 'review', prompt: 'Review' })
  flow.edges.push({ from: 'build', to: 'review', kind: 'next' }, { from: 'review', to: 'build', kind: 'loop', on: 'refuted', maxRounds: 2 })
  await engine.saveFlow(flow)
  const run = await engine.start(flow.id, {})
  await vi.waitFor(() => { expect(engine.getRun(run.id).state).toBe('succeeded') })
  expect(prompts).toEqual(['Previous review: ', 'Review', 'Previous review: REFUTED: add a regression', 'Review'])
})
it('bounds UTF-8 output and never resolves inherited template properties', () => {
  const output = outputTail('€'.repeat(100), 32)
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(32)
  expect(output).toMatch(/^\[truncated\]/)
  expect(output).not.toContain('�')
  expect(renderPrompt('{{inputs.toString}}/{{blocks.toString.output}}', {}, {})).toBe('/')
})
