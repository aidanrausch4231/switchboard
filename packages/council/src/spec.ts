/** Validates configuration, Remote input, model JSON, and durable Council records. */
import { z } from 'zod'
import { type TokenUsage } from './dsh.ts'
import { brandString } from './dsh.ts'
import { defineDomain, domainTable } from './dsh.ts'
import { MAX_TIMER_DELAY_MS } from './dsh.ts'
import type { CouncilCallRecord, CouncilSession, CouncilSessionId, Seat, SeatId } from './types.ts'
import type { Config } from './index.ts'

const seatId = z.string().min(1).transform(value => brandString<SeatId>(value))
const seat = z.object({
  id: seatId, label: z.string().min(1), kind: z.enum(['llm', 'subagent']),
  provider: z.string().min(1).optional(), model: z.string().min(1).optional(),
  subagent: z.enum(['claude-code', 'codex']).optional(), enabled: z.boolean(),
}).superRefine((value, ctx) => {
  if (value.kind === 'llm' ? !value.provider || !value.model : !value.subagent || !value.provider) {
    ctx.addIssue({ code: 'custom', message: 'llm seats require provider/model; subagent seats require subagent/provider instance' })
  }
})
const usage = z.object({
  inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative().optional(), cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(), reasoningTokens: z.number().nonnegative().optional(),
}).transform(value => value as TokenUsage).nullable()
const answer = z.object({
  seatId, text: z.string(), state: z.enum(['answered', 'failed']), usage,
  ms: z.number().nonnegative(), error: z.string().optional(),
})
/** Strict chair output: identities are additionally checked against the anonymous seat labels. */
export const rulingSchema = z.strictObject({
  ruling: z.string().min(1), dissent: z.array(z.strictObject({ seat: z.string(), point: z.string().min(1) })),
  confidence: z.number().min(0).max(1),
})
/** Strict vote output; choices must also name a surviving anonymous answer. */
export const voteSchema = z.strictObject({ choice: z.string(), reason: z.string().min(1).regex(/^[^\r\n]+$/) })
/** Input validation also covers direct same-process callers at the Remote entrypoint. */
export const askSchema = z.strictObject({
  question: z.string().trim().min(1), mode: z.enum(['quick', 'debate', 'vote']),
  rounds: z.number().int().min(2).max(3).optional(), seatIds: z.array(seatId).min(2).optional(),
}).refine(value => value.rounds === undefined || value.mode === 'debate', 'rounds applies only to debate')

const record = z.object({
  id: z.string().min(1).transform(value => brandString<CouncilSessionId>(value)),
  question: z.string(), mode: z.enum(['quick', 'debate', 'vote']), seats: z.array(seat), chair: seatId,
  roundCount: z.number().int().min(1).max(3),
  rounds: z.array(z.object({ round: z.number().int().positive(), answers: z.array(answer) })),
  votes: z.array(z.object({ seatId, choice: z.string().nullable(), reason: z.string(), usage })).optional(),
  tally: z.record(z.string(), z.number().int().nonnegative()).optional(),
  ruling: rulingSchema.extend({ confidence: z.number().min(0).max(1).nullable() }).optional(),
  chairAnswers: z.array(answer).optional(),
  state: z.enum(['queued', 'running', 'done', 'failed', 'cancelled']), error: z.string().optional(), createdAt: z.string(),
})
/** Council data belongs to its own versioned domain, not the derived Session search index. */
export const councilDomain = defineDomain({
  name: 'switchboard_council', version: 1,
  tables: {
    council_sessions: domainTable<CouncilSessionId, CouncilSession>(record),
    calls: domainTable<string, CouncilCallRecord[]>(z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('request'), data: z.object({ seat, prompt: z.string(), phase: z.string() }) }),
      z.object({ type: z.literal('answer'), data: answer }),
    ]))),
  },
})

/**
 * Validate and snapshot Loader configuration, rejecting ambiguous seat identities.
 * @param input - Schemastery-resolved plugin configuration.
 * @returns immutable-by-ownership configuration for this service lifetime.
 */
export function resolveConfig(input: Config): { seats: Seat[]; chair: SeatId; timeoutMs: number } {
  const config = z.object({
    seats: z.array(seat).min(2), chair: seatId, timeoutMs: z.number().positive().max(MAX_TIMER_DELAY_MS),
  }).parse(input)
  if (new Set(config.seats.map(value => value.id)).size !== config.seats.length) throw new Error('Council seat ids must be unique')
  if (!config.seats.some(value => value.id === config.chair && value.enabled)) throw new Error('Council chair must name an enabled seat')
  return config
}
