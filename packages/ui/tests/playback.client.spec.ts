// @vitest-environment jsdom
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '../src/client/dsh.ts'
import type { VoiceAudio } from '@switchboard/core/types'
import { VoiceRuntime, type VoiceControlBinding } from '../src/client/voice/runtime.ts'

afterEach(() => { vi.unstubAllGlobals() })

async function playback(provider: 'browser' | 'openai' = 'openai') {
  const selection = { id: SessionId('main') }
  const owner = { id: selection.id }
  const speak = vi.fn(async (_text: string, _signal: AbortSignal): Promise<VoiceAudio> => ({ base64: 'YQ==', mime: 'audio/mpeg' }))
  const voice = new VoiceRuntime({ status: async () => ({ sttProvider: 'browser', ttsProvider: provider,
    openaiKeyPresent: true, maxAudioBytes: 100, maxDurationSeconds: 60 }), transcribe: vi.fn(), speak }, () => selection.id)
  const control: VoiceControlBinding = { element: () => null, input: () => undefined, ready: () => false, sessionId: () => owner.id }
  const unregister = voice.bindControl(control)
  onTestFinished(() => { voice.dispose() })
  const audio = { play: vi.fn(async () => {}), pause: vi.fn(), onended: null, onerror: null }
  const AudioMock = vi.fn(function () { return audio })
  const synthesis = { speak: vi.fn(), cancel: vi.fn() }
  const createObjectURL = vi.fn(() => 'blob:reply'), revokeObjectURL = vi.fn()
  vi.stubGlobal('Audio', AudioMock)
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  vi.stubGlobal('speechSynthesis', synthesis)
  vi.stubGlobal('SpeechSynthesisUtterance', class { onerror = null })
  await voice.load()
  return { voice, control, unregister, selection, owner, speak, audio, AudioMock, synthesis, createObjectURL, revokeObjectURL }
}

it.each(['browser', 'openai'] as const)('stops active %s playback when the selected Session changes', async (provider) => {
  const f = await playback(provider)
  await f.voice.speak('reply', f.control)
  if (provider === 'browser') expect(f.synthesis.speak).toHaveBeenCalledOnce()
  else expect(f.audio.play).toHaveBeenCalledOnce()
  f.synthesis.cancel.mockClear()
  f.selection.id = SessionId('next')
  f.voice.checkSession()
  expect(f.synthesis.cancel).toHaveBeenCalledOnce()
  if (provider === 'openai') {
    expect(f.audio.pause).toHaveBeenCalledOnce()
    expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:reply')
    expect(f.speak.mock.calls[0]?.[1].aborted).toBe(true)
  }
})

it.each(['navigation', 'owner change', 'unmount', 'last control'] as const)('aborts synthesis on %s and ignores its late response', async (reason) => {
  const f = await playback()
  const final = Promise.withResolvers<VoiceAudio>()
  f.speak.mockReturnValue(final.promise)
  const pending = f.voice.speak('reply', f.control)
  expect(f.speak).toHaveBeenCalledOnce()
  if (reason === 'navigation') f.selection.id = SessionId('next')
  else if (reason === 'owner change') f.owner.id = SessionId('other')
  else {
    if (reason === 'unmount') f.voice.bindControl({ ...f.control })
    f.unregister()
  }
  f.voice.checkSession()
  const aborted = f.speak.mock.calls[0]?.[1].aborted
  f.selection.id = SessionId('main')
  f.owner.id = SessionId('main')
  f.voice.checkSession()
  final.resolve({ base64: 'YQ==', mime: 'audio/mpeg' })
  await pending
  expect(aborted).toBe(true)
  expect(f.AudioMock).not.toHaveBeenCalled()
  expect(f.createObjectURL).not.toHaveBeenCalled()
  expect(f.audio.play).not.toHaveBeenCalled()
})

it('ignores synthesis resolved after navigation before the Session notification arrives', async () => {
  const f = await playback()
  const final = Promise.withResolvers<VoiceAudio>()
  f.speak.mockReturnValue(final.promise)
  const pending = f.voice.speak('reply', f.control)
  f.selection.id = SessionId('next')
  final.resolve({ base64: 'YQ==', mime: 'audio/mpeg' })
  await pending
  expect(f.audio.play).not.toHaveBeenCalled()
  expect(f.speak.mock.calls[0]?.[1].aborted).toBe(true)
})

it.each(['browser', 'openai'] as const)('stops %s playback when the last control unregisters', async (provider) => {
  const f = await playback(provider)
  await f.voice.speak('reply', f.control)
  f.synthesis.cancel.mockClear()
  f.unregister()
  expect(f.synthesis.cancel).toHaveBeenCalledOnce()
  if (provider === 'openai') {
    expect(f.audio.pause).toHaveBeenCalledOnce()
    expect(f.revokeObjectURL).toHaveBeenCalledWith('blob:reply')
  }
})
