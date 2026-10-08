/** JSON validation, deterministic ordering, and literal template expansion. */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Flow, FlowId, InputValue, PreflightResult, RunId } from './types.ts'

const name = z.string().regex(/^[a-zA-Z0-9_-]+$/).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value))
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const value = z.union([z.string(), z.number(), z.boolean()])
const base = { id: name, label: z.string().min(1) }
const workspaceCwd = /^{{inputs\.workspace}}(?:[/\\]((?![/\\])[^:{}]+))?$/
const inputType = (type: Flow['inputs'][number]['type']): string => type === 'path' ? 'string' : type
/** Runtime recipe parser at Remote and storage entry points. */
export const flowSchema = z.strictObject({
  id: name.transform(id => id as FlowId), name: z.string().min(1), version: positive,
  inputs: z.array(z.strictObject({ name, type: z.enum(['string', 'number', 'boolean', 'path']), required: z.boolean().optional(), default: value.optional() })),
  blocks: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ ...base, kind: z.literal('agent'), harness: z.enum(['dsh', 'claude-code', 'codex']), provider: z.string().min(1).optional(), model: z.string().min(1).optional(), prompt: z.string(), copies: positive.optional(), concurrency: positive.optional(), scope: z.strictObject({ cwd: z.string().min(1), read: z.array(z.string().min(1)), write: z.array(z.string().min(1)), commands: z.array(z.string().min(1)), web: z.boolean(), sandbox: z.enum(['read-only', 'workspace-write']) }) }),
    z.strictObject({ ...base, kind: z.literal('checks'), cwd: z.string().min(1), commands: z.array(z.string()) }),
    z.strictObject({ ...base, kind: z.literal('gate') }),
  ])),
  edges: z.array(z.strictObject({ from: name, to: name, kind: z.enum(['next', 'loop']), on: z.enum(['failed', 'refuted']).optional(), maxRounds: positive.optional() })),
  limits: z.strictObject({
    maxCostTokens: positive.optional(), maxMinutes: z.number().positive().optional(), maxHops: positive.optional(),
  }),
}).transform(flow => flow as Flow)
/** Wire run identity parser. */
export const runIdSchema = name.transform(id => id as RunId)
/** Primitive input dictionary parser. */
export const inputsSchema = z.record(z.string(), value)

/** Check literal containment, rejecting parent traversal before normalization.
 * @param cwd - owning directory.
 * @param path - absolute or relative candidate.
 * @returns whether the candidate stays inside cwd.
 */
export function inside(cwd: string, path: string): boolean {
  if ([cwd, path].some(value => value.split(/[/\\]+/).includes('..'))) return false
  const rel = relative(resolve(cwd), resolve(cwd, path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Order every block stably; throw when ordinary edges contain a cycle.
 * @param flow - parsed recipe.
 * @returns topological block ids.
 */
export function orderBlocks(flow: Flow): string[] {
  const pending = new Set(flow.blocks.map(block => block.id))
  const result: string[] = []
  while (pending.size) {
    const next = [...pending].find(id => !flow.edges.some(edge => edge.kind === 'next' && edge.to === id && pending.has(edge.from)))
    if (next === undefined) throw new Error('Ordinary edges must form a DAG')
    pending.delete(next)
    result.push(next)
  }
  return result
}

/** Validate structural, graph, template, and lexical path rules without I/O.
 * @param candidate - untrusted saved recipe.
 * @returns all detected diagnostics.
 */
export function validateFlow(candidate: unknown): PreflightResult {
  const parsed = flowSchema.safeParse(candidate)
  if (!parsed.success) return { ok: false, items: [{ level: 'error', code: 'schema', message: parsed.error.message }] }
  const flow = parsed.data
  const items: PreflightResult['items'] = []
  const fail = (code: string, message: string, blockId?: string): void => { items.push({ level: 'error', code, message, ...(blockId === undefined ? {} : { blockId }) }) }
  const ids = new Set(flow.blocks.map(block => block.id))
  const inputs = new Set(flow.inputs.map(input => input.name))
  if (!flow.blocks.length) fail('empty-flow', 'At least one block is required')
  if (ids.size !== flow.blocks.length || inputs.size !== flow.inputs.length) fail('duplicate-id', 'Block and input ids must be unique within their lists')
  for (const input of flow.inputs) if (input.default !== undefined && typeof input.default !== inputType(input.type)) fail('input-default', `Input ${input.name} default must be ${input.type}`)
  for (const edge of flow.edges) if (!ids.has(edge.from) || !ids.has(edge.to)) fail('edge-reference', `Unknown edge endpoint: ${edge.from} → ${edge.to}`)
  let order: string[] = []
  try { order = orderBlocks(flow) } catch (error) { fail('cycle', String(error)) }
  for (const edge of flow.edges) {
    if (edge.kind === 'loop' && (!edge.on || !edge.maxRounds || order.indexOf(edge.to) >= order.indexOf(edge.from))) fail('loop', 'Loops require a backward target, condition and positive maxRounds', edge.from)
    if (edge.kind === 'next' && (edge.on !== undefined || edge.maxRounds !== undefined)) fail('loop', 'Only loop edges accept a condition or rounds', edge.from)
  }
  for (const block of flow.blocks) {
    if (block.kind === 'gate') continue
    const cwd = block.kind === 'agent' ? block.scope.cwd : block.cwd
    const binding = workspaceCwd.exec(cwd)
    if (binding) {
      if (!flow.inputs.some(input => input.name === 'workspace' && input.type === 'path' && input.required !== false)) fail('template-reference', 'cwd binding requires a required workspace input of type path', block.id)
      if (binding[1]?.split(/[/\\]+/).includes('..')) fail('scope-path', 'cwd subpath must not contain parent traversal', block.id)
    } else if (cwd.includes('{{') || cwd.includes('}}') || !isAbsolute(cwd) || !inside(cwd, cwd)) fail('scope-path', 'cwd must be absolute without parent traversal, or {{inputs.workspace}} with a relative subpath', block.id)
    if (block.kind !== 'agent') continue
    if ([...block.scope.read, ...block.scope.write].some(path => binding && isAbsolute(path) ? path.split(/[/\\]+/).includes('..') : !inside(cwd, path))) fail('scope-path', 'Scope paths must stay inside cwd', block.id)
    if (block.scope.sandbox === 'read-only' && block.scope.write.length) {
      fail('scope-mode', 'Read-only agents cannot declare writable paths', block.id)
    }
    const residue = block.prompt.replace(/{{\s*(inputs\.([\w-]+)|blocks\.([\w-]+)\.output)\s*}}/g,
      (_match, _ref: string, input: string | undefined, source: string | undefined) => {
        if (input !== undefined && !inputs.has(input)) fail('template-reference', `Unknown input ${input}`, block.id)
        if (source !== undefined && !ids.has(source)) fail('template-reference', `Unknown block ${source}`, block.id)
        return ''
      })
    if (residue.includes('{{') || residue.includes('}}')) fail('template-reference', 'Malformed template reference', block.id)
  }
  return { ok: items.length === 0, items }
}

/** Resolve defaults and reject missing, mistyped, or undeclared inputs.
 * @param flow - validated recipe.
 * @param supplied - run inputs.
 * @returns detached primitive inputs.
 */
export function resolveInputs(flow: Flow, supplied: Record<string, InputValue>): Record<string, InputValue> {
  const result: Record<string, InputValue> = {}
  for (const key of Object.keys(supplied)) if (!flow.inputs.some(input => input.name === key)) throw new Error(`Unknown input ${key}`)
  for (const input of flow.inputs) {
    const selected = Object.hasOwn(supplied, input.name) ? supplied[input.name] : input.default
    if (selected === undefined) { if (input.required !== false) throw new Error(`Missing input ${input.name}`); continue }
    if (typeof selected !== inputType(input.type)) throw new Error(`Input ${input.name} must be ${input.type}`)
    if (input.type === 'path' && (typeof selected !== 'string' || !isAbsolute(selected) || !inside(selected, selected) || /[{}]/.test(selected))) throw new Error(`Input ${input.name} must be an absolute path without parent traversal or templates`)
    result[input.name] = selected
  }
  return result
}

/** Bind cwd once before filesystem admission and capture the resolved recipe for execution.
 * @param flow - structurally validated recipe.
 * @param inputs - resolved primitive inputs.
 * @returns detached recipe with absolute working directories.
 */
export function resolveWorkspace(flow: Flow, inputs: Record<string, InputValue>): Flow {
  const cwd = (value: string): string => {
    const binding = workspaceCwd.exec(value)
    if (!binding) return value
    const workspace = inputs.workspace
    if (typeof workspace !== 'string') throw new Error('Missing input workspace')
    if (!isAbsolute(workspace) || !inside(workspace, workspace) || binding[1]?.split(/[/\\]+/).includes('..')) throw new Error('Workspace cwd must be absolute without parent traversal')
    return resolve(workspace, binding[1] ?? '.')
  }
  return { ...flow, blocks: flow.blocks.map(block => block.kind === 'agent'
    ? { ...block, scope: { ...block.scope, cwd: cwd(block.scope.cwd) } }
    : block.kind === 'checks' ? { ...block, cwd: cwd(block.cwd) } : block) }
}

/** Expand references once; substituted text is never interpreted as a template.
 * @param template - validated block prompt.
 * @param inputs - resolved inputs.
 * @param outputs - latest completed outputs; unavailable outputs expand to empty text.
 * @returns rendered text.
 */
export function renderPrompt(template: string, inputs: Record<string, InputValue>, outputs: Record<string, string>): string {
  return template.replace(/{{\s*(?:inputs\.([\w-]+)|blocks\.([\w-]+)\.output)\s*}}/g,
    (_match, input: string | undefined, block: string | undefined) =>
      input !== undefined
        ? String(Object.hasOwn(inputs, input) ? inputs[input] : '')
        : block !== undefined && Object.hasOwn(outputs, block) ? outputs[block] ?? '' : '')
}
