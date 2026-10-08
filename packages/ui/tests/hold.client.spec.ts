// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { Hold, typingTarget, type Capture } from '../src/client/voice/hold.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

it('remembers release during permission and submits once despite key repeat', async () => {
  const hold = new Hold(), permission = deferred<Capture>(), done = deferred<undefined>()
  const capture = { finish: vi.fn(async () => ' hello '), cancel: vi.fn() }
  const open = vi.fn(() => permission.promise), submit = vi.fn(), failed = vi.fn()
  hold.start(open, submit, failed, () => { done.resolve(undefined) })
  hold.start(open, submit, failed, () => { done.resolve(undefined) })
  hold.release(); hold.release(); permission.resolve(capture)
  await done.promise
  expect(open).toHaveBeenCalledTimes(1)
  expect(capture.finish).toHaveBeenCalledTimes(1)
  expect(submit).toHaveBeenCalledExactlyOnceWith('hello')
  expect(failed).not.toHaveBeenCalled()
})

it('cancels before permission and stops late tracks without submitting', async () => {
  const hold = new Hold(), permission = deferred<Capture>(), stopped = deferred<undefined>()
  const submit = vi.fn(), failure = vi.fn(), settled = vi.fn()
  const capture = { finish: vi.fn(async () => 'late'), cancel: () => { stopped.resolve(undefined) } }
  hold.start(() => permission.promise, submit, failure, settled)
  hold.cancel(); permission.resolve(capture)
  await stopped.promise
  expect(capture.finish).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  expect(settled).not.toHaveBeenCalled()
})

it('Escape during transcription suppresses the result and permits a fresh hold', async () => {
  const hold = new Hold(), transcript = deferred<string>(), started = deferred<undefined>(), done = deferred<undefined>()
  const submit = vi.fn(), failure = vi.fn(), cancel = vi.fn()
  hold.start(async () => ({ finish: () => { started.resolve(undefined); return transcript.promise }, cancel }), submit, failure, vi.fn())
  hold.release(); await started.promise; hold.cancel(); transcript.resolve('discard')
  hold.start(async () => ({ finish: async () => 'next', cancel: vi.fn() }), submit, failure, () => { done.resolve(undefined) })
  hold.release(); await done.promise
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(submit).toHaveBeenCalledExactlyOnceWith('next')
})

it('reports failures, ignores empty speech, and keeps Space out of editing targets', async () => {
  const hold = new Hold(), failed = vi.fn(), first = deferred<undefined>(), second = deferred<undefined>(), submit = vi.fn()
  hold.start(async () => { throw new Error('permission') }, submit, failed, () => { first.resolve(undefined) })
  await first.promise
  expect(failed).toHaveBeenCalledOnce()
  hold.start(async () => ({ finish: async () => '  ', cancel: vi.fn() }), submit, failed, () => { second.resolve(undefined) })
  hold.release(); await second.promise
  expect(submit).not.toHaveBeenCalled()
  for (const tag of ['input', 'textarea', 'select', 'button']) expect(typingTarget(document.createElement(tag))).toBe(true)
  expect(typingTarget(document.createElement('div'))).toBe(false)
  expect(typingTarget(null)).toBe(false)
})
