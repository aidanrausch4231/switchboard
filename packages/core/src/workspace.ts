/** Canonical workspace admission and per-launch checks of the original path bindings. */
import { realpath } from 'node:fs/promises'
import { canonicalPath } from './files.ts'
import { inside, resolveWorkspace } from './recipe.ts'
import type { Block, Flow, InputValue } from './types.ts'

/** Bind working directories to the canonical workspace and retain a launch-time verifier.
 * @param flow - validated recipe, or a run's pinned recipe on recovery.
 * @param inputs - resolved primitive inputs.
 * @param workspace - explicit card workspace, otherwise the recipe's declared path input.
 * @returns canonical recipe and inputs, plus a verifier that rejects changed path targets.
 */
export async function bindWorkspace(flow: Flow, inputs: Record<string, InputValue>, workspace: InputValue | undefined = flow.inputs.some(input => input.name === 'workspace' && input.type === 'path') ? inputs.workspace : undefined): Promise<{
  flow: Flow
  inputs: Record<string, InputValue>
  check(block: Block): Promise<void>
}> {
  const resolved = resolveWorkspace(flow, inputs)
  if (typeof workspace !== 'string') return { flow: resolved, inputs, async check(_block: Block) {} }
  const root = await realpath(workspace)
  const directories = new Map<string, string>()
  const bound = structuredClone(resolved)
  for (const block of bound.blocks) {
    if (block.kind === 'gate') continue
    const cwd = block.kind === 'agent' ? block.scope.cwd : block.cwd
    const target = await canonicalPath(cwd)
    if (!inside(root, target)) throw new Error(`cwd escapes workspace: ${cwd}`)
    directories.set(block.id, cwd)
    if (block.kind === 'agent') block.scope.cwd = target
    else block.cwd = target
  }
  return { flow: bound, inputs: { ...inputs, workspace: root }, async check(block: Block): Promise<void> {
    if (block.kind === 'gate') return
    const source = directories.get(block.id)
    const expected = block.kind === 'agent' ? block.scope.cwd : block.cwd
    if (!source || await realpath(workspace) !== root || await realpath(root) !== root
      || await canonicalPath(source) !== expected || await canonicalPath(expected) !== expected
      || !inside(root, expected)) throw new Error(`Workspace cwd changed before launch: ${block.id}`)
  } }
}
