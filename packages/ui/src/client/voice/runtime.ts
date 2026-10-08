/** Browser-session voice preferences, capture ownership, and reply playback. */
import type { VoiceAudio, VoiceStatus } from '@switchboard/core/types'
import { type InputActions, type TokenSpan } from '../dsh.ts'
import { type SessionId } from '../dsh.ts'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { Hold, typingTarget } from './hold.ts'
import { browserCapture, openaiCapture } from './capture.ts'

/** Host calls unwrapped by the Cordis assembly. */
export interface VoiceApi {
  status: () => Promise<VoiceStatus>
  transcribe: (audio: VoiceAudio, signal: AbortSignal) => Promise<string>
  speak: (text: string, signal: AbortSignal) => Promise<VoiceAudio>
}

/** Mounted Session control; getters read current props without rebinding keyboard listeners. */
export interface VoiceControlBinding {
  /** @returns control element, also used to locate the containing composer. */
  element: () => HTMLElement | null
  /** @returns Session owning this control. */
  sessionId: () => SessionId | undefined
  /** @returns the Session-owned input actions. */
  input: () => InputActions | undefined
  /** @returns whether the draft is empty and permits capture. */
  ready: () => boolean
}

/** Browser-local data, cleared on reload rather than persisted with Sessions. */
export interface VoiceState {
  status?: VoiceStatus
  stt: 'browser' | 'openai'
  tts: 'off' | 'browser' | 'openai'
  phase: 'idle' | 'requesting' | 'recording' | 'transcribing'
  partial: string
  error: string
  history: readonly string[]
}

/**
 * Insert at the original revision, then use the normal composer submission path.
 * @param input - Session-owned input actions.
 * @param span - revision captured when recording began.
 * @param text - final transcript.
 * @returns whether insertion and submission were requested; false leaves subsequent edits intact.
 */
export function submitTranscript(input: InputActions, span: TokenSpan, text: string): boolean {
  if (!text.trim() || !input.insertText(text.trim(), span)) return false
  input.submit()
  return true
}

/**
 * Remove Markdown code blocks, including nested and unfinished fences, before speech synthesis.
 * @param text - assistant text, never reasoning or tool arguments.
 * @returns trimmed prose without code blocks.
 */
export function spokenText(text: string): string {
  const ranges: { start: number; end: number }[] = []
  const collect = (nodes: ReturnType<typeof fromMarkdown>['children']): void => {
    for (const node of nodes) {
      if (node.type === 'code' && node.position) {
        const { start, end } = node.position
        if (start.offset !== undefined && end.offset !== undefined) {
          ranges.push({ start: text.lastIndexOf('\n', start.offset - 1) + 1, end: end.offset })
        }
      } else if ('children' in node) collect(node.children)
    }
  }
  collect(fromMarkdown(text).children)
  for (const { start, end } of ranges.reverse()) text = text.slice(0, start) + text.slice(end)
  return text.trim()
}

/** A single microphone and speech player shared by the page and composer. */
export class VoiceRuntime {
  private state: VoiceState = { stt: 'browser', tts: 'off', phase: 'idle', partial: '', error: '', history: [] }
  private readonly listeners = new Set<() => void>()
  private readonly hold = new Hold()
  private timer?: ReturnType<typeof setTimeout>
  private playback: {
    controller: AbortController
    control: VoiceControlBinding
    sessionId: SessionId
    selected: SessionId | undefined
  } | undefined
  private audio: HTMLAudioElement | undefined
  private audioUrl: string | undefined
  private disposed = false

  private readonly controls = new Set<VoiceControlBinding>()
  private owner: { control: VoiceControlBinding; sessionId: SessionId; selected: SessionId | undefined } | undefined
  private key: string | undefined

  constructor(private readonly api: VoiceApi, private readonly currentSession: () => SessionId | undefined = () => undefined) {}

  /** Bind a mounted control to the runtime's single keyboard listener set.
   * @param control - current Session, readiness, and containing element.
   * @returns unregister; stops this control's playback and discards its pending capture with a notice.
   */
  bindControl(control: VoiceControlBinding): () => void {
    if (!this.controls.size) {
      window.addEventListener('keydown', this.keyDown)
      window.addEventListener('keyup', this.keyUp)
      window.addEventListener('blur', this.blur)
      document.addEventListener('visibilitychange', this.visibility)
    }
    this.controls.add(control)
    return () => {
      this.controls.delete(control)
      if (this.owner?.control === control) { this.cancel(); this.update({ error: 'sessionChanged' }) }
      if (this.playback?.control === control || !this.controls.size) this.stopSpeaking()
      if (!this.controls.size) this.unbindKeyboard()
    }
  }

  private keyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape') { this.cancel(); return }
    if (event.defaultPrevented || event.code !== 'Space' || event.repeat || typingTarget(event.target)) return
    const focused = document.activeElement
    const composer = focused?.closest('[data-composer-seat]')
    const controls = [...this.controls]
    const focusedControl = controls.find((candidate) => {
      const element = candidate.element()
      return Boolean(element && (composer ? composer.contains(element) : focused && element.contains(focused)))
    })
    const control = focusedControl ?? (composer ? undefined : controls.find(candidate => candidate.sessionId() === this.currentSession()))
    if (!control) return
    event.preventDefault()
    this.record(control, event.code)
  }
  private keyUp = (event: KeyboardEvent): void => { if (event.code === this.key) { this.key = undefined; this.release() } }
  private blur = (): void => { this.cancel() }
  private visibility = (): void => { if (document.hidden) this.cancel() }
  private unbindKeyboard(): void {
    window.removeEventListener('keydown', this.keyDown)
    window.removeEventListener('keyup', this.keyUp)
    window.removeEventListener('blur', this.blur)
    document.removeEventListener('visibilitychange', this.visibility)
  }

  /** Capture the initiating Session and revision; changed selection discards text with a notice.
   * @param control - the sole owner for this recording.
   * @param key - initiating keyboard code, absent for pointer holds.
   */
  record(control: VoiceControlBinding, key?: string): void {
    const input = control.input(), sessionId = control.sessionId(), selected = this.currentSession()
    if (!input || !sessionId || !control.ready() || !this.state.status || this.state.phase !== 'idle') return
    const span = input.captureInsertion()
    this.owner = { control, sessionId, selected }
    this.key = key
    this.start((text) => {
      if (control.sessionId() !== sessionId || this.currentSession() !== selected) throw new Error('sessionChanged')
      return submitTranscript(input, span, text)
    })
  }

  /** Cancel capture and playback when their owning control or main Session selection changes. */
  checkSession(): void {
    const playback = this.playback
    if (playback && (playback.control.sessionId() !== playback.sessionId || this.currentSession() !== playback.selected)) {
      this.stopSpeaking()
    }
    const owner = this.owner
    if (owner && (owner.control.sessionId() !== owner.sessionId || this.currentSession() !== owner.selected)) {
      this.cancel()
      this.update({ error: 'sessionChanged' })
    }
  }

  /** Read current browser voice state.
   * @returns the stable current snapshot for useSyncExternalStore.
   */
  snapshot = (): VoiceState => this.state
  /** Observe browser voice state changes.
   * @param listener - snapshot invalidation.
   * @returns unsubscribe.
   */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<VoiceState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** Read Host defaults once at plugin activation. */
  async load(): Promise<void> {
    try {
      const status = await this.api.status()
      this.update({ status, stt: status.sttProvider, tts: status.ttsProvider, error: '' })
    } catch (_error) { this.update({ error: 'statusFailed' }) }
  }

  /** Cancel active audio and replace browser-session provider preferences.
   * @param stt - browser-session recognition preference.
   * @param tts - spoken reply preference.
   */
  configure(stt: VoiceState['stt'], tts: VoiceState['tts']): void {
    this.cancel()
    this.update({ stt, tts, error: '' })
  }

  /**
   * Start one hold with the caller's captured Session input revision.
   * @param submit - final text insertion; false reports a draft conflict.
   */
  start(submit: (text: string) => boolean): void {
    const { status, stt } = this.state
    if (!status || this.state.phase !== 'idle') return
    this.stopSpeaking()
    this.update({ phase: 'requesting', partial: '', error: '' })
    this.timer = setTimeout(() => { this.cancel(); this.update({ error: 'duration' }) }, status.maxDurationSeconds * 1000)
    this.hold.start(async (signal) => {
      const capture = stt === 'browser'
        ? browserCapture((text) => { if (!signal.aborted) this.update({ partial: text }) })
        : await openaiCapture(signal, status.maxAudioBytes, async (audio, lifetime) => this.api.transcribe(audio, lifetime))
      if (!signal.aborted) this.update({ phase: 'recording' })
      return { cancel: () => { capture.cancel() }, finish: async () => {
        this.update({ phase: 'transcribing' })
        return capture.finish()
      } }
    }, (text) => {
      const accepted = submit(text)
      this.update({ partial: text, history: [...this.state.history, text], error: accepted ? '' : 'conflict' })
    }, (error) => {
      this.update({ error: error instanceof DOMException && error.name === 'NotAllowedError' ? 'permission'
        : error instanceof Error ? error.message : 'capture' })
    }, () => { clearTimeout(this.timer); this.owner = undefined; this.key = undefined; this.update({ phase: 'idle' }) })
  }

  /** Release submits once final recognition resolves. */
  release(): void { this.hold.release() }
  /** Cancel on Escape, navigation, lost focus, or unmount. */
  cancel(): void { clearTimeout(this.timer); this.hold.cancel(); this.owner = undefined; this.key = undefined; this.stopSpeaking(); this.update({ phase: 'idle', partial: '' }) }

  /**
   * Play new final-turn prose while the observing control and its Session remain current.
   * @param text - final assistant message text.
   * @param control - mounted control owning synthesis and playback.
   */
  async speak(text: string, control: VoiceControlBinding): Promise<void> {
    const prose = spokenText(text), sessionId = control.sessionId()
    if (this.disposed || !this.controls.has(control) || !sessionId || !prose || this.state.tts === 'off' || this.state.phase !== 'idle') return
    this.stopSpeaking()
    const controller = new AbortController()
    const playback = { controller, control, sessionId, selected: this.currentSession() }
    this.playback = playback
    try {
      if (this.state.tts === 'browser') {
        if (!('speechSynthesis' in window)) throw new Error('ttsUnsupported')
        const utterance = new SpeechSynthesisUtterance(prose)
        utterance.onerror = () => { if (!controller.signal.aborted) this.update({ error: 'playback' }) }
        window.speechSynthesis.speak(utterance)
      } else {
        if (prose.length > 4096) throw new Error('replyTooLong')
        const audio = await this.api.speak(prose, controller.signal)
        this.checkSession()
        if (this.playback !== playback || controller.signal.aborted) return
        const bytes = Uint8Array.from(atob(audio.base64), character => character.charCodeAt(0))
        this.audioUrl = URL.createObjectURL(new Blob([bytes], { type: audio.mime }))
        this.audio = new Audio(this.audioUrl)
        this.audio.onended = () => { this.stopSpeaking() }
        this.audio.onerror = () => { this.update({ error: 'playback' }); this.stopSpeaking() }
        await this.audio.play()
      }
    } catch (error) {
      if (!controller.signal.aborted) { this.update({ error: error instanceof Error ? error.message : 'playback' }); this.stopSpeaking() }
    }
  }

  private stopSpeaking(): void {
    this.playback?.controller.abort()
    this.playback = undefined
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    if (this.audio) { this.audio.onended = null; this.audio.onerror = null; this.audio.pause(); this.audio = undefined }
    if (this.audioUrl) { URL.revokeObjectURL(this.audioUrl); this.audioUrl = undefined }
  }

  /** Cancel all owned browser work and stop publishing snapshots. */
  dispose(): void { this.cancel(); this.unbindKeyboard(); this.controls.clear(); this.disposed = true; this.listeners.clear() }
}
