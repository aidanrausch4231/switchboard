/** Observe newly completed turns without reading historical or intermediate text aloud. */
import { type SessionEventSource } from '../dsh.ts'

/**
 * Subscribe to live turn completion; baseline/reconnect history stays silent.
 * @param source - currently selected Session's event source.
 * @param speak - final text consumer.
 * @returns unsubscribe callback.
 */
export function observeReplies(source: SessionEventSource, speak: (text: string) => void): () => void {
  let seen = -1
  for (const entry of source.getSnapshot().entries) seen = Math.max(seen, entry.event.seq)
  return source.subscribe(() => {
    const snapshot = source.getSnapshot()
    const before = seen
    for (const entry of snapshot.entries) seen = Math.max(seen, entry.event.seq)
    if (snapshot.change.kind !== 'append') return
    for (const entry of snapshot.change.entries) {
      if (entry.type !== 'event' || entry.event.type !== 'turn/end' || entry.event.seq <= before) continue
      if (entry.event.data.reason.kind !== 'completed') continue
      const turn = entry.event.data.turn
      for (let index = snapshot.entries.length - 1; index >= 0; index--) {
        const candidate = snapshot.entries[index]
        if (!candidate) continue
        if (candidate.type !== 'event' || candidate.event.seq >= entry.event.seq) continue
        if (candidate.event.type === 'assistant/message' && candidate.event.data.turn === turn) {
          if (!candidate.event.data.interrupted) speak(candidate.event.data.message.content
            .filter(part => part.type === 'text').map(part => part.text).join('\n'))
          break
        }
      }
    }
  })
}
