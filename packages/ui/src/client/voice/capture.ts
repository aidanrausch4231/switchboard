/** Native browser speech recognition and MediaRecorder capture; tracks never outlive a hold. */
import type { VoiceAudio } from '@switchboard/core/types'
import type { Capture } from './hold.ts'

interface Recognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

function recognitionClass(): (new () => Recognition) | undefined {
  const browser = window as Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition
}

/** Detect the browser's speech recognition API.
 * @returns whether this browser exposes a Web Speech recognizer.
 */
export function supportsRecognition(): boolean { return Boolean(recognitionClass()) }

/**
 * Start browser-managed recognition; it may use the browser vendor's network service.
 * @param partial - live transcript publication.
 * @returns owned recognizer; finishing waits for final recognition results.
 */
export function browserCapture(partial: (text: string) => void): Capture {
  const RecognitionClass = recognitionClass()
  if (!RecognitionClass) throw new Error('unsupported')
  const recognition = new RecognitionClass()
  recognition.continuous = true
  recognition.interimResults = true
  let text = '', failure = '', ended = false
  let complete!: () => void
  const done = new Promise<void>((resolve) => { complete = resolve })
  recognition.onresult = (event) => {
    text = Array.from(event.results, result => result[0]?.transcript ?? '').join(' ')
    partial(text)
  }
  recognition.onerror = (event) => { failure = event.error; complete() }
  recognition.onend = () => { ended = true; complete() }
  const detach = () => { recognition.onresult = null; recognition.onerror = null; recognition.onend = null }
  recognition.start()
  return {
    finish: async () => {
      if (!ended) recognition.stop()
      await done
      detach()
      if (failure) throw new Error(failure === 'not-allowed' ? 'permission' : 'recognitionFailed')
      return text
    },
    cancel: () => { detach(); recognition.abort(); complete() },
  }
}

/**
 * Capture MIME-negotiated compressed audio for Host transcription.
 * @param signal - cancelled hold, including pending permission.
 * @param maxBytes - complete recording byte limit.
 * @param transcribe - Host transcription after release.
 * @returns recorder owning every acquired track.
 */
export async function openaiCapture(signal: AbortSignal, maxBytes: number,
  transcribe: (audio: VoiceAudio, signal: AbortSignal) => Promise<string>): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const stopTracks = () => { for (const track of stream.getTracks()) track.stop() }
  if (signal.aborted) { stopTracks(); throw new Error('cancelled') }
  let recorder: MediaRecorder
  try {
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type))
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch (error) { stopTracks(); throw error }
  const chunks: Blob[] = []
  let size = 0, tooLarge = false, failed = false
  let complete!: () => void
  const done = new Promise<void>((resolve) => { complete = resolve })
  recorder.ondataavailable = (event) => {
    size += event.data.size
    if (size > maxBytes) { tooLarge = true; stop() }
    else chunks.push(event.data)
  }
  recorder.onstop = () => { stopTracks(); complete() }
  recorder.onerror = () => { failed = true; stopTracks(); complete() }
  const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); stopTracks() }
  try { recorder.start(250) } catch (error) { stopTracks(); throw error }
  return {
    cancel: () => { stop(); chunks.length = 0 },
    finish: async () => {
      stop()
      await done
      if (tooLarge) throw new Error('tooLarge')
      if (failed) throw new Error('capture')
      signal.throwIfAborted()
      const blob = new Blob(chunks, { type: recorder.mimeType })
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          if (typeof reader.result === 'string') resolve(reader.result.split(',')[1] ?? '')
          else reject(new Error('capture'))
        }
        reader.onerror = () => { reject(new Error('capture')) }
        reader.readAsDataURL(blob)
      })
      signal.throwIfAborted()
      return transcribe({ base64, mime: blob.type }, signal)
    },
  }
}
