/** JSON and durable-file validation for automation configuration and firing journals. */
import { z } from 'zod'
import { inputsSchema, runIdSchema } from './recipe.ts'
import { parseCron } from './cron.ts'
import type { AutomationId, AutomationRecord, FlowId } from './types.ts'

/** Automation identity accepted at Remote and file reads. */
export const automationIdSchema = z.string().min(1).max(200).transform(id => id as AutomationId)
const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }).strict(),
  z.object({ kind: z.literal('cron'), expr: z.string().max(200), tz: z.string().min(1).max(100) }).strict(),
]).superRefine((schedule, ctx) => {
  if (schedule.kind !== 'cron') return
  try { parseCron(schedule.expr, schedule.tz) } catch (error) { ctx.addIssue({ code: 'custom', message: String(error) }) }
})
/** Browser-authored fields; Host-owned timestamps are rejected. */
export const automationDraftSchema = z.object({
  id: automationIdSchema.optional(), name: z.string().trim().min(1).max(200),
  flowId: z.string().min(1).transform(id => id as FlowId), inputs: inputsSchema,
  schedule: scheduleSchema, enabled: z.boolean(),
}).strict()
/** Persisted automation with a durable journal, including pre-launch reservations. */
export const automationRecordSchema = z.object({
  automation: automationDraftSchema.extend({
    id: automationIdSchema, createdAt: z.iso.datetime(), lastFiredAt: z.iso.datetime().nullable(),
  }),
  events: z.array(z.object({ id: runIdSchema, at: z.iso.datetime(), state: z.enum(['pending', 'started', 'skipped', 'failed']), error: z.string().optional() }).strict()),
}).strict().transform(record => record as AutomationRecord)
