/** Typed recipe controls; drafts remain local until the editor saves. */
import { Input, Checkbox } from './dsh.ts'
import type { AgentBlock, Block, Edge } from '@switchboard/core/types'
import type { Copy } from './flow-types.ts'
import styles from './Flows.module.css'

/** One labeled text field.
 * @param props - localized label, current text and edit callback.
 * @returns input or multiline editor.
 */
export function Field({ label, value, change, multiline = false }: {
  label: string
  value: string
  change: (value: string) => void
  multiline?: boolean
}) {
  return <label className={styles.field}><span>{label}</span>{multiline
    ? <textarea value={value} onChange={(event) =>{  change(event.target.value) }} rows={4} />
    : <Input value={value} onChange={(event) =>{  change(event.target.value) }} />}</label>
}
const lines = (value: string): string[] => value === '' ? [] : value.split('\n')

/** Edit the selected executable block.
 * @param props - selected block and immutable replacement callback.
 * @returns kind-specific controls.
 */
export function BlockInspector({ block, change, t }: { block: Block; change: (block: Block) => void; t: Copy }) {
  const agent = (patch: Partial<AgentBlock>): void => { if (block.kind === 'agent') change({ ...block, ...patch }) }
  return <>
    <Field label={t('label')} value={block.label} change={(label) =>{  change({ ...block, label }) }} />
    {block.kind === 'agent' && <>
      <label className={styles.field}>{t('harness')}<select value={block.harness} onChange={(event) =>{  agent({ harness: event.target.value as AgentBlock['harness'] }) }}>
        {(['dsh', 'claude-code', 'codex'] as const).map(kind => <option key={kind} value={kind}>{t(kind)}</option>)}
      </select></label>
      <Field label={t('provider')} value={block.provider ?? ''} change={(provider) => { const { provider: _provider, ...rest } = block; change(provider ? { ...rest, provider } : rest) }} />
      <Field label={t('model')} value={block.model ?? ''} change={(model) => { const { model: _model, ...rest } = block; change(model ? { ...rest, model } : rest) }} />
      <Field label={t('prompt')} value={block.prompt} change={(prompt) =>{  agent({ prompt }) }} multiline />
      <Field label={t('cwd')} value={block.scope.cwd} change={(cwd) =>{  agent({ scope: { ...block.scope, cwd } }) }} />
      {(['read', 'write', 'commands'] as const).map(key => <Field key={key} label={t(key)} value={block.scope[key].join('\n')} change={(value) =>{  agent({ scope: { ...block.scope, [key]: lines(value) } }) }} multiline />)}
      <Checkbox label={t('web')} checked={block.scope.web} onChange={(web) =>{  agent({ scope: { ...block.scope, web } }) }} />
      <label className={styles.field}>{t('sandbox')}<select value={block.scope.sandbox} onChange={(event) =>{  agent({ scope: { ...block.scope, sandbox: event.target.value as AgentBlock['scope']['sandbox'] } }) }}>
        {(['read-only', 'workspace-write'] as const).map(mode => <option key={mode} value={mode}>{t(mode)}</option>)}
      </select></label>
      {(['copies', 'concurrency'] as const).map(key => <label className={styles.field} key={key}>{t(key)}<Input type="number" min={1} step={1} value={block[key] ?? 1} onChange={(event) =>{  agent({ [key]: Number(event.target.value) }) }} /></label>)}
    </>}
    {block.kind === 'checks' && <>
      <Field label={t('cwd')} value={block.cwd} change={(cwd) =>{  change({ ...block, cwd }) }} />
      <Field label={t('commands')} value={block.commands.join('\n')} change={(value) =>{  change({ ...block, commands: lines(value) }) }} multiline />
    </>}
  </>
}

/** Set ordinary or bounded retry semantics for the selected edge.
 * @param props - edge and immutable replacement callback.
 * @returns loop controls.
 */
export function EdgeInspector({ edge, change, t }: { edge: Edge; change: (edge: Edge) => void; t: Copy }) {
  return <>
    <p>{edge.from} → {edge.to}</p>
    <Checkbox label={t('loop')} checked={edge.kind === 'loop'} onChange={(loop) =>{  change(loop ? { ...edge, kind: 'loop', on: 'refuted', maxRounds: 1 } : { from: edge.from, to: edge.to, kind: 'next' }) }} />
    {edge.kind === 'loop' && <>
      <label className={styles.field}>{t('condition')}<select value={edge.on} onChange={(event) =>{  change({ ...edge, on: event.target.value as 'failed' | 'refuted' }) }}>
        <option value="refuted">{t('refuted')}</option><option value="failed">{t('failed')}</option>
      </select></label>
      <label className={styles.field}>{t('maxRounds')}<Input type="number" min={1} step={1} value={edge.maxRounds ?? 1} onChange={(event) =>{  change({ ...edge, maxRounds: Number(event.target.value) }) }} /></label>
    </>}
  </>
}
