/** Launch admission shared by Remote previews and the executor. */
import { stat } from 'node:fs/promises'
import type { AgentBlock, Flow, InputValue, PreflightResult } from './types.ts'
import { checkPath } from './files.ts'
import { renderPrompt, resolveInputs, validateFlow } from './recipe.ts'
import { bindWorkspace } from './workspace.ts'

/** Environment-dependent launch checks supplied by the Host composition. */
export interface PreflightEnvironment {
  /** Maximum estimated agent launches for a recipe. */
  maxAgents: number
  /** Check the selected harness and model without launching an agent. */
  checkAgent(block: AgentBlock): Promise<void>
  /** Require a command executor for checks. */
  checkChecks(): void
}

/** Check a recipe before any agent or check command starts.
 * @param flow - candidate recipe.
 * @param supplied - supplied primitive inputs.
 * @param environment - current composition capabilities.
 * @returns launch diagnostics; later output expansion is checked again before each launch.
 */
export async function preflight(
  flow: Flow, supplied: Record<string, InputValue>, environment: PreflightEnvironment,
): Promise<PreflightResult> {
  const result = validateFlow(flow)
  if (!result.ok) return result
  const add = (code: string, message: string, blockId?: string): void => { result.items.push({ level: 'error', code, message, ...(blockId === undefined ? {} : { blockId }) }) }
  let inputs: Record<string, InputValue> = {}
  try {
    const binding = await bindWorkspace(flow, resolveInputs(flow, supplied))
    inputs = binding.inputs; flow = binding.flow
  } catch (error) { add('inputs', String(error)); return { ...result, ok: false } }
  const resolved = validateFlow(flow)
  if (!resolved.ok) return resolved
  // Multiplication is deliberately conservative for nested and overlapping loops.
  const rounds = flow.edges.filter(edge => edge.kind === 'loop').reduce((sum, edge) => sum * (1 + (edge.maxRounds ?? 0)), 1)
  const agents = flow.blocks.reduce((sum, block) => sum + (block.kind === 'agent' ? block.copies ?? 1 : 0), 0) * rounds
  if (agents > environment.maxAgents || agents > (flow.limits.maxHops ?? Infinity)) add('agent-count', `Estimated ${agents} agents exceeds the configured launch limit`)
  for (const block of flow.blocks) {
    if (block.kind === 'gate') continue
    const cwd = block.kind === 'agent' ? block.scope.cwd : block.cwd
    try { if (!(await stat(cwd)).isDirectory()) throw new Error('Not a directory') } catch (error) { add('cwd', `${cwd}: ${String(error)}`, block.id); continue }
    if (block.kind === 'checks') {
      try { environment.checkChecks() } catch (error) { add('checks-executor', String(error), block.id) }
      if (!block.commands.length || block.commands.some(command => !command.trim())) add('checks-command', 'Checks require non-empty commands', block.id)
      continue
    }
    if (Buffer.byteLength(renderPrompt(block.prompt, inputs, {}), 'utf8') > 65_536) add('prompt-size', 'Rendered prompt exceeds 64 KiB', block.id)
    try { await environment.checkAgent(block) } catch (error) {
      const code = block.harness === 'dsh' ? 'model' : 'harness'
      add(code, String(error), block.id)
    }
    for (const [paths, writable] of [[block.scope.read, false], [block.scope.write, true]] as const) {
      for (const path of paths) {
        try { await checkPath(cwd, path, writable) } catch (error) { add('scope-access', String(error), block.id) }
      }
    }
    if (block.harness !== 'dsh') result.items.push({ level: 'warn', code: 'native-scope', message: 'Native model, permissions and tool access come from the named provider configuration; only cwd and post-run write auditing are applied here. Usage is unavailable.', blockId: block.id })
  }
  result.ok = !result.items.some(item => item.level === 'error')
  if (result.ok) result.items.push({ level: 'ok', code: 'ready', message: `Ready; at most ${agents} estimated agent launches` })
  return result
}
