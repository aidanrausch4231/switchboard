/** Switchboard's authoritative, versioned recipe and run domain. */
import { z } from 'zod'
import { type SessionId } from './dsh.ts'
import { defineDomain, domainTable } from './dsh.ts'
import type { AutomationId, AutomationRecord, Flow, FlowId, FlowRun, RunId } from './types.ts'
import type { CardId, RouterRecord } from './graph-types.ts'
import { automationRecordSchema } from './automation-schema.ts'
import { flowSchema, inputsSchema, runIdSchema, validateFlow } from './recipe.ts'

const state = z.enum(['queued', 'running', 'needs-you', 'succeeded', 'failed', 'cancelled'])
const count = z.number().nonnegative()
const savedFlow = flowSchema.refine(flow => validateFlow(flow).ok, 'Invalid saved recipe')
/** Stored run parser; rejects corrupt records rather than replaying unvalidated work. */
export const runSchema = z.object({
  id: runIdSchema, flowId: z.string().transform(id => id as FlowId), flow: savedFlow,
  inputs: inputsSchema, state, createdAt: z.string(), updatedAt: z.string(), cursor: z.number().int().nonnegative(),
  rounds: z.record(z.string(), z.number().int().nonnegative()),
  outputs: z.record(z.string(), z.string()), tokens: count, error: z.string().optional(), cancelRequested: z.boolean().optional(),
  attempts: z.array(z.object({
    blockId: z.string(), copy: count, round: count, state, startedAt: z.string(), endedAt: z.string().optional(),
    output: z.string(), sessionId: z.string().transform(id => id as SessionId).optional(),
    error: z.string().optional(), refuted: z.boolean().optional(),
    usage: z.object({
      inputTokens: count, outputTokens: count, totalTokens: count.optional(), cacheReadTokens: count.optional(),
      cacheWriteTokens: count.optional(), reasoningTokens: count.optional(),
    }).optional(),
  })),
  timeline: z.array(z.object({ at: z.string(), state, blockId: z.string().optional(), message: z.string() })),
}).transform(run => run as FlowRun)
/** Additive tables keep version one readable; existing recipes and runs are unchanged. */
export const switchboardDomain = defineDomain({ name: 'switchboard', version: 1, tables: {
  flows: domainTable<FlowId, Flow>(savedFlow), runs: domainTable<RunId, FlowRun>(runSchema),
  automations: domainTable<AutomationId, AutomationRecord>(automationRecordSchema),
  router_calls: domainTable<string, RouterRecord>(z.object({
    request: z.object({ provider: z.string(), model: z.string(), prompt: z.string(), cardId: z.string().transform(id => id as CardId).optional() }),
    answer: z.object({ text: z.string(), tokens: count, error: z.string().optional() }).optional(),
  }).transform(record => record as RouterRecord)),
} })
