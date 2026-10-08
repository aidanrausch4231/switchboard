// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { type InputActions } from '../src/client/dsh.ts'
import { SessionId } from '../src/client/dsh.ts'
import { spokenText, submitTranscript, VoiceRuntime, type VoiceApi, type VoiceControlBinding } from '../src/client/voice/runtime.ts'
import { browserCapture, openaiCapture } from '../src/client/voice/capture.ts'

vi.mock('../src/client/voice/capture.ts', () => ({
  browserCapture: vi.fn(), openaiCapture: vi.fn(),
}))
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals() })

function bindControl(voice: VoiceRuntime): VoiceControlBinding {
  const control = { element: () => null, sessionId: () => SessionId('main'), input: () => undefined, ready: () => false }
  voice.bindControl(control)
  return control
}

function api(): VoiceApi {
  return { status: async () => ({ sttProvider: 'browser', ttsProvider: 'off', openaiKeyPresent: false,
    maxAudioBytes: 100, maxDurationSeconds: 60 }),
  transcribe: vi.fn(async () => 'hello'), speak: vi.fn(async () => ({ base64: 'YQ==', mime: 'audio/mpeg' })) }
}

it('inserts the final transcript and submits through normal input actions, without replacing changed drafts', () => {
  const input = { captureInsertion: vi.fn(() => ({ start: 0, end: 0, draftRev: 0 })), insertText: vi.fn(() => true), submit: vi.fn(),
    setDraft: vi.fn(), persistDraft: vi.fn(), addAttachments: vi.fn(),
    removeAttachment: vi.fn(), pruneAttachments: vi.fn() } satisfies InputActions
  const span = input.captureInsertion()
  expect(submitTranscript(input, span, ' hello ')).toBe(true)
  expect(input.insertText).toHaveBeenCalledWith('hello', span)
  expect(input.submit).toHaveBeenCalledOnce()
  expect(input.setDraft).not.toHaveBeenCalled()
  vi.mocked(input.insertText).mockReturnValue(false)
  expect(submitTranscript(input, span, 'new')).toBe(false)
  expect(submitTranscript(input, span, ' ')).toBe(false)
  expect(input.submit).toHaveBeenCalledOnce()
})

it('trims fenced and unfinished code, preserving only surrounding prose', () => {
  expect(spokenText('Hello\n```ts\nconsole.log(1)\n```\nGoodbye')).toBe('Hello\n\nGoodbye')
  expect(spokenText('Before\n~~~py\nsecret()\n~~~\nAfter')).toBe('Before\n\nAfter')
  expect(spokenText('Before\n```js\nunfinished')).toBe('Before')
  expect(spokenText('```\ncode\n```')).toBe('')
  expect(spokenText('Keep `inline code` in prose')).toBe('Keep `inline code` in prose')
})

it.each([
  'Before\n\n> ```js\n> secret()\n> ```\n\nAfter',
  'Before\n\n    secret()\n    moreCode()\n\nAfter',
  'Before\n\n> > ~~~js\n> > secret()\n> > ~~~\n\nAfter',
  'Before\n\n\tsecret()\n\nAfter',
  'Before\n\n>     secret()\n\nAfter',
  'Before\n\n- ```js\n  secret()\n  ```\n\nAfter',
])('does not speak nested fenced or indented code: %s', async (text) => {
  const host = api(), voice = new VoiceRuntime(host)
  try {
    await voice.load()
    voice.configure('browser', 'openai')
    vi.mocked(host.speak).mockRejectedValue(new Error('playback'))
    await voice.speak(text, bindControl(voice))
    expect(host.speak).toHaveBeenCalledWith(expect.stringContaining('Before'), expect.any(AbortSignal))
    const prose = vi.mocked(host.speak).mock.calls[0]?.[0]
    expect(prose).toContain('After')
    expect(prose).not.toContain('secret')
    expect(prose).not.toContain('moreCode')
  } finally { voice.dispose() }
})

it('selects browser by default, publishes partial text, and supports an OpenAI session override', async () => {
  const host = api(), voice = new VoiceRuntime(host)
  try {
    await voice.load()
    vi.mocked(browserCapture).mockImplementation((partial) => { partial('hel'); return { finish: async () => 'hello', cancel: vi.fn() } })
    const submit = vi.fn(() => true)
    voice.start(submit)
    expect(voice.snapshot().partial).toBe('hel')
    voice.release()
    await vi.waitFor(() => { expect(submit).toHaveBeenCalledWith('hello') })
    expect(openaiCapture).not.toHaveBeenCalled()
    expect(voice.snapshot().history).toEqual(['hello'])
    voice.configure('openai', 'off')
    vi.mocked(openaiCapture).mockImplementation(async (signal, _limit, transcribe) => ({
      finish: async () => transcribe({ base64: 'YQ==', mime: 'audio/webm' }, signal), cancel: vi.fn(),
    }))
    voice.start(submit); voice.release()
    await vi.waitFor(() => { expect(submit).toHaveBeenCalledTimes(2) })
    expect(host.transcribe).toHaveBeenCalledOnce()
    expect(browserCapture).toHaveBeenCalledOnce()
    expect(voice.snapshot().tts).toBe('off')
  } finally { voice.dispose() }
})

it('contains failures, cancels navigation, and keeps speech disabled until selected', async () => {
  const host = api(), voice = new VoiceRuntime(host)
  try {
    await voice.load(); await voice.speak('hello', bindControl(voice))
    expect(host.speak).not.toHaveBeenCalled()
    vi.mocked(browserCapture).mockImplementation(() => { throw new Error('permission') })
    voice.start(vi.fn())
    await vi.waitFor(() => { expect(voice.snapshot().error).toBe('permission') })
    expect(voice.snapshot().phase).toBe('idle')
    voice.cancel()
    expect(voice.snapshot().partial).toBe('')
  } finally { voice.dispose() }
})
