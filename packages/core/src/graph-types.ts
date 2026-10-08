/** Graph routing, scoped lead orchestration, and durable inbox records. */
import { type Branded } from './dsh.ts'
import type { AgentBlock } from './types.ts'

/** Saved domain graph identity. */
export type GraphId = Branded<'SwitchboardGraphId'>
/** Durable inbox card identity. */
export type CardId = Branded<'SwitchboardCardId'>
/** Jev can select a graph, the Council, or human review. */
export type GraphTarget = GraphId | 'council' | 'you'
/** One routing decision, including availability and confidence refusals. */
export interface CardRoute { target: GraphTarget; confidence: number; reason: string; router: 'jev' | 'fallback' | 'rule' }
/** Domain lead with an explicit memory directory. Native leads fail admission until scoped tools are supported. */
export interface GraphLead { harness: 'dsh' | 'claude-code'; provider?: string; model?: string; memoryDir: string; instructions: string }
/** A saved Flow reference or one independently scoped agent block. */
export type GraphNode = { id: string; description: string } & ({ kind: 'flow'; flowId: import('./types.ts').FlowId } | { kind: 'agent'; agent: AgentBlock })
/** A lead dispatches only listed nodes and asks only adjacent leads. */
export interface Graph {
  id: GraphId
  name: string
  description: string
  color: string
  lead: GraphLead
  nodes: GraphNode[]
  edges: GraphId[]
  rules: { maxCostTokens: number; prodWrites: 'never' }
}
/** States shown on the card board; failed cards remain in Needs you. */
export type CardState = 'new' | 'routing' | 'running' | 'needs-you' | 'done' | 'failed'
/** Incoming need. Workspace is required before dispatch and never guessed from the Host cwd. */
export interface CardInput { title: string; body: string; source: 'chat' | 'voice' | 'manual' | 'failed-run' | 'webhook'; workspace?: string | undefined }
/** A durable card preserves cumulative budgets across reroutes and human decisions. */
export interface Card extends CardInput {
  id: CardId
  state: CardState
  route?: CardRoute
  hops: number
  costTokens: number
  usageUnavailable?: boolean
  maxCostTokens: number
  timeline: { at: string; actor: string; kind: string; text: string }[]
  result?: string
}
/** Full replacements coalesce without dropping timeline entries. */
export interface CardFrame { cards: Card[] }
/** Direct router calls retain exact inputs and outcomes in Switchboard storage. */
export interface RouterRequest { provider: string; model: string; prompt: string; cardId?: CardId }
/** Each call has its own key; cardId associates retries and bounces with a card. */
export interface RouterRecord {
  request: RouterRequest
  answer?: { text: string; tokens: number; error?: string }
}
