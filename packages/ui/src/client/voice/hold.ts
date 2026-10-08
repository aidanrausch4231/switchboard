/** One hold operation owns late microphone permission, release, and cancellation. */

/** Capture resource returned after browser permission has settled. */
export interface Capture {
  /** @returns final transcript after stopping all microphone tracks. */
  finish(): Promise<string>
  /** Stop capture without submitting text. */
  cancel(): void
}

/** Push-to-talk operation; repeats are ignored and cancellation suppresses late results. */
export class Hold {
  private operation: { abort: AbortController; released: boolean; capture: Capture | undefined } | undefined

  /**
   * Begin a hold if idle. Permission may resolve after release or cancellation.
   * @param open - create a browser recognizer or recorder.
   * @param submit - accepts one final nonempty transcript.
   * @param failed - receives capture or submit failures.
   * @param settled - releases UI state after completion.
   */
  start(open: (signal: AbortSignal) => Promise<Capture>, submit: (text: string) => void,
    failed: (error: unknown) => void, settled: () => void): void {
    if (this.operation) return
    const operation = { abort: new AbortController(), released: false, capture: undefined as Capture | undefined }
    this.operation = operation
    const cancelled = (): boolean => operation.abort.signal.aborted
    void (async () => {
      try {
        const capture = await open(operation.abort.signal)
        operation.capture = capture
        if (cancelled()) { capture.cancel(); return }
        if (!operation.released) await new Promise<void>((resolve) => {
          operation.abort.signal.addEventListener('abort', () => { resolve() }, { once: true })
          this.releaseWaiter = resolve
        })
        if (cancelled()) { capture.cancel(); return }
        const text = (await capture.finish()).trim()
        if (!cancelled() && text) submit(text)
      } catch (error) {
        operation.capture?.cancel()
        if (!operation.abort.signal.aborted) failed(error)
      } finally {
        if (this.operation === operation) { this.operation = undefined; this.releaseWaiter = undefined; settled() }
      }
    })()
  }

  private releaseWaiter: (() => void) | undefined

  /** Release is remembered even before microphone permission resolves. */
  release(): void {
    if (!this.operation) return
    this.operation.released = true
    this.releaseWaiter?.()
  }

  /** Abort capture and discard all pending transcription results. */
  cancel(): void {
    this.operation?.abort.abort()
    this.operation?.capture?.cancel()
    this.operation = undefined
    this.releaseWaiter = undefined
  }
}

/**
 * Keep global Space shortcuts out of editors and native interactive controls.
 * @param target - keyboard event target.
 * @returns whether the target consumes typing or Space itself.
 */
export function typingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable
    || Boolean(target.closest('input, textarea, select, button, [contenteditable], [role="textbox"], [role="dialog"]')))
}
