/** Original dusk chamber artwork and the Council's persisted answers. */
import type { CSSProperties, ReactNode } from 'react'
import { Button } from './dsh.ts'
import { type PropsLocale } from './dsh.ts'
import type { CouncilSession, Seat } from '@switchboard/council/types'
import type { ChamberState } from './council-state.ts'
import styles from './CouncilPage.module.css'

type Props = PropsLocale<'switchboardCouncil'> & {
  view?: ChamberState | undefined
  round?: number | undefined
  onFollowUp?: ((session: CouncilSession) => void) | undefined
}
const positions = [[18, 28], [82, 28], [16, 65], [84, 65], [50, 70]] as const

/**
 * Render a single-look dark scene; text and controls remain usable outside the artwork.
 * @param props - live projection, optional historical round, and localized labels.
 * @returns chamber, full answers, and the chair's ruling when available.
 */
export function CouncilChamber({ view, round, t, onFollowUp }: Props): ReactNode {
  const session = view?.session
  const currentRound = round ?? session?.rounds.at(-1)?.round ?? 1
  const answers = session?.rounds.find(value => value.round === currentRound)?.answers ?? []
  const seats = session ? [...session.seats].sort((a, b) => Number(b.id === session.chair) - Number(a.id === session.chair)) : []
  const live = session?.state === 'running' || session?.state === 'queued'
  function usage(seat: Seat): string {
    if (!session || seat.kind === 'subagent') return t('usageUnavailable')
    const records = [
      ...session.rounds.flatMap(value => value.answers), ...session.votes ?? [], ...session.chairAnswers ?? [],
    ].filter(value => value.seatId === seat.id)
    if (!records.length) return live ? t('usagePending') : t('usageUnavailable')
    const known = records.flatMap(value => value.usage ? [value.usage] : [])
    if (!known.length) return t('usageUnavailable')
    const count = known.reduce((sum, value) => sum + value.inputTokens + value.outputTokens, 0)
    return t('usage', { count }) + (known.length < records.length ? ` · ${t('incompleteUsage')}` : '')
  }
  return <div className={styles.chamberContainer}>
    <div className={styles.chamber} data-list={seats.length > 6 || undefined}>
      <div className={styles.scene} aria-hidden="true">
        <div className={styles.sky} />
        <svg className={styles.skyline} viewBox="0 0 1200 240" preserveAspectRatio="none">
          <path d="M0 240V134H45V99H80V155H130V68H159V48H169V68H190V165H227V110H262V135H303V40H316V20H326V40H345V140H380V94H411V165H452V74H470V52H484V74H506V148H547V103H583V170H625V59H653V91H680V153H717V126H758V40H774V12H782V40H809V151H846V85H867V62H879V85H905V141H944V119H974V167H1015V68H1050V138H1094V100H1124V151H1165V121H1200V240Z" />
          <g className={styles.windows}><path d="M144 88h5v8h-5zm169-26h5v8h-5zm154 34h5v8h-5zm169-15h5v8h-5zm137-12h5v8h-5zm91 42h5v8h-5zm168-22h5v8h-5z" /></g>
        </svg>
        <div className={styles.mullions} /><div className={styles.floor} /><div className={styles.ring} />
      </div>
      <div className={styles.hologram}>
        <span>{t('question')}</span><p>{session?.question ?? t('emptyChamber')}</p>
        <small>{session ? t('round', { round: currentRound, total: session.roundCount }) : t('title')} · {t('readOnly')}</small>
      </div>
      <div className={styles.seats}>
        {seats.map((seat, index) => {
          const answer = answers.find(value => value.seatId === seat.id)
          const priorFailure = session?.rounds.filter(value => value.round < currentRound).flatMap(value => value.answers)
            .find(value => value.seatId === seat.id && value.state === 'failed')
          const thinking = view?.thinking.some(value => value.seatId === seat.id && value.round === currentRound)
          const state = answer?.state ?? (priorFailure ? 'excluded' : thinking ? 'thinking' : live ? 'waiting' : 'stopped')
          const vote = session?.votes?.find(value => value.seatId === seat.id)
          const chair = seat.id === session?.chair
          const position = positions[index - 1] ?? [50, 5]
          const seatIndex = session?.seats.findIndex(value => value.id === seat.id) ?? 0
          return <article key={seat.id} className={styles.seat} data-chair={chair || undefined} data-state={state}
            aria-label={seat.label} style={{ '--seat-x': `${position[0]}%`, '--seat-y': `${position[1]}%` } as CSSProperties}>
            <div className={styles.throne} aria-hidden="true" />
            <div className={styles.seatCard}>
              <h3>{seat.label} <span>{t('seatName', { letter: String.fromCharCode(65 + seatIndex) })}</span></h3>
              <div>{seat.model ?? t('nativeModel')}</div><small>{chair ? t('chair') : t('adviser')}</small>
              <span className={styles.chip}>{t(state)}</span>
              <p className={styles.excerpt}>{answer?.state === 'failed' ? answer.error : priorFailure?.error ?? answer?.text}</p>
              {vote && <span className={styles.chip}>{vote.choice ? t('voted', { choice: vote.choice }) : t('noVote')}</span>}
              <small>{usage(seat)}</small>
            </div>
          </article>
        })}
      </div>
    </div>
    {session?.tally && <div className={styles.tally} aria-label={t('tally')}><span>{t('tally')}</span>
      {Object.entries(session.tally).map(([choice, count]) => <span className={styles.tallyChip} key={choice}>{choice} · {count}</span>)}
    </div>}
    {answers.length > 0 && <details className={styles.answers}><summary>{t('fullAnswers')}</summary>
      {session?.seats.map((seat) => {
        const answer = answers.find(value => value.seatId === seat.id)
        const vote = session.votes?.find(value => value.seatId === seat.id)
        return answer && <section key={seat.id}>
          <h3>{t('answer', { seat: seat.label, round: currentRound })}</h3>
          <p>{answer.error ?? answer.text}</p>{vote && <p>{vote.reason}</p>}
        </section>
      })}
    </details>}
    {session?.ruling ? <section className={styles.ruling} aria-label={t('ruling')}>
      <header><span className={styles.seal} aria-hidden="true" /><h2>{t('ruling')}</h2>
        <span>{session.ruling.confidence === null ? t('confidenceUnavailable') : t('confidence', { value: Math.round(session.ruling.confidence * 100) })}</span></header>
      <p>{session.ruling.ruling}</p><h3>{t('dissent')}</h3>
      {session.ruling.dissent.length ? <ul>{session.ruling.dissent.map((value, index) => <li key={index}>{value.seat}: {value.point}</li>)}</ul> : <p>{t('noDissent')}</p>}
      {onFollowUp && <Button onClick={() => { onFollowUp(session) }}>{t('followUp')}</Button>}
    </section> : live && session.rounds.length === session.roundCount && answers.length === seats.length && <p role="status">{t('awaitingRuling')}</p>}
  </div>
}
