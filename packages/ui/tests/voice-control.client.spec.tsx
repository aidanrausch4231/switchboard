// @vitest-environment jsdom
import { Context } from '../src/client/dsh.ts'
import { LocaleRuntime } from '../src/client/dsh.ts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { type InputActions, type InputState } from '../src/client/dsh.ts'
import { ComposerVoice, VoiceSurface } from '../src/client/voice/Voice.tsx'
import { VoiceRuntime } from '../src/client/voice/runtime.ts'
import { en } from '../src/client/locales.ts'
import { SessionId } from '../src/client/dsh.ts'
import { browserCapture } from '../src/client/voice/capture.ts'

vi.mock('../src/client/voice/capture.ts', () => ({
  browserCapture: vi.fn(), openaiCapture: vi.fn(), supportsRecognition: () => true,
}))
afterEach(() => { cleanup(); vi.resetAllMocks() })

const mainId = SessionId('main'), childId = SessionId('child'), nextId = SessionId('next')

function inputActions() {
  return { captureInsertion: vi.fn(() => ({ start: 0, end: 0, draftRev: 0 })), insertText: vi.fn(() => true),
    submit: vi.fn(), setDraft: vi.fn(), persistDraft: vi.fn(), addAttachments: vi.fn(),
    removeAttachment: vi.fn(), pruneAttachments: vi.fn() } satisfies InputActions
}

async function controls() {
  const ctx = new Context(), locale = new LocaleRuntime(ctx)
  locale.register('switchboard', { en, zh: en })
  const selection = { id: mainId }
  const voice = new VoiceRuntime({ status: async () => ({ sttProvider: 'browser', ttsProvider: 'off', openaiKeyPresent: false,
    maxAudioBytes: 100, maxDurationSeconds: 60 }), transcribe: vi.fn(), speak: vi.fn() }, () => selection.id)
  onTestFinished(async () => { voice.dispose(); await ctx.fiber.dispose() })
  await voice.load()
  const draft: InputState = { draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] }
  const main = inputActions(), child = inputActions()
  const view = (mainDraft = '', sessionId = mainId) => <>
    <div data-composer-seat="" data-testid="main">
      <ComposerVoice voice={voice} events={undefined} sessionId={sessionId} t={locale.bind('switchboard')}
        onActiveChange={vi.fn()} locked={false} inputActions={main} useInput={selector => selector({ ...draft, draft: mainDraft })} />
      <a href="#main">Main link</a>
    </div>
    <div data-composer-seat="" data-testid="child">
      <ComposerVoice voice={voice} events={undefined} sessionId={childId} t={locale.bind('switchboard')}
        onActiveChange={vi.fn()} locked={false} inputActions={child} useInput={selector => selector(draft)} />
      <a href="#child">Child link</a>
    </div>
  </>
  return { voice, selection, main, child, view }
}

it('does not fall through from the active main draft to an empty sidebar composer', async () => {
  const fixture = await controls()
  render(fixture.view('existing draft'))
  vi.mocked(browserCapture).mockReturnValue({ finish: async () => 'hello', cancel: vi.fn() })
  await act(async () => { fireEvent.keyDown(window, { code: 'Space' }); fireEvent.keyUp(window, { code: 'Space' }) })
  expect(browserCapture).not.toHaveBeenCalled()
  expect(fixture.child.submit).not.toHaveBeenCalled()
})

it('gives Space to the focused composer, otherwise only the active main Session', async () => {
  const fixture = await controls()
  render(fixture.view())
  vi.mocked(browserCapture).mockReturnValue({ finish: async () => 'hello', cancel: vi.fn() })
  await act(async () => { fireEvent.keyDown(window, { code: 'Space' }); fireEvent.keyUp(window, { code: 'Space' }) })
  expect(fixture.main.submit).toHaveBeenCalledOnce()
  expect(fixture.child.submit).not.toHaveBeenCalled()
  screen.getByText('Child link').focus()
  await act(async () => { fireEvent.keyDown(document.activeElement!, { code: 'Space' }); fireEvent.keyUp(window, { code: 'Space' }) })
  expect(fixture.child.submit).toHaveBeenCalledOnce()
  expect(fixture.main.submit).toHaveBeenCalledOnce()
})

it('discards transcription with a notice when the main Session changes, even before rerender', async () => {
  const fixture = await controls()
  render(fixture.view())
  const final = Promise.withResolvers<string>()
  vi.mocked(browserCapture).mockReturnValue({ finish: () => final.promise, cancel: vi.fn() })
  await act(async () => { fireEvent.keyDown(window, { code: 'Space' }); fireEvent.keyUp(window, { code: 'Space' }) })
  expect(fixture.voice.snapshot().phase).toBe('transcribing')
  fixture.selection.id = nextId
  await act(async () => { final.resolve('old session text'); await final.promise })
  expect(fixture.main.insertText).not.toHaveBeenCalled()
  expect(fixture.main.submit).not.toHaveBeenCalled()
  expect(fixture.child.submit).not.toHaveBeenCalled()
  expect(screen.getAllByRole('alert')[0]?.textContent).toMatch(/Session changed/)
})

it('cancels the original owner on a Session rerender and ignores a late transcript after switching back', async () => {
  const fixture = await controls()
  const mounted = render(fixture.view())
  const final = Promise.withResolvers<string>()
  vi.mocked(browserCapture).mockReturnValue({ finish: () => final.promise, cancel: vi.fn() })
  await act(async () => { fireEvent.keyDown(window, { code: 'Space' }); fireEvent.keyUp(window, { code: 'Space' }) })
  fixture.selection.id = nextId
  mounted.rerender(fixture.view('', nextId))
  expect(fixture.voice.snapshot().phase).toBe('idle')
  fixture.selection.id = mainId
  mounted.rerender(fixture.view())
  await act(async () => { final.resolve('old text'); await final.promise })
  expect(fixture.main.insertText).not.toHaveBeenCalled()
  expect(fixture.child.submit).not.toHaveBeenCalled()
  expect(screen.getAllByRole('alert')[0]?.textContent).toBe(en.sessionChanged)
})

it.each(['blur', 'hidden'])('cancels Enter capture on window %s', async (reason) => {
  const fixture = await controls()
  render(fixture.view())
  const cancel = vi.fn()
  vi.mocked(browserCapture).mockReturnValue({ finish: async () => 'hello', cancel })
  const mic = screen.getAllByRole('button', { name: 'Hold to talk' })[0]!
  await act(async () => { fireEvent.keyDown(mic, { code: 'Enter' }) })
  if (reason === 'blur') fireEvent.blur(window)
  else {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    try { fireEvent(document, new Event('visibilitychange')) } finally { hidden.mockRestore() }
  }
  await act(async () => { fireEvent.keyUp(window, { code: 'Enter' }) })
  expect(cancel).toHaveBeenCalled()
  expect(fixture.voice.snapshot().phase).toBe('idle')
  expect(fixture.main.submit).not.toHaveBeenCalled()
})

it('releases Enter globally after Tab moves focus away from the microphone', async () => {
  const fixture = await controls()
  render(fixture.view())
  vi.mocked(browserCapture).mockReturnValue({ finish: async () => 'hello', cancel: vi.fn() })
  const mic = screen.getAllByRole('button', { name: 'Hold to talk' })[0]!
  mic.focus()
  await act(async () => { fireEvent.keyDown(mic, { code: 'Enter' }) })
  fireEvent.keyDown(mic, { code: 'Tab' })
  screen.getByText('Main link').focus()
  await act(async () => { fireEvent.keyUp(document.activeElement!, { code: 'Enter' }) })
  expect(fixture.voice.snapshot().phase).toBe('idle')
  expect(fixture.main.submit).toHaveBeenCalledOnce()
  expect(fixture.child.submit).not.toHaveBeenCalled()
})

it('hold Space inserts and submits; editing targets and Escape do not send', async () => {
  const ctx = new Context(), locale = new LocaleRuntime(ctx)
  locale.register('switchboard', { en, zh: en })
  const voice = new VoiceRuntime({ status: async () => ({ sttProvider: 'browser', ttsProvider: 'off', openaiKeyPresent: false,
    maxAudioBytes: 100, maxDurationSeconds: 60 }), transcribe: vi.fn(), speak: vi.fn() }, () => mainId)
  onTestFinished(async () => { voice.dispose(); await ctx.fiber.dispose() })
  await voice.load()
  const draft: InputState = { draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] }
  const input = { captureInsertion: vi.fn(() => ({ start: 0, end: 0, draftRev: 0 })),
    insertText: vi.fn(() => true), submit: vi.fn(), setDraft: vi.fn(),
    persistDraft: vi.fn(), addAttachments: vi.fn(), removeAttachment: vi.fn(), pruneAttachments: vi.fn() } satisfies InputActions
  vi.mocked(browserCapture).mockImplementation((partial) => {
    partial('hello partial')
    return { finish: async () => 'hello final', cancel: vi.fn() }
  })
  const view = render(<VoiceSurface voice={voice} events={undefined} sessionId={mainId} t={locale.bind('switchboard')}
    inputActions={input} useInput={selector => selector(draft)} />)
  await act(async () => { fireEvent.keyDown(window, { code: 'Space' }) })
  expect(screen.getByText('hello partial')).toBeTruthy()
  await act(async () => { fireEvent.keyUp(window, { code: 'Space' }) })
  expect(input.insertText).toHaveBeenCalledWith('hello final', { start: 0, end: 0, draftRev: 0 })
  expect(input.submit).toHaveBeenCalledOnce()
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Speech to text' }), { code: 'Space' })
  expect(browserCapture).toHaveBeenCalledOnce()
  await act(async () => { fireEvent.keyDown(window, { code: 'Space' }); fireEvent.keyDown(window, { code: 'Escape' }) })
  fireEvent.keyUp(window, { code: 'Space' })
  expect(input.submit).toHaveBeenCalledOnce()
  view.unmount()
  expect(voice.snapshot().phase).toBe('idle')
})
