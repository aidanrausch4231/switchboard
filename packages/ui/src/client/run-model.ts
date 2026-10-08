/** React-free, reference-counted run streams shared by cards and dock bodies. */
import { createSnapshotStore } from './dsh.ts'
import { type RemoteStream } from './dsh.ts'
import type { FlowRun, RunFrame, RunId } from '@switchboard/core/types'

import type {} from '@switchboard/core/remote'

/** Last durable state plus any observation failure. */
export interface RunView { run?: FlowRun | undefined; error?: string }
/** Owns browser observations, never execution; releasing a viewer cannot cancel a run. */
export class RunModel {
  /** Stable observation source for framework-bound card and dock selectors. */
  readonly source = createSnapshotStore<Record<string, RunView>>({})
  private readonly entries = new Map<RunId, {
    refs: number
    ended: boolean
    generation: number
    close(): Promise<void>
    done: Promise<void>
  }>()
  private readonly closing = new Set<Promise<void>>()
  /** @param open - creates a Gateway-supervised run stream. */
  constructor(private readonly open: (id: RunId) => Pick<RemoteStream<RunFrame>, typeof Symbol.asyncIterator | 'dispose'>) {}

  /** Observe until the returned idempotent release is called.
   * @param id - durable run identity.
   * @returns release callback.
   */
  watch(id: RunId): () => void {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { refs: 0, ended: true, generation: 0, close: async () => {}, done: Promise.resolve() }
      this.entries.set(id, entry)
    }
    if (entry.ended) {
      const stream = this.open(id)
      const owner = entry
      const generation = ++owner.generation
      const previous = owner.done
      owner.ended = false
      owner.close = () => stream.dispose()
      this.source.set({ ...this.source.getSnapshot(), [id]: { run: this.source.getSnapshot()[id]?.run } })
      const observing = (async () => {
        try {
          for await (const item of stream) {
            if (this.entries.get(id) !== owner || owner.generation !== generation) break
            this.source.set({ ...this.source.getSnapshot(), [id]: { run: item.value.run } })
            item.accept()
            if (['succeeded', 'failed', 'cancelled'].includes(item.value.run.state)) break
          }
        } catch (error) {
          if (this.entries.get(id) === owner && owner.generation === generation) {
            this.source.set({ ...this.source.getSnapshot(), [id]: { ...this.source.getSnapshot()[id], error: String(error) } })
          }
        } finally { if (owner.generation === generation) owner.ended = true; await stream.dispose() }
      })()
      owner.done = Promise.all([previous, observing]).then(() => {})
    }
    entry.refs += 1
    let released = false
    return () => {
      if (released) return
      released = true
      entry.refs -= 1
      if (entry.refs) return
      if (this.entries.get(id) === entry) this.entries.delete(id)
      const done = entry.close().then(() => entry.done)
      this.closing.add(done)
      void done.finally(() => this.closing.delete(done))
    }
  }

  /** Drain every stream before plugin unload.
   * @returns settlement after iterators close.
   */
  async dispose(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(entries.map(async (entry) => { await entry.close(); await entry.done }))
    await Promise.all(this.closing)
  }
}
