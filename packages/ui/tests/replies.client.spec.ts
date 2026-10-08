import { expect, it, vi } from 'vitest'
import { MutableSessionEventSource, type SessionEventLikeEntry } from '../src/client/dsh.ts'
import { observeReplies } from '../src/client/voice/replies.ts'
import { SessionSeq, type SessionEvent } from '../src/client/dsh.ts'

function message(seq: number, text: string, turn = 1): SessionEventLikeEntry {
  return { type: 'event', event: { type: 'assistant/message', seq: SessionSeq(seq), time: 0, surfaceOp: 'append',
    data: { turn, step: 1, stream: [],
      message: { id: `message-${seq}` as SessionEvent<'assistant/message'>['data']['message']['id'],
        role: 'assistant', source: { kind: 'model', model: 'test', provider: 'test' },
        content: [{ type: 'text', text }, { type: 'reasoning', text: 'private reasoning' }] } } } }
}
function end(seq: number, turn = 1): SessionEventLikeEntry {
  return { type: 'event', event: { type: 'turn/end', seq: SessionSeq(seq), time: 0, data: { turn, reason: { kind: 'completed' } } } }
}

it('speaks only the last assistant text of a newly completed turn, not history, reasoning, or intermediate steps', () => {
  const source = new MutableSessionEventSource(), speak = vi.fn()
  source.replace([message(1, 'old'), end(2)], false)
  const dispose = observeReplies(source, speak)
  source.append(message(3, 'intermediate', 2))
  source.append(message(4, 'final', 2))
  expect(speak).not.toHaveBeenCalled()
  source.append(end(5, 2))
  expect(speak).toHaveBeenCalledExactlyOnceWith('final')
  source.replace([message(4, 'final', 2), end(5, 2)], false)
  source.append(end(5, 2))
  expect(speak).toHaveBeenCalledOnce()
  dispose()
  source.append(message(6, 'after dispose', 3)); source.append(end(7, 3))
  expect(speak).toHaveBeenCalledOnce()
})
