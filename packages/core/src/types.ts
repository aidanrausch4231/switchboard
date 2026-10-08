/** Saved recipes and durable run values shared with the Remote client. */
import { type Branded } from './dsh.ts'
import { type DshTokenUsage as TokenUsage } from './dsh.ts'
import { type DshSessionId as SessionId } from './dsh.ts'
export type * from './graph-types.ts'
export type * from './subscription-types.ts'

/** Saved recipe identity. */
export type FlowId = Branded<'SwitchboardFlowId'>
/** Durable execution identity. */
export type RunId = Branded<'SwitchboardRunId'>
/** Primitive template input. */
export type InputValue = string | number | boolean
/** Declared input; omitted required defaults to true. Path inputs are absolute strings without parent traversal. */
export interface InputDef { name: string; type: 'string' | 'number' | 'boolean' | 'path'; required?: boolean; default?: InputValue }
/** Literal paths relative to cwd, not globs; commands match exactly.
 * cwd accepts {{inputs.workspace}} plus a relative subpath.
 */
export interface Scope { cwd: string; read: string[]; write: string[]; commands: string[]; web: boolean; sandbox: 'read-only' | 'workspace-write' }
/** One independently composed agent, optionally copied concurrently. */
export interface AgentBlock { kind: 'agent'; id: string; label: string; harness: 'dsh' | 'claude-code' | 'codex'; provider?: string; model?: string; prompt: string; scope: Scope; copies?: number; concurrency?: number }
/** Host-owned verification commands. */
export interface ChecksBlock { kind: 'checks'; id: string; label: string; commands: string[]; cwd: string }
/** Human approval checkpoint. */
export interface GateBlock { kind: 'gate'; id: string; label: string }
/** Executable recipe node. */
export type Block = AgentBlock | ChecksBlock | GateBlock
/** Loop rounds count additional executions; refuted means output starts with REFUTED. */
export interface Edge { from: string; to: string; kind: 'next' | 'loop'; on?: 'failed' | 'refuted'; maxRounds?: number }
/** Saved, versioned execution recipe. */
export interface Flow {
  id: FlowId
  name: string
  version: number
  inputs: InputDef[]
  blocks: Block[]
  edges: Edge[]
  limits: { maxCostTokens?: number; maxMinutes?: number; maxHops?: number }
}
/** Editor-only positions, persisted separately from executable recipes. */
export interface FlowLayout { positions: { id: string; x: number; y: number }[] }
/** Validation/preflight diagnostic. */
export interface PreflightItem { level: 'ok' | 'warn' | 'error'; code: string; message: string; blockId?: string }
/** Launch admission result; errors prohibit execution. */
export interface PreflightResult { ok: boolean; items: PreflightItem[] }
/** Durable run lifecycle. */
export type RunState = 'queued' | 'running' | 'needs-you' | 'succeeded' | 'failed' | 'cancelled'
/** One block copy execution, including repeated loop rounds. */
export interface Attempt {
  blockId: string
  copy: number
  round: number
  state: RunState
  startedAt: string
  endedAt?: string
  output: string
  sessionId?: SessionId
  usage?: TokenUsage
  error?: string
  refuted?: boolean
}
/** Ordered durable state transition. */
export interface TimelineEvent { at: string; state: RunState; blockId?: string; message: string }
/** Run captures its recipe with resolved working directories so later edits cannot change active work. */
export interface FlowRun {
  id: RunId
  flowId: FlowId
  flow: Flow
  inputs: Record<string, InputValue>
  state: RunState
  attempts: Attempt[]
  timeline: TimelineEvent[]
  createdAt: string
  updatedAt: string
  cursor: number
  rounds: Record<string, number>
  outputs: Record<string, string>
  /** Observed dsh tokens only; attempts without usage are unavailable, not zero-cost. */
  tokens: number
  /** Durable cancellation intent; recovery cancels unfinished runs instead of restoring their gates. */
  cancelRequested?: boolean
  error?: string
}
/** A baseline and subsequent durable replacement updates; sequence is timeline length. */
export interface RunFrame { type: 'snapshot' | 'update'; run: FlowRun }
/** Saved automation identity. */
export type AutomationId = Branded<'SwitchboardAutomationId'>
/** Host calendar rule, or explicit execution only. */
export type AutomationSchedule = { kind: 'cron'; expr: string; tz: string } | { kind: 'manual' }
/** User-editable automation fields; identity omission creates a new automation. */
export interface AutomationDraft {
  id?: AutomationId
  name: string
  flowId: FlowId
  inputs: Record<string, InputValue>
  schedule: AutomationSchedule
  enabled: boolean
}
/** Persisted schedule; the Host owns identity and occurrence watermarks. */
export interface Automation extends AutomationDraft {
  id: AutomationId
  createdAt: string
  lastFiredAt: string | null
}
/** One reserved firing; skipped and admission-failed firings have no FlowRun. */
export interface AutomationEvent { id: RunId; at: string; state: 'pending' | 'started' | 'skipped' | 'failed'; error?: string }
/** Automation and its durable firing journal, stored together. */
export interface AutomationRecord { automation: Automation; events: AutomationEvent[] }
/** Block outcome across copies and loop rounds. */
export type AutomationCell = 'unreached' | 'running' | 'needs-you' | 'succeeded' | 'failed' | 'recovered' | 'cancelled'
/** Bounded outcome history; pending reservations have no streamable FlowRun. Grid rows align with runs, columns with blocks. */
export interface AutomationStats {
  runs: { id: RunId; state: RunState | 'pending' | 'skipped'; startedAt: string; ms: number; stoppedAtBlock?: string }[]
  blocks: string[]
  grid: AutomationCell[][]
}
/** Connectivity response independent of provider availability. */
export interface PingResult { ok: true; version: string; time: string }
/** Bound execution results before persisting. */
export interface BlockResult { output: string; sessionId?: SessionId; usage?: TokenUsage; error?: string; refuted?: boolean }

/** Safe speech capability facts; browser support is detected by the Client. */
export interface VoiceStatus {
  sttProvider: 'browser' | 'openai'
  ttsProvider: 'off' | 'browser' | 'openai'
  openaiKeyPresent: boolean
  maxAudioBytes: number
  maxDurationSeconds: number
}

/** Canonical base64 audio transported over the authenticated Remote. */
export interface VoiceAudio { base64: string; mime: string }

/** Final recognized text; partial browser text is never sent to the Host. */
export interface VoiceTranscript { text: string }

/** Provider failures contain only sanitized user-facing copy. */
export type VoiceResult<T> = { ok: true; value: T } | { ok: false; error: string }
