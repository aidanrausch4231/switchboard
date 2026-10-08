/** Safe subscription views; credentials and pasted answers never enter these types. */
import type { Branded } from './dsh.ts'

/** The six installed pi-ai subscription routes. */
export type SubscriptionId = 'openai-codex' | 'anthropic' | 'github-copilot' | 'kimi-coding' | 'meta' | 'xai'
/** Identity of one pending question, invalidated when answered or withdrawn. */
export type SubscriptionPromptId = Branded<'SubscriptionPromptId'>
/** Presence is not a check of provider entitlement or token validity. */
export interface SubscriptionProvider {
  id: SubscriptionId
  label: string
  /** Stock dsh cannot complete ChatGPT sign-in until its pi-ai runtime is upgraded. */
  needsPiAi?: boolean
  signedIn: boolean
  routeEnabled: boolean
}
/** Static, localized prompt purposes; provider prose is never forwarded. */
export interface SubscriptionPrompt {
  id: SubscriptionPromptId
  kind: 'method' | 'enterprise' | 'code'
  options: Array<'browser' | 'device_code' | 'copy_code'>
}
/** Latest interaction state, not a transcript of the authorization exchange. */
export interface SubscriptionFrame {
  status: 'working' | 'authorized' | 'cancelled' | 'failed'
  url?: string
  code?: string
  prompt?: SubscriptionPrompt
  error?: SubscriptionError
}
/** Fixed error codes prevent provider responses or credentials leaking into diagnostics. */
export type SubscriptionError = 'unavailable' | 'busy' | 'signin' | 'route' | 'apiKey' | 'signout' | 'answer'
/** Mutations never return provider diagnostics. */
export type SubscriptionResult = { ok: true } | { ok: false; error: SubscriptionError }
/** List failures are explicit and keep existing UI rows visible. */
export type SubscriptionList = { ok: true; providers: SubscriptionProvider[] } | { ok: false; error: SubscriptionError }
