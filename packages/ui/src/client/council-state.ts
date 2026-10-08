/** Incremental Council projection; snapshots remain authoritative on reconnect. */
import { assertNever } from './dsh.ts'
import type { CouncilEvent, CouncilSession, SeatId } from '@switchboard/council/types'

/** Active answer calls are transient and are not included in durable snapshots. */
export interface ChamberState {
  session: CouncilSession
  thinking: { round: number; seatId: SeatId }[]
}

/**
 * Fold a committed event without mutating earlier rounds.
 * @param current - previous projection, absent before the first snapshot.
 * @param event - ordered Council event.
 * @returns next projection, or undefined until a snapshot arrives.
 */
export function councilEvent(current: ChamberState | undefined, event: CouncilEvent): ChamberState | undefined {
  if (event.type === 'snapshot') return { session: event.session, thinking: [] }
  if (!current) return current
  const { session, thinking } = current
  switch (event.type) {
    case 'seat-started':
      return {
        session: session.rounds.some(value => value.round === event.round) ? session
          : { ...session, rounds: [...session.rounds, { round: event.round, answers: [] }] },
        thinking: [...thinking, { round: event.round, seatId: event.seatId }],
      }
    case 'seat-answered':
    case 'seat-failed': {
      const rounds = session.rounds.some(value => value.round === event.round)
        ? session.rounds : [...session.rounds, { round: event.round, answers: [] }]
      return {
        session: { ...session, rounds: rounds.map(value => value.round === event.round
          ? { ...value, answers: [...value.answers.filter(answer => answer.seatId !== event.answer.seatId), event.answer] }
          : value) },
        thinking: thinking.filter(value => value.round !== event.round || value.seatId !== event.answer.seatId),
      }
    }
    case 'round-done': return { session, thinking: thinking.filter(value => value.round !== event.round) }
    case 'ruling': return { ...current, session: { ...session, ruling: event.ruling } }
    case 'state': return {
      session: { ...session, state: event.state, error: event.error },
      thinking: event.state === 'running' || event.state === 'queued' ? thinking : [],
    }
    default: return assertNever(event)
  }
}
