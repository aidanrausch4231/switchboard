/** Council configuration, durable results, and Remote stream items. */
import { type Branded } from './dsh.ts'
import { type TokenUsage } from './dsh.ts'

/** Durable Council identity; also identifies its request Session log. */
export type CouncilSessionId = string & Branded<'CouncilSessionId'>
/** Deployment-owned seat identity. */
export type SeatId = string & Branded<'CouncilSeatId'>
/** Independent answers, anonymized debate, or answer selection. */
export type CouncilMode = 'quick' | 'debate' | 'vote'
/** One configured model route or named native provider instance. */
export interface Seat {
  /** Stable deployment-owned seat id. */
  id: SeatId
  /** Operator-visible name; removed from peer answers. */
  label: string
  /** Tool-less model route or verified native delegation. */
  kind: 'llm' | 'subagent'
  /** LLM route or configured native provider instance name. */
  provider?: string | undefined
  /** Required LLM model id; native model choice belongs to its provider instance. */
  model?: string | undefined
  /** Native implementation; Codex remains unavailable until it enforces read-only execution. */
  subagent?: 'claude-code' | 'codex' | undefined
  /** Participation preference, subject to live availability checks. */
  enabled: boolean
}
/** Availability is registration/configuration evidence, not a credential or network probe. */
export interface SeatAvailability extends Seat {
  available: boolean
  reason?: string | undefined
}
/** Request admitted by the Council; omitted seatIds selects available enabled seats. */
export interface CouncilAsk {
  question: string
  mode: CouncilMode
  rounds?: number | undefined
  seatIds?: SeatId[]
}
/** One completed or failed seat call. Missing token accounting is null. */
export interface CouncilAnswer {
  seatId: SeatId
  text: string
  state: 'answered' | 'failed'
  usage: TokenUsage | null
  ms: number
  error?: string | undefined
}
/** One barrier of concurrent answers. */
export interface CouncilRound {
  round: number
  answers: CouncilAnswer[]
}
/** Validated choice of an anonymized final answer. */
export interface CouncilVote {
  seatId: SeatId
  choice: string | null
  reason: string
  usage: TokenUsage | null
}
/** Chair synthesis; null confidence means both strict-JSON attempts failed. */
export interface CouncilRuling {
  ruling: string
  dissent: { seat: string; point: string }[]
  confidence: number | null
}
/** Persistent Council result, including the exact configuration selected at admission. */
export interface CouncilSession {
  id: CouncilSessionId
  question: string
  mode: CouncilMode
  seats: Seat[]
  chair: SeatId
  roundCount: number
  rounds: CouncilRound[]
  votes?: CouncilVote[] | undefined
  tally?: Record<string, number> | undefined
  ruling?: CouncilRuling | undefined
  chairAnswers?: CouncilAnswer[] | undefined
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  error?: string | undefined
  createdAt: string
}
/** Snapshot first, then post-durability notifications; terminal state closes the stream. */
export type CouncilEvent =
  | { type: 'snapshot'; session: CouncilSession }
  | { type: 'seat-started'; round: number; seatId: SeatId }
  | { type: 'seat-answered' | 'seat-failed'; round: number; answer: CouncilAnswer }
  | { type: 'round-done'; round: number }
  | { type: 'ruling'; ruling: CouncilRuling }
  | { type: 'state'; state: CouncilSession['state']; error?: string | undefined }

/** Exact one-shot model inputs and outcomes are retained in Council storage. */
export interface CouncilCallRequest {
  seat: Seat
  prompt: string
  phase: string
}

/** Ordered, durable call diary keyed by the owning Council session. */
export type CouncilCallRecord =
  | { type: 'request'; data: CouncilCallRequest }
  | { type: 'answer'; data: CouncilAnswer }
