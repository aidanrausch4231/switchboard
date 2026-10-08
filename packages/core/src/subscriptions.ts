/** Ephemeral OAuth conversations. Only the adapter can reach Host authorization or configuration. */
import { randomUUID } from 'node:crypto'
import type { SubscriptionError, SubscriptionFrame, SubscriptionId, SubscriptionList, SubscriptionPromptId, SubscriptionProvider, SubscriptionResult } from './subscription-types.ts'

/** Provider labels belong to the installed subscription catalog, not account data. */
export const subscriptionProviders: ReadonlyArray<{ id: SubscriptionId; label: string }> = [
  { id: 'openai-codex', label: 'ChatGPT' }, { id: 'anthropic', label: 'Claude Pro / Max' },
  { id: 'github-copilot', label: 'GitHub Copilot' }, { id: 'kimi-coding', label: 'Kimi' },
  { id: 'meta', label: 'Meta' }, { id: 'xai', label: 'xAI' },
]

/** Conversation inputs from the authorization adapter, never credentials. */
export interface SubscriptionInteraction {
  notify: (notice: { url?: string; code?: string }) => void
  prompt: (prompt: { kind: 'text' | 'secret' | 'select'; options?: readonly { id: string }[]; signal?: AbortSignal }) => Promise<string>
}
/** All dsh calls are isolated behind this adapter for external-plugin relocation. */
export interface SubscriptionAdapter {
  list: () => Promise<SubscriptionProvider[]>
  login: (id: SubscriptionId, interaction: SubscriptionInteraction, signal: AbortSignal) => Promise<'authorized' | 'cancelled'>
  enable: (id: SubscriptionId) => Promise<SubscriptionResult>
  logout: (id: SubscriptionId) => Promise<void>
}
interface Attempt {
  controller: AbortController
  done: Promise<void>
  frame: SubscriptionFrame
  wake: () => void
  pending?: { id: SubscriptionPromptId; options: string[]; answer: (value: string) => void } | undefined
}

function validProvider(id: SubscriptionId): boolean { return subscriptionProviders.some(row => row.id === id) }

const browserParams = ['client_id', 'response_type', 'redirect_uri', 'scope', 'code_challenge', 'code_challenge_method', 'state']
const publicParams: Record<SubscriptionId, readonly string[]> = {
  'openai-codex': [...browserParams, 'id_token_add_organizations', 'codex_cli_simplified_flow', 'originator'],
  anthropic: [...browserParams, 'code'],
  'github-copilot': ['user_code'],
  'kimi-coding': ['user_code'],
  meta: ['user_code'],
  xai: ['user_code'],
}

/** Only installed providers' public authorization parameters may reach Remote or the browser. */
function safeUrl(id: SubscriptionId, value: string | undefined): string | undefined {
  if (!value || value.length > 8192) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || [...url.searchParams].some(([key, value]) =>
        !publicParams[id].includes(key) || (key === 'code' && value !== 'true'))) return undefined
    return url.href
  } catch (_error) { return undefined }
}

/** Owns one conversation per provider and rejects stale answers across attempts. */
export class Subscriptions {
  private readonly attempts = new Map<SubscriptionId, Attempt>()
  private readonly signingOut = new Set<SubscriptionId>()
  private closed = false
  constructor(private readonly adapter: SubscriptionAdapter) {}

  /** Read only credential-presence and route facts.
   * @returns safe rows or an explicit availability failure.
   */
  async list(): Promise<SubscriptionList> {
    try { return { ok: true, providers: await this.adapter.list() } }
    catch (_error) { return { ok: false, error: 'unavailable' } }
  }

  /** Enable the catalog route without adding an API-key reference.
   * @param id - installed subscription route.
   * @returns a safe failure code or confirmation of live registration.
   */
  async enableRoute(id: SubscriptionId): Promise<SubscriptionResult> {
    if (!validProvider(id) || this.closed) return { ok: false, error: 'unavailable' }
    try { return await this.adapter.enable(id) }
    catch (_error) { return { ok: false, error: 'route' } }
  }

  /** Run an OAuth conversation; closing the stream cancels it. Success enables the route unless cancelled during credential settlement.
   * @param id - installed subscription route.
   * @param signal - caller lifetime.
   * @returns safe current-state frames, ending with authorization, cancellation or failure.
   */
  async *signIn(id: SubscriptionId, signal: AbortSignal): AsyncIterable<SubscriptionFrame> {
    const refusal: SubscriptionError | undefined = !validProvider(id) || this.closed ? 'unavailable'
      : this.attempts.has(id) || this.signingOut.has(id) ? 'busy' : undefined
    if (refusal) { yield { status: 'failed', error: refusal }; return }
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const attempt: Attempt = { controller, done: Promise.resolve(), frame: { status: 'working' }, wake: () => {} }
    this.attempts.set(id, attempt)
    const publish = (frame: SubscriptionFrame): void => { attempt.frame = frame; attempt.wake() }
    const interaction: SubscriptionInteraction = {
      notify: (notice) => {
        if (combined.aborted || attempt.frame.status !== 'working') return
        const url = safeUrl(id, notice.url)
        const code = notice.code && /^[A-Za-z0-9-]{3,32}$/.test(notice.code) ? notice.code : undefined
        publish({ ...attempt.frame, ...(url ? { url } : {}), ...(code ? { code } : {}) })
      },
      prompt: async (question) => {
        const lifetime = question.signal ? AbortSignal.any([combined, question.signal]) : combined
        lifetime.throwIfAborted()
        if (attempt.pending) throw new Error('Overlapping subscription prompts')
        const options = question.kind === 'select'
          ? (question.options ?? []).map(option => option.id).filter((option): option is 'browser' | 'device_code' | 'copy_code' => ['browser', 'device_code', 'copy_code'].includes(option)) : []
        if (question.kind === 'select' && options.length !== question.options?.length) throw new Error('Unsupported subscription login method')
        const promptId = randomUUID() as SubscriptionPromptId
        let rejectAnswer!: (reason: Error) => void
        const answer = new Promise<string>((resolve, reject) => {
          rejectAnswer = reject
          attempt.pending = { id: promptId, options, answer: resolve }
        })
        const abort = (): void => { rejectAnswer(new Error('Subscription prompt withdrawn')) }
        lifetime.addEventListener('abort', abort, { once: true })
        publish({ ...attempt.frame, prompt: { id: promptId, kind: question.kind === 'select' ? 'method' : id === 'github-copilot' ? 'enterprise' : 'code', options } })
        try { return await answer }
        finally {
          lifetime.removeEventListener('abort', abort)
          attempt.pending = undefined
          const { prompt: _prompt, ...frame } = attempt.frame
          publish(frame)
        }
      },
    }
    attempt.done = (async () => {
      try {
        const status = combined.aborted ? 'cancelled' : await this.adapter.login(id, interaction, combined)
        if (combined.aborted || status === 'cancelled') { publish({ status: 'cancelled' }); return }
        const route = await this.enableRoute(id)
        publish(route.ok ? { status: 'authorized' } : { status: 'failed', error: route.error })
      } catch (_error) { publish(combined.aborted ? { status: 'cancelled' } : { status: 'failed', error: 'signin' }) }
      finally { controller.abort(); attempt.wake() }
    })()
    try {
      let previous: SubscriptionFrame | undefined
      for (;;) {
        if (attempt.frame !== previous) {
          previous = attempt.frame
          yield structuredClone(previous)
          if (previous.status !== 'working') return
        }
        await new Promise<void>((resolve) => { attempt.wake = resolve; if (attempt.frame !== previous) resolve() })
      }
    } finally {
      controller.abort()
      await attempt.done
      if (this.attempts.get(id) === attempt) this.attempts.delete(id)
    }
  }

  /** Deliver a single answer without retaining or returning it.
   * @param id - subscription route.
   * @param promptId - exact live question identity.
   * @param value - pasted redirect/code, enterprise domain, or offered method.
   * @returns acceptance, never the pasted value.
   */
  answer(id: SubscriptionId, promptId: SubscriptionPromptId, value: string): SubscriptionResult {
    const attempt = this.attempts.get(id)
    const pending = attempt?.pending
    if (!attempt || !pending || pending.id !== promptId || typeof value !== 'string' || value.length > 8192
      || (pending.options.length > 0 && !pending.options.includes(value))) return { ok: false, error: 'answer' }
    attempt.pending = undefined
    pending.answer(value)
    return { ok: true }
  }

  /** Cancel any owned attempt before deleting the stored grant. Route configuration is retained.
   * @param id - subscription route.
   * @returns safe deletion outcome.
   */
  async signOut(id: SubscriptionId): Promise<SubscriptionResult> {
    if (!validProvider(id) || this.closed) return { ok: false, error: 'unavailable' }
    if (this.signingOut.has(id)) return { ok: false, error: 'busy' }
    this.signingOut.add(id)
    try {
      const attempt = this.attempts.get(id)
      attempt?.controller.abort()
      await attempt?.done
      await this.adapter.logout(id)
      return { ok: true }
    } catch (_error) { return { ok: false, error: 'signout' } }
    finally { this.signingOut.delete(id) }
  }

  /** Abort owned conversations and await their adapter settlements. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const attempt of this.attempts.values()) attempt.controller.abort()
    await Promise.all([...this.attempts.values()].map(attempt => attempt.done))
  }
}
