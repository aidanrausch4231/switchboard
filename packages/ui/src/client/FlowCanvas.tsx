/** XYFlow canvas shared by the editable recipe and read-only run view. */
import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { ReactFlow, Handle, Position, Background, MarkerType, BaseEdge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance, type Connection } from '@xyflow/react'
import { Button } from './dsh.ts'
import type { Flow, FlowLayout, FlowRun, PreflightItem } from '@switchboard/core/types'
import type { Copy } from './flow-types.ts'
import { blockState } from './run-state.ts'
import '@xyflow/react/dist/base.css'
import styles from './Flows.module.css'

type BlockNode = Node<{ label: string; detail: string; state: string; issues: string[] }, 'block'>
function BlockView({ data }: NodeProps<BlockNode>) {
  return <div className={styles.block} data-state={data.state}>
    <Handle type="target" position={Position.Top} />
    <strong>{data.label}</strong><small>{data.detail}</small>
    {data.issues.map((issue, index) => <small role="alert" key={index}>{issue}</small>)}
    <Handle type="source" position={Position.Bottom} />
    <Handle id="loop-out" type="source" position={Position.Right} className={styles.loopOut} />
    <Handle id="loop-in" type="target" position={Position.Right} className={styles.loopIn} />
  </div>
}
const nodeTypes = { block: BlockView }
function LoopView({ sourceX, sourceY, targetX, targetY, ...props }: EdgeProps) {
  const x = Math.max(sourceX, targetX) + 160
  const path = `M ${sourceX} ${sourceY} C ${x} ${sourceY}, ${x} ${targetY}, ${targetX} ${targetY}`
  return <BaseEdge path={path} {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})} label={props.label}
    labelX={(sourceX + targetX) / 8 + x * 0.75} labelY={(sourceY + targetY) / 2} />
}
const edgeTypes = { loop: LoopView }

/** Saved placements win; unsaved nodes occupy deterministic topological columns.
 * @param flow - executable recipe.
 * @param layout - optional saved editor placement.
 * @returns positions for every current block.
 */
export function positionsFor(flow: Flow, layout: FlowLayout): FlowLayout {
  const levels = new Map<string, number>()
  const pending = new Set(flow.blocks.map(block => block.id))
  while (pending.size) {
    const next = [...pending].find(id => !flow.edges.some(edge => edge.kind === 'next' && edge.to === id && pending.has(edge.from)))
    if (next === undefined) break
    levels.set(next, Math.max(0, ...flow.edges.filter(edge => edge.kind === 'next' && edge.to === next).map(edge => (levels.get(edge.from) ?? 0) + 1)))
    pending.delete(next)
  }
  const rows = new Map<number, number>()
  return { positions: flow.blocks.map((block) => {
    const level = levels.get(block.id) ?? 0
    const row = rows.get(level) ?? 0
    rows.set(level, row + 1)
    return layout.positions.find(position => position.id === block.id) ?? { id: block.id, x: 40 + row * 240, y: 50 + level * 140 }
  }) }
}

/** One inspector selection; node and edge updates share a single atomic state. */
export type CanvasSelection = { kind: 'node'; id: string } | { kind: 'edge'; index: number } | undefined

/** Graph inputs and editable gestures. */
export interface CanvasProps {
  flow: Flow
  layout: FlowLayout
  t: Copy
  run?: FlowRun
  issues?: PreflightItem[]
  selection?: CanvasSelection
  select?: Dispatch<SetStateAction<CanvasSelection>>
  connect?(connection: Connection): void
  move?(layout: FlowLayout): void
  remove?(ids: string[], edges: number[]): void
  drop?(kind: string, position: { x: number; y: number }): void
}
/** Render a graph without granting mutation callbacks to the run view.
 * @param props - recipe, presentation and optional editor gestures.
 * @returns themed canvas.
 */
export function FlowCanvas(props: CanvasProps) {
  const { flow, layout, run, t } = props
  const [instance, setInstance] = useState<ReactFlowInstance<BlockNode> | null>(null)
  const positions = useMemo(() => positionsFor(flow, layout), [flow, layout])
  const nodes: BlockNode[] = flow.blocks.map((block) => {
    const status = run ? blockState(run, block.id) : { state: 'queued' as const, attempts: 0, round: 0 }
    const state = status.state
    const detail = run ? `${t(state)} · ${t('attempts')} ${status.attempts} · ${t('rounds')} ${status.round}`
      : block.kind === 'agent' ? `${t(block.harness)} · ${block.model ?? t('model')} × ${block.copies ?? 1}` : t(block.kind)
    const position = positions.positions.find(value => value.id === block.id) as FlowLayout['positions'][number]
    return { id: block.id, type: 'block', position, selected: props.selection?.kind === 'node' && props.selection.id === block.id,
      data: { label: block.label, detail, state: run ? state : 'queued', issues: props.issues?.filter(item => item.blockId === block.id).map(item => item.message) ?? [] } }
  })
  const edges = flow.edges.map((edge, index) => ({ id: String(index), source: edge.from, target: edge.to,
    selected: props.selection?.kind === 'edge' && props.selection.index === index, type: edge.kind === 'loop' ? 'loop' : 'smoothstep',
    ...(edge.kind === 'loop' ? { sourceHandle: 'loop-out', targetHandle: 'loop-in' } : {}),
    className: (edge.kind === 'loop' ? styles.loopEdge : styles.nextEdge) ?? '',
    markerEnd: { type: MarkerType.ArrowClosed },
    label: edge.kind === 'loop' ? `${t(edge.on ?? 'refuted')} · ${edge.maxRounds ?? 1}` : undefined,
  }))
  return <div className={styles.canvas} aria-label={t('canvas')}
    onDragOver={(event) => { if (props.drop) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
    onDrop={(event) => { event.preventDefault(); const kind = event.dataTransfer.getData('application/switchboard-block'); if (kind && instance) props.drop?.(kind, instance.screenToFlowPosition({ x: event.clientX, y: event.clientY })) }}>
    <ReactFlow<BlockNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setInstance}
      fitView minZoom={0.2} maxZoom={2} nodesDraggable={!!props.move} nodesConnectable={!!props.connect}
      deleteKeyCode={props.remove ? ['Backspace', 'Delete'] : null}
      onConnect={connection => props.connect?.(connection)}
      onNodeClick={(_event, node) => props.select?.({ kind: 'node', id: node.id })} onEdgeClick={(_event, edge) => props.select?.({ kind: 'edge', index: Number(edge.id) })}
      onPaneClick={() => props.select?.(undefined)}
      onEdgesChange={(changes) => {
        const selected = changes.find(change => change.type === 'select' && change.selected)
        props.select?.(current => selected?.type === 'select' ? { kind: 'edge', index: Number(selected.id) }
          : current?.kind === 'edge' && changes.some(change => change.type === 'select' && !change.selected && Number(change.id) === current.index) ? undefined : current)
      }}
      onNodesChange={(changes) => {
        const selected = changes.find(change => change.type === 'select' && change.selected)
        props.select?.(current => selected?.type === 'select' ? { kind: 'node', id: selected.id }
          : current?.kind === 'node' && changes.some(change => change.type === 'select' && !change.selected && change.id === current.id) ? undefined : current)
        const moved = changes.filter(change => change.type === 'position')
        if (moved.length) props.move?.({ positions: positions.positions.map((position) => {
          const change = moved.find(item => item.id === position.id)
          return change?.type === 'position' && change.position ? { id: position.id, ...change.position } : position
        }) })
      }}
      onDelete={({ nodes: deletedNodes, edges: deletedEdges }) => {
        props.remove?.(deletedNodes.map(node => node.id), deletedEdges.map(edge => Number(edge.id)))
      }}
      ariaLabelConfig={{ 'node.a11yDescription.default': t('nodeDescription'), 'node.a11yDescription.keyboardDisabled': t('nodeDescription'), 'edge.a11yDescription.default': t('edgeDescription'), 'node.a11yDescription.ariaLiveMessage': () => t('nodeMoved') }}>
      <Background />
    </ReactFlow>
    <div className={styles.canvasControls}>
      <Button size="sm" variant="outline" disabled={!instance} onClick={() => { void instance?.fitView() }}>{t('fit')}</Button>
      <Button size="sm" variant="outline" aria-label={t('zoomIn')} onClick={() => { void instance?.zoomIn() }}>+</Button>
      <Button size="sm" variant="outline" aria-label={t('zoomOut')} onClick={() => { void instance?.zoomOut() }}>−</Button>
    </div>
  </div>
}
