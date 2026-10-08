/** Data and commands shared by the editor and its registration. */
import type { Flow, FlowId, FlowLayout, FlowRun, InputValue, PreflightResult, RunId } from '@switchboard/core/types'
import { type PropsLocale } from './dsh.ts'

/** Typed translation shared by internal controls. */
export type Copy = PropsLocale<'switchboard'>['t']
/** Plain editor commands; Remote envelopes are resolved in the registration. */
export interface FlowsFace {
  workspace: () => string | undefined
  listFlows: () => Promise<Flow[]>
  saveFlow: (flow: Flow) => Promise<Flow>
  getLayout: (id: FlowId) => Promise<FlowLayout>
  saveLayout: (id: FlowId, layout: FlowLayout) => Promise<FlowLayout>
  preflight: (flow: Flow, inputs: Record<string, InputValue>) => Promise<PreflightResult>
  validate: (flow: Flow) => Promise<PreflightResult>
  start: (id: FlowId, inputs: Record<string, InputValue>) => Promise<FlowRun>
  listRuns: () => Promise<FlowRun[]>
  openRun: (run: FlowRun) => Promise<void>
}
/** Live run commands, shared by dock and chat card. */
export interface RunFace {
  watch: (id: RunId) => () => void
  approve: (id: RunId, blockId: string, approve: boolean) => Promise<boolean>
  cancel: (id: RunId) => Promise<FlowRun>
}
