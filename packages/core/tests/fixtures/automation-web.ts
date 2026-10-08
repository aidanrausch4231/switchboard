/** Opt-in local browser fixture: real Flow execution with scripted model responses. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Context } from '../../src/dsh.ts'
import type {} from '../../src/index.ts'

import { MockAdapter, textResponse, maxTokensResponse } from './mock-adapter.ts'
import { exampleFlows } from '../../src/examples.ts'
import type { FlowId } from '../../src/types.ts'

export const name = 'automation-web-fixture'
export const inject = ['switchboard', 'llm']

export async function apply(ctx: Context): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'switchboard-automation-web-'))
  await mkdir(join(cwd, 'notes'))
  ctx.effect(() => () => rm(cwd, { recursive: true, force: true }))
  const responses = Array.from({ length: 40 }, (_, index) => index === 10
    ? maxTokensResponse('Scripted token limit')
    : textResponse('APPROVED: scripted research result'))
  ctx.effect(() => ctx.llm.registerAdapter(['automation-fixture'], new MockAdapter(responses)))
  const flow = structuredClone(exampleFlows[1]!)
  flow.id = 'automation-example-company-research' as FlowId
  flow.name = 'Company research · scripted example'
  // This fixture binds every scope to its own temporary cwd instead of asking the browser for a workspace.
  flow.inputs = flow.inputs.filter(input => input.name !== 'workspace')
  flow.blocks = flow.blocks.map((block) => {
    if (block.kind === 'agent') { block.provider = 'automation-fixture'; block.model = 'scripted'; block.scope.cwd = cwd }
    // This browser fixture uses model review instead of a shell check; it needs no native sandbox backend.
    if (block.kind === 'checks') return {
      id: block.id, kind: 'agent', label: 'Review summary', harness: 'dsh', provider: 'automation-fixture', model: 'scripted',
      prompt: 'Review the summary: {{blocks.merge.output}}',
      scope: { cwd, read: ['.'], write: [], commands: [], web: false, sandbox: 'read-only' },
    }
    return block
  })
  await ctx.switchboard.saveFlow(flow)
}
