/** Fold durable block attempts into automation outcome charts. */
import { orderBlocks } from './recipe.ts'
import type { AutomationCell, AutomationRecord, AutomationStats, Flow, FlowRun } from './types.ts'

/** Build newest-first rows from the firing journal and captured run recipes.
 * @param record - automation with firing history.
 * @param runs - all associated durable runs.
 * @param flow - current saved recipe, if it still exists.
 * @param limit - validated maximum row count.
 * @param now - observation time for active-run durations.
 * @returns aligned chart rows; historical-only blocks follow the current flow order.
 */
export function automationStats(
  record: AutomationRecord, runs: FlowRun[], flow: Flow | undefined, limit: number, now: number,
): AutomationStats {
  const events = record.events.slice(-limit).reverse()
  const byId = new Map(runs.map(run => [run.id, run]))
  const blocks = flow ? orderBlocks(flow) : []
  for (const event of events) {
    const run = byId.get(event.id)
    if (run) for (const id of orderBlocks(run.flow)) if (!blocks.includes(id)) blocks.push(id)
  }
  const grid: AutomationCell[][] = []
  const rows = events.map((event) => {
    const run = byId.get(event.id)
    if (!run) {
      grid.push(blocks.map(() => 'unreached'))
      return { id: event.id, state: event.state === 'skipped' ? 'skipped' as const : event.state === 'pending' ? 'pending' as const : 'failed' as const, startedAt: event.at, ms: 0 }
    }
    const row: AutomationCell[] = blocks.map((id) => {
      const attempts = run.attempts.filter(attempt => attempt.blockId === id)
      if (!attempts.length) return 'unreached'
      const round = Math.max(...attempts.map(attempt => attempt.round))
      const latest = attempts.filter(attempt => attempt.round === round)
      if (latest.some(attempt => attempt.state === 'failed')) return 'failed'
      if (latest.some(attempt => attempt.state === 'needs-you')) return 'needs-you'
      if (latest.some(attempt => attempt.state === 'running' || attempt.state === 'queued')) return 'running'
      if (latest.some(attempt => attempt.state === 'cancelled')) return 'cancelled'
      return attempts.some(attempt => attempt.round < round && (attempt.state === 'failed' || attempt.refuted)) ? 'recovered' : 'succeeded'
    })
    const stoppedAtBlock = ['failed', 'cancelled', 'needs-you'].includes(run.state) ? orderBlocks(run.flow)[run.cursor] : undefined
    if (stoppedAtBlock && run.state === 'failed') row[blocks.indexOf(stoppedAtBlock)] = 'failed'
    grid.push(row)
    const end = ['queued', 'running', 'needs-you'].includes(run.state) ? now : Date.parse(run.updatedAt)
    return {
      id: run.id, state: run.state, startedAt: run.createdAt, ms: Math.max(0, end - Date.parse(run.createdAt)),
      ...(stoppedAtBlock ? { stoppedAtBlock } : {}),
    }
  })
  return { runs: rows, blocks, grid }
}
