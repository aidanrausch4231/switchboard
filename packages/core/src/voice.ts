/** OpenAI audio calls with bounded payloads and credential-free failures. */
import type { VoiceAudio, VoiceResult, VoiceStatus, VoiceTranscript } from './types.ts'

/** Host defaults; browser-local choices may override the provider selections. */
export interface VoiceConfig {
  /** Default speech recognition provider; Browser needs no OpenAI key. */
  sttProvider: 'browser' | 'openai'
  /** Default spoken reply provider; off disables playback. */
  ttsProvider: 'off' | 'browser' | 'openai'
  /** OpenAI transcription model, with no implicit fallback. */
  transcriptionModel: string
  /** OpenAI speech synthesis model. */
  speechModel: string
  /** OpenAI speech synthesis voice. */
  speechVoice: string
  /** Complete audio payload limit in bytes, at most 10 MiB. */
  maxAudioBytes: number
  /** Browser hold-operation lifetime in seconds, including permission and transcription. */
  maxDurationSeconds: number
  /** Deadline in milliseconds for each OpenAI request. */
  timeoutMs: number
}

/**
 * Map HTTP failures without copying provider bodies or request headers.
 * @param status - upstream HTTP status.
 * @returns safe user-facing error.
 */
export function speechFailure(status: number): string {
  return status === 429
    ? 'OpenAI speech quota exceeded — switch to Browser in Voice settings'
    : `OpenAI speech request failed (HTTP ${status})`
}

class SpeechError extends Error {}

/** Fixed-origin audio client; only the Host reads OPENAI_API_KEY. */
export class VoiceProvider {
  constructor(private readonly config: VoiceConfig, private readonly request: typeof fetch = fetch) {}

  /** Read speech settings without revealing credentials.
   * @returns provider defaults, limits, and key presence, never key contents.
   */
  status(): VoiceStatus {
    return { sttProvider: this.config.sttProvider, ttsProvider: this.config.ttsProvider,
      maxAudioBytes: this.config.maxAudioBytes, maxDurationSeconds: this.config.maxDurationSeconds,
      openaiKeyPresent: Boolean(process.env.OPENAI_API_KEY?.trim()) }
  }

  private async call(path: string, body: BodyInit, contentType: string | undefined,
    signal: AbortSignal): Promise<{ response: Response; key: string }> {
    const key = process.env.OPENAI_API_KEY?.trim()
    if (!key) throw new SpeechError('OpenAI speech key is not configured — switch to Browser in Voice settings')
    let response: Response
    try {
      response = await this.request(`https://api.openai.com/v1/audio/${path}`, {
        method: 'POST', redirect: 'error', body,
        headers: { Authorization: `Bearer ${key}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]),
      })
    } catch (_error) { throw new SpeechError('OpenAI speech request failed or was cancelled') }
    if (!response.ok) { await response.body?.cancel(); throw new SpeechError(speechFailure(response.status)) }
    return { response, key }
  }

  /**
   * Transcribe canonical base64 browser audio; provider output is validated and secrets are rejected.
   * @param audio - MIME-tagged recording.
   * @param signal - client operation lifetime.
   * @returns text or a credential-free error.
   */
  async transcribe(audio: VoiceAudio, signal: AbortSignal): Promise<VoiceResult<VoiceTranscript>> {
    if (audio.base64.length > Math.ceil(this.config.maxAudioBytes / 3) * 4
      || !/^audio\/(webm|ogg|mp4|wav)(;codecs=[a-z0-9.,-]+)?$/i.test(audio.mime)) {
      return { ok: false, error: 'Unsupported audio or recording exceeds the byte limit' }
    }
    const bytes = Buffer.from(audio.base64, 'base64')
    if (!bytes.length || bytes.length > this.config.maxAudioBytes || bytes.toString('base64') !== audio.base64) {
      return { ok: false, error: 'Invalid audio encoding or size' }
    }
    try {
      const form = new FormData()
      form.set('model', this.config.transcriptionModel)
      form.set('file', new Blob([bytes], { type: audio.mime }), `speech.${audio.mime.slice('audio/'.length).split(';')[0]}`)
      const { response, key } = await this.call('transcriptions', form, undefined, signal)
      let value: unknown
      try { value = await response.json() } catch (_error) {
        return { ok: false, error: 'OpenAI returned an unreadable transcription' }
      }
      if (typeof value !== 'object' || value === null || !('text' in value) || typeof value.text !== 'string'
        || value.text.length > 32_768 || !value.text.trim()
        || value.text.includes(key)) {
        return { ok: false, error: 'OpenAI returned an invalid transcription' }
      }
      return { ok: true, value: { text: value.text.trim() } }
    } catch (error) { return { ok: false, error: error instanceof SpeechError ? error.message : 'OpenAI speech request failed' } }
  }

  /**
   * Synthesize bounded text as MP3; input is never interpreted as configuration.
   * @param text - final assistant prose.
   * @param signal - client operation lifetime.
   * @returns audio or a credential-free error.
   */
  async speak(text: string, signal: AbortSignal): Promise<VoiceResult<VoiceAudio>> {
    if (!text.trim() || text.length > 4096) return { ok: false, error: 'Speech text must contain 1–4096 characters' }
    try {
      const { response, key } = await this.call('speech', JSON.stringify({ model: this.config.speechModel,
        voice: this.config.speechVoice, input: text, response_format: 'mp3' }), 'application/json', signal)
      const reader = response.body?.getReader()
      if (!reader) return { ok: false, error: 'OpenAI returned no audio' }
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > this.config.maxAudioBytes) { await reader.cancel(); return { ok: false, error: 'Speech audio exceeds the byte limit' } }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const bytes = Buffer.concat(chunks)
      if (!size || bytes.includes(Buffer.from(key))) {
        return { ok: false, error: 'OpenAI returned invalid audio' }
      }
      return { ok: true, value: { base64: bytes.toString('base64'), mime: 'audio/mpeg' } }
    } catch (_error) { return { ok: false, error: _error instanceof SpeechError ? _error.message : 'OpenAI speech request failed' } }
  }
}
