/** Test-only driver for the recorded headless Flow lifecycle. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { type Context, defineTool, ToolCallId } from '../../src/dsh.ts'
import type {} from '../../src/index.ts'
import type { FlowId } from '../../src/types.ts'

export const name = 'snapshot-switchboard-flow'
export const inject = ['switchboard', 'tools', 'agents']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'snapshot_flow',
    description: 'Run a read-only review of project/input.txt, approve its checkpoint, and return the result.',
    parameters: {},
    output: {
      schema: { type: 'object', properties: { runId: { type: 'string', required: true }, name: { type: 'string', required: true } }, additionalProperties: false },
      render: () => [{ type: 'text', text: 'Seeded examples: 2. Review: APPROVED. Human checkpoint: approved. Run: succeeded.' }],
      presentationMeta: (_args, value) => ({ switchboardRun: value }),
    },
    async execute(_args, toolCtx) {
      const board = ctx.switchboard
      assert.deepEqual(board.listFlows().map(flow => flow.id).sort(), ['company-research', 'fix-bug-with-review'])
      const agent = ctx.agents.requireInitiator()
      const cwd = join(agent.session.header.cwd!, 'project')
      const flow = await board.saveFlow({
        id: 'snapshot-review' as FlowId, name: 'Snapshot review', version: 1, inputs: [{ name: 'workspace', type: 'path', required: true }], limits: {},
        blocks: [
          { id: 'review', kind: 'agent', label: 'Review', harness: 'dsh', provider: 'deepseek-official', model: 'deepseek-v4-flash',
            prompt: 'Read input.txt and reply APPROVED without editing any file.',
            scope: { cwd: '{{inputs.workspace}}', read: ['.'], write: [], commands: [], web: false, sandbox: 'read-only' } },
          { id: 'you', kind: 'gate', label: 'Approve review' },
        ],
        edges: [{ from: 'review', to: 'you', kind: 'next' }],
      })
      const admission = await board.preflightFlow(flow, { workspace: cwd })
      assert.equal(admission.ok, true, JSON.stringify(admission.items))
      const started = await ctx.tools.execute({ callId: ToolCallId('snapshot-start-flow'), signal: toolCtx.signal, name: 'run_flow', arguments: { name: flow.name, inputs: { workspace: cwd } } })
      assert.notEqual(started.isError, true)
      const run = board.listRuns()[0]!
      assert.deepEqual(started.meta, { switchboardRun: { runId: run.id, name: flow.name } })
      let approved = false
      for await (const frame of board.followRuns(run.id, toolCtx.signal)) {
        if (frame.run.state === 'needs-you') {
          assert.equal(board.approveGate(run.id, 'you', true), true)
          approved = true
        }
      }
      const result = board.getRun(run.id)
      assert.equal(approved, true)
      assert.equal(result.state, 'succeeded', result.error)
      const review = result.flow.blocks[0]
      assert.equal(review?.kind === 'agent' ? review.scope.cwd : undefined, cwd)
      assert.equal(result.inputs.workspace, cwd)
      assert.equal(result.attempts[0]?.output, 'APPROVED')
      assert.equal(result.attempts[0]?.state, 'succeeded')
      assert.ok(result.attempts[0]?.sessionId)
      assert.ok(result.tokens > 0)
      return { runId: run.id, name: flow.name }
    },
  })))
}
