import { Context } from '../src/dsh.ts'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import Switchboard from '../src/index.ts'
import { VoiceProvider } from '../src/voice.ts'

const voiceConfig = Switchboard.Config

const secret = 'test-only-speech-credential'
const audio = { base64: Buffer.from('fake-audio').toString('base64'), mime: 'audio/webm;codecs=opus' }
const signal = () => new AbortController().signal
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it('selects validated defaults and explicit providers without exposing the key', () => {
  vi.stubEnv('OPENAI_API_KEY', secret)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const service = new Switchboard(ctx)
  expect(service.voiceStatus()).toEqual({ sttProvider: 'browser', ttsProvider: 'off', openaiKeyPresent: true,
    maxAudioBytes: 10 * 1024 * 1024, maxDurationSeconds: 60 })
  expect(JSON.stringify([service.ping(), service.voiceStatus()])).not.toContain(secret)
  expect(new VoiceProvider(voiceConfig({ sttProvider: 'openai', ttsProvider: 'browser' })).status()).toMatchObject({ sttProvider: 'openai', ttsProvider: 'browser' })
  expect(() => voiceConfig({ sttProvider: 'invalid' } as never)).toThrow()
  expect(() => voiceConfig({ timeoutMs: 0 })).toThrow()
})

it('uses the configured transcription model and returns only recognized text', async () => {
  vi.stubEnv('OPENAI_API_KEY', secret)
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ text: ' hello ', debug: secret }))
  const provider = new VoiceProvider(voiceConfig({ transcriptionModel: 'whisper-1' }), fetcher)
  expect(await provider.transcribe(audio, signal())).toEqual({ ok: true, value: { text: 'hello' } })
  const [url, init] = fetcher.mock.calls[0]!
  expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
  expect(init?.redirect).toBe('error')
  expect((init?.body as FormData).get('model')).toBe('whisper-1')
  expect(init?.headers).toEqual({ Authorization: `Bearer ${secret}` })
})

it('maps 429 on both Remote audio operations and never forwards provider error bodies', async () => {
  vi.stubEnv('OPENAI_API_KEY', secret)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(secret, { status: 429 })))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const service = new Switchboard(ctx)
  for (const result of [await service.voiceTranscribe(audio, signal()), await service.voiceSpeak('hello', signal())]) {
    expect(result).toEqual({ ok: false, error: 'OpenAI speech quota exceeded — switch to Browser in Voice settings' })
    expect(JSON.stringify(result)).not.toContain(secret)
  }
})

it('rejects invalid or oversized audio before provider access', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const provider = new VoiceProvider(voiceConfig({ maxAudioBytes: 8 }), fetcher)
  for (const invalid of [audio, { ...audio, mime: 'text/plain' }, { ...audio, base64: '%%' }, { ...audio, base64: '' }]) {
    expect((await provider.transcribe(invalid, signal())).ok).toBe(false)
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('contains transport secrets and rejects reflected keys in successful transcripts and audio', async () => {
  vi.stubEnv('OPENAI_API_KEY', secret)
  const fetcher = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new Error(secret))
    .mockResolvedValueOnce(Response.json({ text: secret }))
    .mockResolvedValueOnce(new Response(secret))
  const provider = new VoiceProvider(voiceConfig({}), fetcher)
  for (const result of [await provider.transcribe(audio, signal()), await provider.transcribe(audio, signal()), await provider.speak('hi', signal())]) {
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
  }
})

it.each([
  { kind: 'transcript', rotate: false }, { kind: 'audio', rotate: false },
  { kind: 'transcript', rotate: true }, { kind: 'audio', rotate: true },
])('rejects a padded credential reflected in $kind (environment rotation: $rotate)', async ({ kind, rotate }) => {
  vi.stubEnv('OPENAI_API_KEY', ` ${secret} \n`)
  const fetcher = vi.fn<typeof fetch>(async () => {
    if (rotate) vi.stubEnv('OPENAI_API_KEY', 'replacement-test-key')
    return kind === 'transcript' ? Response.json({ text: `echo ${secret}` }) : new Response(secret)
  })
  const provider = new VoiceProvider(voiceConfig({}), fetcher)
  const result = kind === 'transcript' ? await provider.transcribe(audio, signal()) : await provider.speak('hi', signal())
  expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${secret}` })
  expect(result.ok).toBe(false)
  expect(JSON.stringify(result)).not.toContain(secret)
})

it('returns bounded MP3 and reports missing keys without calling OpenAI', async () => {
  vi.stubEnv('OPENAI_API_KEY', '')
  const fetcher = vi.fn<typeof fetch>(async () => new Response('mp3'))
  const provider = new VoiceProvider(voiceConfig({}), fetcher)
  expect(provider.status().openaiKeyPresent).toBe(false)
  expect((await provider.speak('hi', signal())).ok).toBe(false)
  expect(fetcher).not.toHaveBeenCalled()
  vi.stubEnv('OPENAI_API_KEY', secret)
  expect(await provider.speak('hi', signal())).toEqual({ ok: true, value: { base64: Buffer.from('mp3').toString('base64'), mime: 'audio/mpeg' } })
  expect((await provider.speak('x'.repeat(4097), signal())).ok).toBe(false)
  const small = new VoiceProvider(voiceConfig({ maxAudioBytes: 1 }), fetcher)
  expect((await small.speak('hi', signal())).ok).toBe(false)
})
