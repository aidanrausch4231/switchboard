/** Voice Remote adapter and reversible page/composer registrations. */
import { type Context } from '../dsh.ts'


import { type MainPanelId } from '../dsh.ts'
import { type SessionId } from '../dsh.ts'
import { ComposerVoice, VoiceIcon, VoicePage, VoiceSurface, type VoiceFace } from './Voice.tsx'
import { VoiceRuntime } from './runtime.ts'

/**
 * Register voice against existing Session input actions; no upstream composer replacement.
 * @param ctx - presentation context with Switchboard Remote, slots, and locale.
 */
export function registerVoice(ctx: Context): void {
  const remote = ctx.remote.switchboard
  const voice = new VoiceRuntime({
    status: async () => { const result = await remote.voiceStatus(); if (!result.ok) throw new Error('statusFailed'); return result.value },
    transcribe: async (audio, signal) => {
      const result = await remote.voiceTranscribe(audio, signal)
      if (!result.ok) throw new Error('capture')
      if (!result.value.ok) throw new Error(result.value.error)
      return result.value.value.text
    },
    speak: async (text, signal) => {
      const result = await remote.voiceSpeak(text, signal)
      if (!result.ok) throw new Error('playback')
      if (!result.value.ok) throw new Error(result.value.error)
      return result.value.value
    },
  }, () => Object.values(ctx.get('sessions')?.list.getSnapshot().byId ?? {})
    .find(row => (row.retainedBy.mainView ?? 0) > 0)?.id)
  ctx.effect(() => () => { voice.dispose() })
  ctx.inject(['sessions'], (scope) => {
    scope.effect(() => scope.sessions.list.subscribe(() => { voice.checkSession() }))
  })
  void voice.load()
  const t = ctx.locale.bind('switchboard')
  const panel = 'switchboard.voice' as MainPanelId
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panel, order: 21, label: () => t('voice'), locale: 'switchboard',
  }, VoiceIcon))
  const face = (sessionId: SessionId | undefined): VoiceFace => ({
    voice, sessionId, events: sessionId ? ctx.get('sessions')?.binding(sessionId)?.eventSource : undefined,
  })
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: panel,
      children: { 'switchboard.voice': { kind: 'single', scope: 'session-maybe' } },
    }, VoicePage)
    yield ctx.slots.register({ name: 'switchboard.voice', locale: 'switchboard', inject: face }, VoiceSurface)
  })
  ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
    name: 'conversation.input.activity', locale: 'switchboard', inject: face,
  }, ComposerVoice))
}
