import { expect, it, vi } from 'vitest'
import type { FlowRun, RunFrame, RunId } from '@switchboard/core/types'
import { RunModel } from '../src/client/run-model.ts'

it('shares a stream and drains it only after the final viewer releases it', async () => {
  let close!: () => void
  let stopped = false
  const wait = new Promise<void>((resolve) => { close = resolve })
  const dispose = vi.fn(async () => { close() })
  const open = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      try { await wait } finally { stopped = true }
    },
    dispose,
  }))
  const model = new RunModel(open)
  try {
    const first = model.watch('shared' as RunId)
    const second = model.watch('shared' as RunId)
    expect(open).toHaveBeenCalledTimes(1)
    first(); first()
    expect(dispose).not.toHaveBeenCalled()
    second()
    await model.dispose()
    expect(stopped).toBe(true)
    expect(dispose).toHaveBeenCalled()
  } finally { await model.dispose() }
})

it('opens a fresh observation after failure even while another viewer retains the run', async () => {
  const open = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      throw new Error('Observation interrupted')
    },
    async dispose() {},
  }))
  const model = new RunModel(open)
  try {
    const card = model.watch('retry' as RunId)
    const dock = model.watch('retry' as RunId)
    await vi.waitFor(() =>{  expect(model.source.getSnapshot().retry?.error).toContain('Observation interrupted') })
    dock()
    const retried = model.watch('retry' as RunId)
    expect(open).toHaveBeenCalledTimes(2)
    card(); retried()
  } finally { await model.dispose() }
})

it('keeps the card subscribed after dock retry and dock closure', async () => {
  let deliver!: (frame: RunFrame | undefined) => void
  const close = vi.fn(async () => { deliver(undefined) })
  const open = vi.fn().mockImplementationOnce(() => ({
    async *[Symbol.asyncIterator]() { throw new Error('Offline') }, async dispose() {},
  })).mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      while (true) {
        const frame = await new Promise<RunFrame | undefined>((resolve) => { deliver = resolve })
        if (!frame) return
        yield { value: frame, accept() {} }
      }
    }, dispose: close,
  }))
  const model = new RunModel(open)
  try {
    const id = 'shared-retry' as RunId
    const card = model.watch(id)
    const dock = model.watch(id)
    await vi.waitFor(() => { expect(model.source.getSnapshot()[id]?.error).toContain('Offline') })
    dock()
    const retry = model.watch(id)
    retry()
    expect(close).not.toHaveBeenCalled()
    const run = { id, state: 'running', tokens: 42 } as FlowRun
    deliver({ type: 'update', run })
    await vi.waitFor(() => { expect(model.source.getSnapshot()[id]?.run?.tokens).toBe(42) })
    card()
  } finally { await model.dispose() }
})
