/** Validation and independent version-one storage for Graphs and inbox cards. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { defineDomain, domainTable } from './dsh.ts'
import type { Card, CardId, Graph, GraphId } from './graph-types.ts'
import { flowSchema } from './recipe.ts'

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).refine(value => !['you', 'council', '__proto__', 'constructor', 'prototype'].includes(value))
/** Validated graph id, excluding reserved routing targets. */
export const graphIdSchema = id.transform(value => value as GraphId)
/** Validated card id. */
export const cardIdSchema = id.transform(value => value as CardId)
/** Routing targets accepted at the wire. */
export const targetSchema = z.union([z.literal('you'), z.literal('council'), graphIdSchema])
const text = z.string().min(1).max(32768)
const directory = z.string().min(1).refine(value => isAbsolute(value) && !value.split(/[/\\]+/).includes('..'), 'Use an absolute path without parent traversal')
/** Strict model response; unknown graph targets are handled by the router. */
export const routeResponseSchema = z.strictObject({
  target: z.string().min(1), confidence: z.number().min(0).max(1), reason: z.string().min(1).max(2048),
})
/** Wire card input; workspace is optional for routing and mandatory for node dispatch. */
export const cardInputSchema = z.strictObject({
  title: z.string().min(1).max(200), body: z.string().max(32768),
  source: z.enum(['chat', 'voice', 'manual', 'failed-run', 'webhook']), workspace: directory.optional(),
})
/** Saved graph parser reuses the Flow agent-block parser. */
export const graphSchema = z.strictObject({
  id: graphIdSchema, name: z.string().min(1).max(100), description: z.string().min(1).max(500),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  lead: z.strictObject({ harness: z.enum(['dsh', 'claude-code']), provider: z.string().min(1).optional(), model: z.string().min(1).optional(), memoryDir: directory, instructions: text }),
  nodes: z.array(z.discriminatedUnion('kind', [
    z.strictObject({
      id, description: text, kind: z.literal('flow'), flowId: z.string().transform(value => value as import('./types.ts').FlowId),
    }),
    z.strictObject({ id, description: text, kind: z.literal('agent'), agent: z.unknown().transform((value, ctx) => {
      const parsed = flowSchema.safeParse({ id: 'node', name: 'Node', version: 1, inputs: [], blocks: [value], edges: [], limits: {} })
      const block = parsed.success ? parsed.data.blocks[0] : undefined
      if (!block || block.kind !== 'agent') { ctx.addIssue({ code: 'custom', message: 'Expected a Flow agent block' }); return z.NEVER }
      return block
    }) }),
  ])).max(64),
  edges: z.array(graphIdSchema).max(64),
  rules: z.strictObject({ maxCostTokens: z.number().int().positive(), prodWrites: z.literal('never') }),
}).refine(graph => new Set(graph.nodes.map(node => node.id)).size === graph.nodes.length && new Set(graph.edges).size === graph.edges.length, 'Node ids and edges must be unique').transform(value => value as Graph)
const cardSchema = cardInputSchema.extend({
  id: cardIdSchema, state: z.enum(['new', 'routing', 'running', 'needs-you', 'done', 'failed']),
  route: z.strictObject({ target: targetSchema, confidence: z.number().min(0).max(1), reason: text, router: z.enum(['jev', 'fallback', 'rule']) }).optional(),
  hops: z.number().int().nonnegative(), costTokens: z.number().nonnegative(), usageUnavailable: z.boolean().optional(),
  maxCostTokens: z.number().int().positive(),
  timeline: z.array(z.strictObject({ at: z.string(), actor: z.string(), kind: z.string(), text: z.string() })),
  result: z.string().optional(),
}).transform(value => value as Card)
/** Independent storage avoids changing the released Flows domain version. */
export const graphsDomain = defineDomain({ name: 'switchboard_graphs', version: 1, tables: { graphs: domainTable<GraphId, Graph>(graphSchema), cards: domainTable<CardId, Card>(cardSchema) } })
