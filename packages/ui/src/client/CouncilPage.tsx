/** Council admission, durable history, and a disposable live follower. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, StateDot } from './dsh.ts'
import { type PropsLocale } from './dsh.ts'
import type { CouncilMode, CouncilSession, CouncilSessionId, SeatAvailability, SeatId } from '@switchboard/council/types'
import type { CouncilFace } from './council-presentation.ts'
import { councilEvent, type ChamberState } from './council-state.ts'
import { CouncilChamber } from './CouncilChamber.tsx'
import styles from './CouncilPage.module.css'

type Locale = PropsLocale<'switchboardCouncil'>
type PageProps = Locale & { api: CouncilFace }

/**
 * Render the Council form and history without launching work on page load.
 * @param props - generated Remote methods and locale translator.
 * @returns Council page.
 */
export function CouncilPage({ api, t }: PageProps): ReactNode {
  const [catalog, setCatalog] = useState<SeatAvailability[]>()
  const [history, setHistory] = useState<CouncilSession[]>([])
  const [selected, setSelected] = useState<SeatId[]>([])
  const [id, setId] = useState<CouncilSessionId>()
  const [question, setQuestion] = useState('')
  const [mode, setMode] = useState<CouncilMode>('quick')
  const [rounds, setRounds] = useState(2)
  const [attempt, setAttempt] = useState(0)
  const [loadError, setLoadError] = useState(false)
  const [askError, setAskError] = useState('')
  const [pending, setPending] = useState(false)
  const [followUp, setFollowUp] = useState(false)
  const [focusRequest, setFocusRequest] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const lifetime = useRef(false)
  useEffect(() => { lifetime.current = true; return () => { lifetime.current = false } }, [])
  useEffect(() => { if (!id && focusRequest) input.current?.focus() }, [id, focusRequest, catalog])
  useEffect(() => {
    let active = true
    setLoadError(false)
    void Promise.all([api.seats(), api.list()]).then(([seats, sessions]) => {
      if (!active) return
      if (!seats.ok || !sessions.ok) { setLoadError(true); return }
      setCatalog(seats.value)
      setSelected(seats.value.filter(seat => seat.available).map(seat => seat.id))
      setHistory(sessions.value)
    }).catch(() => { if (active) setLoadError(true) })
    return () => { active = false }
  }, [api, attempt])
  const remember = useCallback((session: CouncilSession) => {
    setHistory(values => [session, ...values.filter(value => value.id !== session.id)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
  }, [])
  async function ask(): Promise<void> {
    setPending(true)
    setAskError('')
    try {
      const result = await api.ask({ question: question.trim(), mode, ...(mode === 'debate' ? { rounds } : {}), seatIds: selected })
      if (!lifetime.current) return
      if (result.ok) setId(result.value)
      else setAskError(result.error.message)
    } catch (error) { if (lifetime.current) setAskError(String(error)) }
    finally { if (lifetime.current) setPending(false) }
  }
  function follow(session: CouncilSession): void {
    setQuestion(t('followUpQuestion', { question: session.question, ruling: session.ruling?.ruling ?? '' }))
    setFollowUp(true)
    setFocusRequest(value => value + 1)
    setId(undefined)
    setAskError('')
  }
  return <main className={styles.page}>
    <header className={styles.heading}><div><h1>{t('title')}</h1><p>{t('intro')}</p></div><span>{t('readOnly')}</span></header>
    <div className={styles.layout}>
      <aside className={styles.history} aria-label={t('history')}>
        <Button variant="outline" disabled={pending} onClick={() => {
          setId(undefined); setQuestion(''); setFollowUp(false); setFocusRequest(value => value + 1)
        }}>{t('newQuestion')}</Button>
        <h2>{t('history')}</h2>
        {history.length === 0 && <p>{t('emptyHistory')}</p>}
        {history.map(session => <button type="button" key={session.id} disabled={pending} className={styles.historyItem}
          aria-current={session.id === id ? 'true' : undefined} onClick={() => { setId(session.id) }}>
          <span>{session.question}</span><small>{t(session.mode)} · {t(session.state)}</small>
          <time dateTime={session.createdAt}>{new Date(session.createdAt).toLocaleString()}</time>
        </button>)}
      </aside>
      <div className={styles.content}>
        {loadError && <div role="alert" className={styles.notice}>{t('loadError')} <Button onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button></div>}
        {!catalog && !loadError && <div className={styles.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>}
        {catalog && !id && <form className={styles.form} onSubmit={(event) => { event.preventDefault(); if (!pending) void ask() }}>
          <label className={styles.question}>{t('question')}<textarea ref={input} required value={question}
            placeholder={t('questionHint')} onChange={(event) => { setQuestion(event.target.value) }} /></label>
          {followUp && <p>{t('followUpHint')}</p>}
          <div className={styles.controls}>
            <fieldset><legend>{t('mode')}</legend>{(['quick', 'debate', 'vote'] as const).map(value =>
              <label key={value}><input type="radio" name="council-mode" checked={mode === value} onChange={() => { setMode(value) }} />{t(value)}</label>)}</fieldset>
            {mode === 'debate' && <label>{t('rounds')}<select value={rounds} onChange={(event) => { setRounds(Number(event.target.value)) }}><option value={2}>2</option><option value={3}>3</option></select></label>}
          </div>
          <fieldset className={styles.picker}><legend>{t('seats')}</legend>
            {catalog.map(seat => <label key={seat.id} className={styles.pickSeat}>
              <input type="checkbox" checked={selected.includes(seat.id)} disabled={!seat.available}
                onChange={(event) => {
                  setSelected(values => event.target.checked ? [...values, seat.id] : values.filter(value => value !== seat.id))
                }} />
              <span><span>{seat.label}</span><small>{seat.model ?? t('nativeModel')}</small>
                <small>{seat.available ? t('available') : `${t('unavailable')}: ${seat.reason ?? ''}`}</small></span>
            </label>)}
          </fieldset>
          <div className={styles.actions}><p>{t('selectionHint')}</p><Button type="submit" disabled={pending || selected.length < 2 || !question.trim()}>{t('ask')}</Button></div>
          {askError && <p role="alert">{t('askError')} {askError}</p>}
        </form>}
        {id ? <LiveCouncil key={id} id={id} api={api} t={t} remember={remember} onFollowUp={follow} />
          : <CouncilChamber t={t} />}
      </div>
    </div>
  </main>
}

function LiveCouncil({ id, api, t, remember, onFollowUp }: PageProps & {
  id: CouncilSessionId
  remember: (session: CouncilSession) => void
  onFollowUp: (session: CouncilSession) => void
}): ReactNode {
  const [view, setView] = useState<ChamberState>()
  const [round, setRound] = useState<number>()
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState(false)
  const [cancelError, setCancelError] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const alive = useRef(false)
  const detach = useRef<() => void>(() => {})
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    let stream: ReturnType<CouncilFace['follow']> | undefined
    const stop = () => { controller.abort(); stream?.dispose() }
    detach.current = stop
    setError(false)
    void (async () => {
      let projection: ChamberState | undefined
      try {
        stream = api.follow(id)
        for await (const event of stream) {
          controller.signal.throwIfAborted()
          projection = councilEvent(projection, event)
          setView(projection)
          if (projection) remember(projection.session)
        }
        controller.signal.throwIfAborted()
        // Votes and chair usage have no incremental event in the current API.
        const final = await api.get(id)
        controller.signal.throwIfAborted()
        if (!final.ok) throw final.error
        setView({ session: final.value, thinking: [] })
        remember(final.value)
        if (final.value.state === 'running' || final.value.state === 'queued') setError(true)
      } catch (_error) { if (!controller.signal.aborted) setError(true) }
      finally { stream?.dispose() }
    })()
    return stop
  }, [api, id, attempt, remember])
  async function cancel(): Promise<void> {
    setCancelling(true)
    setCancelError(false)
    try {
      const result = await api.cancel(id)
      if (!alive.current) return
      if (!result.ok) throw result.error
      detach.current()
      setView({ session: result.value, thinking: [] })
      remember(result.value)
      // Keep the terminal snapshot visible even if this reconnect fails.
      setAttempt(value => value + 1)
    } catch (_error) { if (alive.current) setCancelError(true) }
    finally { if (alive.current) setCancelling(false) }
  }
  const session = view?.session
  const live = session?.state === 'running' || session?.state === 'queued'
  return <section aria-label={t('chamber')}>
    <div className={styles.actions}>
      <span role="status">{session ? t(session.state) : t('loading')}</span>
      {session && <label>{t('viewRound')}<select value={round ?? 'live'} onChange={(event) => { setRound(event.target.value === 'live' ? undefined : Number(event.target.value)) }}>
        <option value="live">{t('liveRound')}</option>
        {session.rounds.map(value => <option key={value.round} value={value.round}>{t('round', { round: value.round, total: session.roundCount })}</option>)}
      </select></label>}
      {live && <Button disabled={cancelling} onClick={() => { void cancel() }}>{t('cancel')}</Button>}
    </div>
    {error && <div role="alert" className={styles.notice}>{t('followError')} <Button onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button></div>}
    {cancelError && <p role="alert">{t('cancelError')}</p>}
    {session?.error && <p role="alert">{session.error}</p>}
    <CouncilChamber view={view} round={round} t={t} onFollowUp={onFollowUp} />
  </section>
}
