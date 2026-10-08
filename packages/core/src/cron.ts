/** Calendar evaluation without dependency-owned timers. */
import { Cron } from 'croner'

/** Parse a five-field cron expression in an IANA time zone.
 * @param expr - minute, hour, day, month and weekday fields.
 * @param tz - IANA time zone, never the Host's implicit local zone.
 * @returns paused calendar evaluator; invalid expressions or zones throw.
 */
export function parseCron(expr: string, tz: string): Cron {
  if (expr.trim().split(/\s+/).length !== 5) throw new Error('Cron requires five fields')
  new Intl.DateTimeFormat('en', { timeZone: tz }).format(0)
  return new Cron(expr, { timezone: tz, paused: true })
}

/** Find the first occurrence strictly after a watermark.
 * @param expr - five-field cron expression.
 * @param tz - IANA time zone.
 * @param after - exclusive UTC timestamp.
 * @returns next UTC timestamp, or undefined for an impossible calendar date.
 */
export function nextFire(expr: string, tz: string, after: string): string | undefined {
  return parseCron(expr, tz).nextRun(new Date(after))?.toISOString()
}
