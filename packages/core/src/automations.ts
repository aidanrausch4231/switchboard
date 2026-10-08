/** Server-owned schedules; firing reservations commit before any Flow side effects. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { type Domain } from './dsh.ts'
import type { FlowEngine } from './engine.ts'
import type { switchboardDomain } from './storage.ts'
import type { Automation, AutomationDraft, AutomationEvent, AutomationId, AutomationRecord, AutomationStats, RunId } from './types.ts'
import { automationDraftSchema, automationIdSchema } from './automation-schema.ts'
import { automationStats } from './automation-stats.ts'
import { nextFire } from './cron.ts'
import { resolveInputs } from './recipe.ts'
import { preflight } from './preflight.ts'

/** Serializes scheduler admission and edits; execution itself remains owned by FlowEngine. */
export class Automations {
  private tail: Promise<unknown> = Promise.resolve()
  private stopping = false
  private ticking: Promise<void> | undefined

  /** @param domain - caller-owned Switchboard storage.
   * @param engine - recovered Flow executor.
   */
  constructor(private readonly domain: Domain<typeof switchboardDomain>, private readonly engine: FlowEngine) {}

  /** Resolve interrupted admission without replaying side effects, then catch up once. */
  async recover(): Promise<void> {
    for (const [id, record] of this.domain.table('automations').entries()) {
      if (id !== record.automation.id) throw new Error(`Automation key mismatch: ${id}`)
      const pending = record.events.filter(event => event.state === 'pending')
      if (!pending.length) continue
      const runs = new Set(this.engine.listRuns().map(run => run.id))
      const lastFiredAt = pending.reduce(
        (at, event) => event.at > at ? event.at : at, record.automation.lastFiredAt ?? record.automation.createdAt,
      )
      await this.domain.table('automations').put(id, {
        automation: { ...record.automation, lastFiredAt }, events: record.events.map(event => event.state === 'pending'
          ? { ...event, state: runs.has(event.id) ? 'started' : 'failed', error: 'Host stopped during admission' } : event),
      })
    }
    await this.tick()
  }

  /** List saved schedules.
   * @returns detached saved schedules.
   */
  list(): Automation[] { return [...this.domain.table('automations').entries()].map(([, row]) => structuredClone(row.automation)) }
  /** Read one saved schedule.
   * @param id - automation identity.
   * @returns detached schedule; unknown identities throw.
   */
  get(id: AutomationId): Automation { return structuredClone(this.record(id).automation) }

  /** Validate inputs against the saved Flow and persist configuration, retaining history.
   * @param candidate - editable fields only.
   * @returns persisted automation; changed timing starts from now, not the paused interval.
   */
  save(candidate: AutomationDraft): Promise<Automation> {
    const draft = automationDraftSchema.parse(candidate)
    return this.serial(async () => {
      const old = draft.id ? this.record(draft.id) : undefined
      const flow = this.engine.getFlow(draft.flowId)
      if (!flow) throw new Error(`Unknown flow ${draft.flowId}`)
      resolveInputs(flow, draft.inputs)
      const now = new Date().toISOString()
      const timingChanged = old && (
        JSON.stringify(old.automation.schedule) !== JSON.stringify(draft.schedule) || old.automation.enabled !== draft.enabled
      )
      const automation: Automation = {
        ...draft, id: old?.automation.id ?? randomUUID() as AutomationId,
        createdAt: old?.automation.createdAt ?? now, lastFiredAt: timingChanged ? now : old?.automation.lastFiredAt ?? null,
      }
      await this.domain.table('automations').put(automation.id, { automation, events: old?.events ?? [] })
      return structuredClone(automation)
    })
  }

  /** Delete a schedule, retaining Flow runs and never cancelling active work.
   * @param id - automation identity.
   */
  delete(id: AutomationId): Promise<void> {
    return this.serial(async () => { this.record(id); await this.domain.table('automations').delete(id) })
  }

  /** Change future scheduling without cancelling an active run.
   * @param id - automation identity.
   * @param enabled - future timer admission.
   * @returns saved schedule; enabling does not catch up the paused interval.
   */
  setEnabled(id: AutomationId, enabled: boolean): Promise<Automation> {
    z.boolean().parse(enabled)
    return this.serial(async () => {
      const record = this.record(id)
      const automation = {
        ...record.automation, enabled,
        lastFiredAt: record.automation.enabled === enabled ? record.automation.lastFiredAt : new Date().toISOString(),
      }
      await this.domain.table('automations').put(id, { ...record, automation })
      return structuredClone(automation)
    })
  }

  /** Run even a paused/manual schedule; an active predecessor records a skip.
   * @param id - automation identity.
   * @returns durable firing with the reserved Flow run identity, or an admission failure/skip.
   */
  runNow(id: AutomationId): Promise<AutomationEvent> { return this.serial(() => this.fire(id, new Date().toISOString())) }

  /** Summarize the retained firing history.
   * @param id - automation identity.
   * @param limit - row count from 1 through 100; defaults to 20.
   * @returns aligned outcomes, durations and per-block rows.
   */
  stats(id: AutomationId, limit = 20): AutomationStats {
    z.number().int().min(1).max(100).parse(limit)
    const record = this.record(id)
    return automationStats(record, this.engine.listRuns(), this.engine.getFlow(record.automation.flowId), limit, Date.now())
  }

  /** Coalesce overlapping ticks; rejected admission retains the watermark for retry on the next Host poll.
   * @returns settlement after admissions, not after Flow completion.
   */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking
    this.ticking = this.serial(async () => {
      const now = new Date().toISOString()
      for (const automation of this.list()) {
        if (!automation.enabled || automation.schedule.kind !== 'cron') continue
        const next = nextFire(automation.schedule.expr, automation.schedule.tz, automation.lastFiredAt ?? automation.createdAt)
        if (!next || next > now) continue
        const flow = this.engine.getFlow(automation.flowId)
        if (!flow || !(await preflight(flow, automation.inputs, this.engine.environment)).ok) continue
        await this.fire(automation.id, now)
      }
    }).finally(() => { this.ticking = undefined })
    return this.ticking
  }

  /** Reject new admission and drain accepted mutations before closing storage. */
  async dispose(): Promise<void> { this.stopping = true; await this.tail }

  private record(id: AutomationId): AutomationRecord {
    const record = this.domain.table('automations').get(automationIdSchema.parse(id))
    if (!record) throw new Error(`Unknown automation ${id}`)
    return record
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Automations are stopping'))
    // ponytail: one admission queue; partition by automation if preflight throughput becomes limiting.
    const pending = this.tail.then(operation)
    this.tail = pending.catch(() => {})
    return pending
  }

  private async fire(id: AutomationId, at: string): Promise<AutomationEvent> {
    const record = this.record(id)
    const ids = new Set(record.events.map(event => event.id))
    const overlap = this.engine.listRuns().some(run => ids.has(run.id) && ['queued', 'running', 'needs-you'].includes(run.state))
    const event: AutomationEvent = { id: randomUUID() as RunId, at, state: overlap ? 'skipped' : 'pending' }
    const reserved = {
      automation: overlap ? { ...record.automation, lastFiredAt: at } : record.automation, events: [...record.events, event],
    }
    await this.domain.table('automations').put(id, reserved)
    if (overlap) return structuredClone(event)
    let settled: AutomationEvent
    try {
      await this.engine.start(record.automation.flowId, record.automation.inputs, event.id)
      settled = { ...event, state: 'started' }
    } catch (error) { settled = { ...event, state: 'failed', error: String(error) } }
    await this.domain.table('automations').put(id, {
      automation: settled.state === 'started' ? { ...record.automation, lastFiredAt: at } : record.automation,
      events: [...record.events, settled],
    })
    return structuredClone(settled)
  }
}
