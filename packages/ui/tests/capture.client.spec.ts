// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { browserCapture, openaiCapture } from '../src/client/voice/capture.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('browser recognition exposes partials, waits for final text, and aborts cancellation', async () => {
  class Recognition {
    static current: Recognition
    continuous = false
    interimResults = false
    onresult: ((event: { results: { transcript: string }[][] }) => void) | null = null
    onerror: ((event: { error: string }) => void) | null = null
    onend: (() => void) | null = null
    abort = vi.fn()
    constructor() { Recognition.current = this }
    start() { this.onresult?.({ results: [[{ transcript: 'partial' }]] }) }
    stop() { this.onresult?.({ results: [[{ transcript: 'final' }]] }); this.onend?.() }
  }
  vi.stubGlobal('SpeechRecognition', Recognition)
  const partial = vi.fn(), capture = browserCapture(partial)
  expect(partial).toHaveBeenCalledWith('partial')
  expect(await capture.finish()).toBe('final')
  expect(Recognition.current.onresult).toBeNull()
  browserCapture(partial).cancel()
  expect(Recognition.current.abort).toHaveBeenCalledOnce()
})

it('a cancelled permission request stops late microphone tracks', async () => {
  let resolve!: (stream: MediaStream) => void
  const permission = new Promise<MediaStream>((done) => { resolve = done })
  const stop = vi.fn(), signal = new AbortController()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => permission } })
  const pending = openaiCapture(signal.signal, 100, vi.fn())
  signal.abort()
  const track = new EventTarget() as MediaStreamTrack
  track.stop = stop
  resolve({ getTracks: () => [track] } as MediaStream)
  await expect(pending).rejects.toThrow('cancelled')
  expect(stop).toHaveBeenCalledOnce()
})

it('negotiates recorder MIME, stops tracks before transcription, and enforces the full audio limit', async () => {
  const stop = vi.fn()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } })
  class Recorder {
    static isTypeSupported(type: string) { return type === 'audio/mp4' }
    state = 'inactive'
    mimeType: string
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(_stream: MediaStream, options: MediaRecorderOptions) { this.mimeType = options.mimeType ?? '' }
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data: new Blob(['audio']) })
      this.onstop?.()
    }
  }
  vi.stubGlobal('MediaRecorder', Recorder)
  const transcribe = vi.fn(async () => { expect(stop).toHaveBeenCalled(); return 'hello' })
  const signal = new AbortController().signal
  const capture = await openaiCapture(signal, 100, transcribe)
  expect(await capture.finish()).toBe('hello')
  expect(transcribe).toHaveBeenCalledWith({ base64: btoa('audio'), mime: 'audio/mp4' }, signal)
  const oversized = await openaiCapture(signal, 1, transcribe)
  await expect(oversized.finish()).rejects.toThrow('tooLarge')
  expect(transcribe).toHaveBeenCalledOnce()
})
