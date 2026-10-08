/** Reduce latest gate visits and fan-out rounds for graph progress. */
import type { FlowRun, RunState } from '@switchboard/core/types'

/** Derive the latest visit's state for gates, or the current round's aggregate for other blocks.
 * @param run - durable run snapshot.
 * @param id - block identity.
 * @returns state, attempt count and latest round.
 */
export function blockState(run: FlowRun, id: string): { state: RunState; attempts: number; round: number } {
  const attempts = run.attempts.filter(attempt => attempt.blockId === id)
  const round = Math.max(0, ...attempts.map(attempt => attempt.round))
  const block = run.flow.blocks.find(value => value.id === id)
  // Gates persist round zero on every visit, including in existing run records.
  const current = block?.kind === 'gate' ? attempts.slice(-1) : attempts.filter(attempt => attempt.round === round)
  const copies = block?.kind === 'agent' ? block.copies ?? 1 : 1
  const state = current.some(attempt => attempt.state === 'failed') ? 'failed'
    : current.some(attempt => attempt.state === 'needs-you') ? 'needs-you'
      : current.some(attempt => attempt.state === 'running') ? 'running'
        : current.some(attempt => attempt.state === 'cancelled') ? 'cancelled'
          : current.length === copies && current.every(attempt => attempt.state === 'succeeded') ? 'succeeded' : 'queued'
  return { state, attempts: attempts.length, round }
}
