/** Accessible SVG summaries of durable automation statistics. */
import type { ReactNode } from 'react'
import type { AutomationStats } from '@switchboard/core/types'
import { type PropsLocale } from './dsh.ts'
import styles from './AutomationsPage.module.css'

type Copy = PropsLocale<'switchboardAutomations'>

/** Render the outcomes, duration trend and newest-first block grid.
 * @param props - aligned server statistics and locale dictionary.
 * @returns chart cards with named outcomes and a common-stop summary.
 */
export function AutomationCharts({ stats, t }: { stats: AutomationStats } & Copy): ReactNode {
  const runs = [...stats.runs].reverse()
  const durations = runs.filter(run => ['succeeded', 'failed', 'cancelled'].includes(run.state)).map(run => run.ms / 1000).sort((a, b) => a - b)
  const middle = Math.floor(durations.length / 2)
  const median = durations.length ? ((durations[middle] ?? 0) + (durations[Math.floor((durations.length - 1) / 2)] ?? 0)) / 2 : 0
  const max = Math.max(1, ...runs.map(run => run.ms / 1000))
  const x = (index: number) => runs.length === 1 ? 206 : 42 + index * 318 / Math.max(1, runs.length - 1)
  const y = (seconds: number) => 124 - seconds / max * 100
  const stops = new Map<string, number>()
  for (const run of runs) if (run.state === 'failed' && run.stoppedAtBlock) stops.set(run.stoppedAtBlock, (stops.get(run.stoppedAtBlock) ?? 0) + 1)
  const common = [...stops].sort((a, b) => b[1] - a[1])[0]
  return <div className={styles.charts}>
    <section className={styles.card}>
      <h3>{t('outcomes')}<span>{t('successCount', { ok: runs.filter(run => run.state === 'succeeded').length, total: runs.length })}</span></h3>
      <div className={styles.strip} role="list" aria-label={t('outcomes')}>
        {runs.map(run => <span key={run.id} role="listitem" data-state={run.state} aria-label={t('runLabel', { at: run.startedAt, state: t(run.state) })} />)}
      </div>
      <h3>{t('duration')}<span>{t('median', { seconds: Math.round(median) })}</span></h3>
      <svg className={styles.chart} viewBox="0 0 380 156" role="img" aria-label={t('chartLabel')}>
        {[0, max / 2, max].map(value => <g key={value}><line x1={42} x2={360} y1={y(value)} y2={y(value)} className={styles.axis} /><text x={0} y={y(value) + 4}>{t('seconds', { value: Math.round(value) })}</text></g>)}
        <line x1={42} x2={360} y1={y(median)} y2={y(median)} strokeDasharray="4 4" className={styles.median} />
        <polyline points={runs.map((run, index) => `${x(index)},${y(run.ms / 1000)}`).join(' ')} className={styles.line} />
        {runs.map((run, index) => <circle key={run.id} cx={x(index)} cy={y(run.ms / 1000)} r={4} data-state={run.state}><title>{t('runLabel', { at: run.startedAt, state: t(run.state) })} · {t('seconds', { value: Math.round(run.ms / 1000) })}</title></circle>)}
        <text x={42} y={151}>{t('oldest')}</text><text x={360} y={151} textAnchor="end">{t('latest')}</text>
      </svg>
    </section>
    <section className={styles.card}>
      <h3>{t('grid')}</h3><p className={styles.muted}>{t('gridHint')}</p>
      <div className={styles.gridScroll}><table className={styles.grid} aria-label={t('grid')}>
        <thead><tr><th scope="col">{t('runColumn')}</th>{stats.blocks.map(block => <th key={block} scope="col">{block}</th>)}</tr></thead>
        <tbody>{stats.runs.map((run, index) => <tr key={run.id}><th scope="row">{new Date(run.startedAt).toLocaleString()}</th>{stats.blocks.map((block, column) => {
          const state = stats.grid[index]?.[column] ?? 'unreached'
          return <td key={block}><span data-state={state} aria-label={t('cell', { block, state: t(state) })} role="img" /></td>
        })}</tr>)}</tbody>
      </table></div>
      <p className={styles.callout}>{common ? t('stop', { block: common[0], count: common[1] }) : t('noStops')}</p>
    </section>
  </div>
}
