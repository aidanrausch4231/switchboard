/** Switchboard workspace navigation and Host connectivity. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconBranchOutlineRegular, StateDot } from './dsh.ts'
import { type PropsLocale, type PropsRuntime, type PropsRenderSlots } from './dsh.ts'
import { type MainPanelId } from './dsh.ts'
import type { PageFace } from './presentation.ts'
import styles from './SwitchboardPage.module.css'

type PageProps = PropsRuntime<'main'> & PropsLocale<'switchboard'> & PropsRenderSlots<'switchboard.subscriptions'> & PageFace

/**
 * Render the Switchboard navigation glyph.
 * @param props - sidebar-owned icon dimensions.
 * @returns decorative branch icon.
 */
export function SwitchboardIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconBranchOutlineRegular size={size} />
}

/**
 * Query the Host when opened; discard responses after leaving the page.
 * @param props - derived slot props and connectivity callback.
 * @returns connectivity status and navigation to workspace pages.
 */
export function SwitchboardPage({ ping, selectPanel, renderSlot, t }: PageProps): ReactNode {
  const [result, setResult] = useState<Awaited<ReturnType<PageFace['ping']>>>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setResult(undefined)
    void ping().then((value) => { if (active) setResult(value) })
    return () => { active = false }
  }, [ping, attempt])

  return <main className={styles.page}>
    <header className={styles.header}>
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>
    </header>
    {renderSlot('switchboard.subscriptions', {})}
    <section className={styles.connection} aria-label={t('connection')} aria-live="polite">
      <h2>{t('connection')}</h2>
      {result === undefined
        ? <div className={styles.loading} role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>
        : result.ok
          ? <><p className={styles.status}><StateDot state="done" />{t('connected')}</p>
            <pre>{JSON.stringify(result.value, null, 2)}</pre></>
          : <><p role="alert">{t('connectionFailed')}</p><Button onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button></>}
    </section>
    <section aria-label={t('sections')}>
      <h2>{t('sections')}</h2>
      <ul className={styles.sections}>
        {([
          ['flows', 'switchboard-flows', 'flowsDescription'],
          ['automations', 'switchboard-automations', 'automationsDescription'],
          ['graphs', 'switchboard-graphs', 'graphsDescription'],
          ['council', 'switchboard-council', 'councilDescription'],
          ['voice', 'switchboard.voice', 'voiceDescription'],
        ] as const).map(([key, panel, description]) =>
          <li key={key}>
            <Button variant="ghost" size="sm" onClick={() => { selectPanel(panel as MainPanelId) }}>{t(key)}</Button>
            <span className={styles.description}>{t(description)}</span>
          </li>)}
      </ul>
    </section>
  </main>
}
