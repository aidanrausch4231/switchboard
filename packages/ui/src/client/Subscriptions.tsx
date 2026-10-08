/** Shared Home/settings subscription card; live exchanges stay local to the mounted card. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, StateDot } from './dsh.ts'
import type { PropsLocale } from './dsh.ts'
import type { SubscriptionError, SubscriptionFrame, SubscriptionId, SubscriptionList, SubscriptionPromptId, SubscriptionProvider, SubscriptionResult } from '@switchboard/core/types'
import type { SubscriptionKey } from './subscription-locales.ts'
import type {} from './subscriptions-presentation.ts'
import styles from './Subscriptions.module.css'

/** Browser-owned cancellable exchange; dispose also cancels Host authorization. */
export interface SubscriptionStream extends AsyncIterable<SubscriptionFrame> { dispose: () => void }
/** Cordis-free operations supplied by the small presentation adapter. */
export interface SubscriptionsFace {
  list: () => Promise<SubscriptionList>
  signIn: (id: SubscriptionId) => SubscriptionStream
  answer: (id: SubscriptionId, promptId: SubscriptionPromptId, value: string) => Promise<SubscriptionResult>
  signOut: (id: SubscriptionId) => Promise<SubscriptionResult>
  enable: (id: SubscriptionId) => Promise<SubscriptionResult>
}
type Locale = PropsLocale<'switchboardSubscriptions'>
const errors: Record<SubscriptionError, SubscriptionKey> = {
  unavailable: 'unavailable', busy: 'busy', signin: 'signinError', route: 'route', apiKey: 'apiKey', signout: 'signoutError', answer: 'answer',
}

/** Render the settings-style page using the same card as Home.
 * @param props - safe operations and locale.
 * @returns scrollable subscription page.
 */
export function SubscriptionsPage(props: { api: SubscriptionsFace } & Locale): ReactNode {
  return <main className={styles.page}><SubscriptionsCard {...props} /></main>
}

/** Load presence facts without reading account details or credentials.
 * @param props - safe operations and locale.
 * @returns subscription provider rows and recoverable load failure.
 */
export function SubscriptionsCard({ api, t }: { api: SubscriptionsFace } & Locale): ReactNode {
  const [providers, setProviders] = useState<SubscriptionProvider[]>()
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setError(false)
    void api.list().then((result) => {
      if (!active) return
      if (result.ok) setProviders(result.providers)
      else setError(true)
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [api, revision])
  return <section className={styles.card} aria-label={t('title')}>
    <header><h2>{t('title')}</h2><p>{t('intro')}</p></header>
    {error && <div role="alert"><p>{t('unavailable')}</p><Button onClick={() => { setRevision(value => value + 1) }}>{t('retry')}</Button></div>}
    {!providers && !error && <div className={styles.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>}
    {providers?.map(provider => <SubscriptionRow key={provider.id} provider={provider} api={api} t={t}
      refresh={() => { setRevision(value => value + 1) }} />)}
  </section>
}

function SubscriptionRow({ provider, api, t, refresh }: {
  provider: SubscriptionProvider
  api: SubscriptionsFace
  refresh: () => void
} & Locale): ReactNode {
  const [frame, setFrame] = useState<SubscriptionFrame>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<SubscriptionError>()
  const [copied, setCopied] = useState<'copied' | 'copyFailed'>()
  const stream = useRef<SubscriptionStream>()
  const cancelled = useRef(false)
  const wasCancelled = (): boolean => cancelled.current
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; stream.current?.dispose() }
  }, [])
  async function signIn(): Promise<void> {
    if (stream.current) return
    cancelled.current = false
    setError(undefined); setCopied(undefined); setFrame({ status: 'working' })
    let exchange: SubscriptionStream | undefined
    try {
      exchange = api.signIn(provider.id)
      stream.current = exchange
      for await (const value of exchange) {
        if (!mounted.current || wasCancelled()) break
        setFrame(value)
      }
    } catch (_error) { if (mounted.current && !wasCancelled()) { setError('signin'); setFrame(undefined) } }
    finally {
      exchange?.dispose(); stream.current = undefined
      if (mounted.current) refresh()
    }
  }
  async function mutate(action: () => Promise<SubscriptionResult>): Promise<void> {
    setPending(true); setError(undefined)
    try {
      const result = await action()
      if (!mounted.current) return
      if (!result.ok) setError(result.error)
      else { setFrame(undefined); refresh() }
    } catch (_error) { if (mounted.current) setError('unavailable') }
    finally { if (mounted.current) setPending(false) }
  }
  const working = frame?.status === 'working'
  const failure = error ?? frame?.error
  const code = frame?.code
  return <div className={styles.row} role="group" aria-label={provider.label}>
    <div className={styles.summary}>
      <div><h3>{provider.label}</h3><span className={styles.detail}>{provider.routeEnabled ? t('enabled') : t('disabled')}</span></div>
      <div className={styles.actions}>
        {provider.signedIn && <span className={styles.signed}>{t('signedIn')}</span>}
        {working ? <Button onClick={() => { cancelled.current = true; stream.current?.dispose(); setFrame({ status: 'cancelled' }) }}>{t('cancel')}</Button>
          : provider.signedIn ? <Button variant="ghost" disabled={pending} onClick={() => { void mutate(() => api.signOut(provider.id)) }}>{t('signout')}</Button>
            : <Button disabled={pending || provider.needsPiAi} onClick={() => { void signIn() }}>{t('signin')}</Button>}
        {provider.signedIn && !provider.routeEnabled && !working && <Button disabled={pending} onClick={() => { void mutate(() => api.enable(provider.id)) }}>{t('enable')}</Button>}
      </div>
    </div>
    {provider.needsPiAi && <p role="status">{t('needsPiAi')}</p>}
    {frame && frame.status !== 'failed' && <div className={styles.interaction} aria-live="polite">
      <p>{t(frame.status)}</p>
      {working && frame.url && <><a className={styles.link} href={frame.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t('open')}</a><p className={styles.detail}>{t(frame.code ? 'deviceHelp' : 'browserHelp')}</p></>}
      {working && code && <div className={styles.actions}><span>{t('code')}</span><code>{code}</code><Button size="sm" onClick={() => {
        void Promise.resolve().then(() => navigator.clipboard.writeText(code)).then(() => { if (mounted.current) setCopied('copied') }).catch(() => { if (mounted.current) setCopied('copyFailed') })
      }}>{t('copy')}</Button>{copied && <span role="status">{t(copied)}</span>}</div>}
      {working && frame.prompt && <Question key={frame.prompt.id} prompt={frame.prompt} api={api} provider={provider.id} t={t} />}
    </div>}
    {failure && <p className={styles.error} role="alert">{t(errors[failure])}</p>}
  </div>
}

function Question({ prompt, api, provider, t }: { prompt: NonNullable<SubscriptionFrame['prompt']>; api: SubscriptionsFace; provider: SubscriptionId } & Locale): ReactNode {
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function answer(text: string): Promise<void> {
    setPending(true); setValue(''); setFailed(false)
    try { const result = await api.answer(provider, prompt.id, text); if (alive.current) setFailed(!result.ok) }
    catch (_error) { if (alive.current) setFailed(true) }
    finally { if (alive.current) setPending(false) }
  }
  return <div className={styles.question}>
    {prompt.kind === 'method' ? <><p>{t('method')}</p><div className={styles.actions}>{prompt.options.map(option => <Button key={option} disabled={pending} onClick={() => { void answer(option) }}>{t(option)}</Button>)}</div></>
      : <form onSubmit={(event) => { event.preventDefault(); void answer(value) }}>
        <label>{t(prompt.kind === 'enterprise' ? 'enterprise' : 'paste')}<input autoComplete="off" spellCheck={false} type={prompt.kind === 'code' ? 'password' : 'text'} value={value} disabled={pending} onChange={(event) => { setValue(event.target.value) }} /></label>
        <Button type="submit" disabled={pending || (prompt.kind === 'code' && !value.trim())}>{t('submit')}</Button>
      </form>}
    {failed && <p role="alert">{t('answer')}</p>}
  </div>
}
