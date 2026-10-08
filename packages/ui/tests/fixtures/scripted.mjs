/** Test-only adapter and recipe for the real dsh browser smoke; never contacts a provider. */
import { randomUUID } from 'node:crypto'
import { LlmAdapter, createUserMessage } from '../../../core/src/dsh.ts'
import { exampleFlows } from '@switchboard/core'

class ScriptedAdapter extends LlmAdapter {
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  listModels() { return Promise.resolve([{ id: 'scripted', name: 'Scripted UI fixture' }]) }
  async *stream(request) {
    if (request.tools?.some(tool => tool.name === 'run_flow') && !request.messages.some(message => message.role === 'tool')) {
      const block = { type: 'tool-call', id: 'scripted-run-flow', name: 'run_flow', arguments: JSON.stringify({ name: 'Scripted UI preview', inputs: {} }) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = 'APPROVED: scripted browser fixture'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const inject = ['llm', 'switchboard', 'agents', 'agentPresets', 'sessionTitle']
export async function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['switchboard-scripted'], new ScriptedAdapter()))
  const cwd = process.env.SWITCHBOARD_SMOKE_CWD
  if (!cwd) throw new Error('SWITCHBOARD_SMOKE_CWD is required by the test-only fixture')
  const flow = structuredClone(exampleFlows[0])
  flow.id = 'ui-scripted-preview'
  flow.name = 'Scripted UI preview'
  flow.inputs = []
  // The UI smoke exercises graph transitions without spawning a sandboxed shell.
  flow.blocks = flow.blocks.map(block => block.kind === 'checks' ? {
    id: block.id, label: block.label, kind: 'agent', harness: 'dsh', prompt: '',
    scope: { cwd, read: [], write: [], commands: [], web: false, sandbox: 'read-only' },
  } : block)
  for (const block of flow.blocks) {
    if (block.kind === 'agent') {
      block.provider = 'switchboard-scripted'; block.model = 'scripted'; block.prompt = 'Return APPROVED.'
      block.scope = { cwd, read: ['.'], write: [], commands: [], web: false, sandbox: 'read-only' }
    }
  }
  for (const run of ctx.switchboard.listRuns()) {
    if (run.flowId === flow.id && ['queued', 'running', 'needs-you'].includes(run.state)) await ctx.switchboard.cancelRun(run.id)
  }
  await ctx.switchboard.saveFlow(flow)
  const preset = await ctx.agentPresets.resolve()
  const lease = await ctx.agentPresets.acquireScope(preset.id)
  try {
    const handle = await ctx.agents.create({
      sessionId: `switchboard-ui-chat-${randomUUID()}`, meta: { cwd, agentPreset: preset.id },
      agentOptions: { provider: 'switchboard-scripted', model: 'scripted' },
      setup: async (scope) => {
        await ctx.agentPresets.mount(scope, preset.id)
        scope.tools.presentAs('native')
        scope.tools.restrict({ allow: ['run_flow'] })
      },
    })
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run Scripted UI preview' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      ctx.sessionTitle.rename(handle.agent.session, process.env.SWITCHBOARD_SMOKE_TITLE ?? 'Switchboard chat fixture')
    } finally { await handle.dispose() }
  } finally { await lease[Symbol.asyncDispose]() }
}
