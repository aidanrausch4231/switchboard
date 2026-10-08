/** Optional chat entry into saved recipes, with replayable run identity metadata. */
import { type Context } from './dsh.ts'
import { defineTool } from './dsh.ts'
import { inputsSchema } from './recipe.ts'
import type Switchboard from './index.ts'

/** Register the chat tool only while the tool runtime is available.
 * @param ctx - plugin-owned Host context.
 * @param service - initialized flow service.
 */
export function registerRunTool(ctx: Context, service: Switchboard): void {
  ctx.inject(['tools'], (scope) => {
    scope.tools.register(defineTool({
      name: 'run_flow',
      description: 'Start a saved Flow only when the user asks to run it. Runs may write files and execute commands within the saved scopes. Launch admission is checked before starting. Returns immediately with a run id; human checkpoints are approved in the Flow dock.',
      parameters: {
        name: { type: 'string', required: true, description: 'Exact saved recipe id or unique name from the Flows page.' },
        inputs: { type: 'object', additionalProperties: true, description: 'Declared flow inputs as string, number or boolean values. Omitted inputs use recipe defaults.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { runId: { type: 'string', required: true }, name: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: `Started Flow ${value.name}. Run id: ${value.runId}. Follow progress and approve checkpoints in the Flow dock.` }],
        presentationMeta: (_args, value) => ({ switchboardRun: value }),
      },
      async execute(args) {
        const flows = service.listFlows()
        const exact = flows.find(flow => flow.id === args.name)
        const matches = exact ? [exact] : flows.filter(flow => flow.name === args.name)
        const selected = matches[0]
        if (matches.length !== 1 || !selected) throw new Error('Use an exact saved Flow id or unique name from the Flows page')
        const run = await service.startRun(selected.id, inputsSchema.parse(args.inputs ?? {}))
        return { runId: run.id, name: run.flow.name }
      },
      presentCall: args => ({ card: 'generic', kind: 'other', title: 'Run saved Flow', rawInput: args.name }),
    }))
  })
}
