/** Shared push-to-talk control for the resident composer and the Voice page. */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { type PropsLocale, type PropsRenderSlots, type PropsRuntime } from '../dsh.ts'
import { type InputActions, type InputState } from '../dsh.ts'
import { type SessionEventSource } from '../dsh.ts'
import { Button, IconMicrophoneOutlineRegular, Tooltip } from '../dsh.ts'
import type { SwitchboardKey } from '../locales.ts'
import { en } from '../locales.ts'
import { type SessionId } from '../dsh.ts'
import { supportsRecognition } from './capture.ts'
import type { VoiceControlBinding, VoiceRuntime } from './runtime.ts'
import { observeReplies } from './replies.ts'
import css from './Voice.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Voice page uses the selected Session's normal input actions. */
    'switchboard.voice': { kind: 'single'; scope: 'session-maybe' }
  }
}

/** Entry-owned browser runtime and selected Session event feed. */
export interface VoiceFace { voice: VoiceRuntime; events: SessionEventSource | undefined; sessionId: SessionId | undefined }

type ControlProps = VoiceFace & PropsLocale<'switchboard'> & {
  input: InputActions | undefined
  draft: InputState | undefined
  page: boolean
  locked?: boolean
}

function VoiceControl({ voice, events, input, draft, page, locked, t, sessionId }: ControlProps) {
  const state = useSyncExternalStore(voice.subscribe, voice.snapshot)
  const supported = supportsRecognition()
  const ready = Boolean(input && draft?.phase === 'plain' && !draft.draft.trim() && !draft.attachmentIds.length && !locked)
  const element = useRef<HTMLElement>(null)
  const latest = useRef({ input, sessionId, ready })
  latest.current = { input, sessionId, ready }
  const control = useRef<VoiceControlBinding>({
    element: () => element.current, input: () => latest.current.input,
    sessionId: () => latest.current.sessionId, ready: () => latest.current.ready,
  }).current
  const start = (key?: string) => { voice.record(control, key) }
  useEffect(() => voice.bindControl(control), [voice, control])
  useEffect(() => { voice.checkSession() }, [voice, sessionId])
  useEffect(() => events ? observeReplies(events, (text) => { void voice.speak(text, control) }) : undefined, [voice, events, control])
  const active = state.phase !== 'idle'
  const error = state.error in en ? t(state.error as SwitchboardKey) : state.error
  return <section ref={element} className={page ? css.page : css.compact} aria-label={t('voice')}>
    {page && <header><p>{t('title')}</p><h1>{t('voice')}</h1><p>{t('voiceHelp')}</p></header>}
    <div className={css.console}>
      <Tooltip label={t('hold')} disabled={page || active} side="top" portal>
        <Button className={page ? css.mic : undefined} type="button" aria-label={t('hold')} aria-pressed={active}
          disabled={!state.status || (!ready && !active) || state.phase === 'transcribing'}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); start()
          }}
          onPointerUp={() => { voice.release() }} onPointerCancel={() => { voice.cancel() }}
          onLostPointerCapture={() => { if (voice.snapshot().phase === 'recording' || voice.snapshot().phase === 'requesting') voice.release() }}
          onKeyDown={(event) => { if ((event.code === 'Space' || event.code === 'Enter') && !event.repeat) { event.preventDefault(); start(event.code) } }}
          onContextMenu={(event) => { event.preventDefault() }}>
          <IconMicrophoneOutlineRegular size={page ? 32 : 18} />{page && t(active ? 'release' : 'hold')}
        </Button>
      </Tooltip>
      <span role="status" aria-live="polite">{t(state.phase)}</span>
      {active && <Button onClick={() => { voice.cancel() }}>{t('cancel')}</Button>}
    </div>
    {state.partial && <p className={css.transcript} aria-live="polite">{state.partial}</p>}
    {error && <p role="alert">{error}</p>}
    {page && <>
      {!ready && <p>{t(input ? 'draftFirst' : 'sessionFirst')}</p>}
      <div className={css.settings}>
        <h2>{t('voiceSettings')}</h2>
        <label>{t('recognition')}<select aria-label={t('recognition')} value={state.stt} disabled={!state.status}
          onChange={(event) => { voice.configure(event.target.value === 'openai' ? 'openai' : 'browser', state.tts) }}>
          <option value="browser">{t('browser')}</option><option value="openai">{t('openai')}</option>
        </select></label>
        <label>{t('spokenReplies')}<select aria-label={t('spokenReplies')} value={state.tts} disabled={!state.status}
          onChange={(event) => { voice.configure(state.stt, event.target.value === 'openai' ? 'openai' : event.target.value === 'browser' ? 'browser' : 'off') }}>
          <option value="off">{t('off')}</option><option value="browser">{t('browser')}</option><option value="openai">{t('openai')}</option>
        </select></label>
        <p>{t('browserSupport')}: {t(supported ? 'yes' : 'no')}</p>
        <p>{t('captureSupport')}: {t(typeof MediaRecorder !== 'undefined' && 'mediaDevices' in navigator ? 'yes' : 'no')}</p>
        <p>{t('keyPresent')}: {state.status ? t(state.status.openaiKeyPresent ? 'yes' : 'no') : t('unavailable')}</p>
        <p>{t('voicePrivacy')}</p>
        {!state.status && <Button onClick={() => { void voice.load() }}>{t('retry')}</Button>}
      </div>
      <h2>{t('transcriptHistory')}</h2>
      {state.history.length ? <ol>{state.history.map((text, index) => <li key={index}>{text}</li>)}</ol> : <p>{t('noTranscripts')}</p>}
    </>}
  </section>
}

/** Render the page's Session-aware child without taking over Conversation. */
export function VoicePage({ renderSlot }: PropsRenderSlots<'switchboard.voice'>) { return renderSlot('switchboard.voice', {}) }

/** Render the selected Session's voice page, including the no-Session settings state. */
export function VoiceSurface(props: Pick<PropsRuntime<'switchboard.voice'>, 'useInput' | 'inputActions'> & PropsLocale<'switchboard'> & VoiceFace) {
  const draft = props.useInput(value => value)
  return <VoiceControl {...props} input={props.inputActions} draft={draft} page />
}

/** Render a compact voice button through the existing composer activity slot. */
export function ComposerVoice(props: Pick<PropsRuntime<'conversation.input.activity'>, 'useInput' | 'inputActions' | 'onActiveChange' | 'locked'> & PropsLocale<'switchboard'> & VoiceFace) {
  const draft = props.useInput(value => value)
  const state = useSyncExternalStore(props.voice.subscribe, props.voice.snapshot)
  const { onActiveChange } = props
  useEffect(() => { onActiveChange(state.phase !== 'idle'); return () => { onActiveChange(false) } }, [onActiveChange, state.phase])
  return <VoiceControl {...props} input={props.inputActions} draft={draft} page={false} />
}

/** Use the shared microphone glyph for sidebar navigation. */
export function VoiceIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <IconMicrophoneOutlineRegular size={size} /> }
