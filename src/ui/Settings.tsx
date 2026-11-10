import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { syncLog } from '../sync/syncLog'
import { countUnsent, defaultUnsentStore } from '../sync/unsent'
import { fmt, useI18n, type Choice, type Key } from '../i18n'
import type { Auth } from '../drive/auth'
import { clearSessionHistories } from '../ops/sessionHistories'
import { deleteNoteDatabase } from '../storage/noteDb'
import { VISIBLE_TOOLS_MAX, VISIBLE_TOOLS_MIN, sharedVisibleTools } from '../storage/toolbarVisibleTools'
import { getStraighten, setStraighten, subscribeStraighten } from '../storage/straighten'
import { getLeftHanded, setLeftHanded, subscribeLeftHanded } from '../storage/leftHanded'
import { THEMES, getTheme, setTheme, subscribeTheme } from '../storage/theme'
import { Help } from './Help'
import { PenPaletteEditor } from './PenPaletteEditor'
import { SMOOTH_MAX } from '../model/smooth'
import { getSmooth, setSmooth, subscribeSmooth } from '../storage/smooth'
import { PressureCurveSetting } from './PressureCurveSetting'
import { ConfirmDialog } from './ConfirmDialog'
import { downloadBlob } from './download'
import { settingsActiveSection, settingsSections } from '../model/settingsLayout'

const CHOICES: { value: Choice; label: Key }[] = [
  { value: 'system', label: 'settings.language.system' },
  { value: 'ko', label: 'settings.language.ko' },
  { value: 'en', label: 'settings.language.en' },
]

type Action = 'logout' | 'disconnect'

const defaultExport = () => syncLog().exportJsonl({ appVersion: __APP_VERSION__, buildId: __BUILD_ID__, buildNumber: __BUILD_NUMBER__, now: new Date() })

// Shown only behind the sign-in gate, so logout and disconnect are always valid.
export function Settings({
  onClose,
  auth,
  exportLog = defaultExport,
  unsentIds = () => countUnsent(defaultUnsentStore()),
}: {
  onClose: () => void
  auth: Auth
  exportLog?: () => Promise<{ name: string; text: string }>
  /** Ids of the notes with unsent changes; null = could not be checked. */
  unsentIds?: () => Promise<string[] | null>
}) {
  const { t, choice, setChoice } = useI18n()
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme)
  const leftHanded = useSyncExternalStore(subscribeLeftHanded, getLeftHanded, getLeftHanded)
  const straighten = useSyncExternalStore(subscribeStraighten, getStraighten, getStraighten)
  const smooth = useSyncExternalStore(subscribeSmooth, getSmooth, getSmooth)
  const [help, setHelp] = useState(false)
  const helpBtn = useRef<HTMLButtonElement>(null)
  const wasHelp = useRef(false)
  useEffect(() => {
    if (wasHelp.current && !help) helpBtn.current?.focus() // back from the help page
    wasHelp.current = help
  }, [help])
  const [action, setAction] = useState<Action | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Key | null>(null)
  // Once Google has revoked the grant, a retry must not revoke it again.
  const revoked = useRef(false)
  const buttons = { logout: useRef<HTMLButtonElement>(null), disconnect: useRef<HTMLButtonElement>(null) }
  // Notes with unsent changes, counted when a button is pressed: 0 = the Story 1.12 dialog, null = unknown.
  const [unsent, setUnsent] = useState<number | null>(0)
  const checking = useRef(false) // a second press while counting is ignored
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => void (mounted.current = false)
  }, [])
  async function open(a: Action) {
    if (busy || checking.current) return
    checking.current = true
    try {
      const ids = await unsentIds().catch(() => null)
      if (!mounted.current) return // Settings was closed meanwhile
      setUnsent(ids === null ? null : ids.length)
      setError(null)
      setAction(a)
    } finally {
      checking.current = false
    }
  }
  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      if (unsent === 0) {
        // Edited while the box was open: count again and go back to the warning if it grew.
        const ids = await unsentIds().catch(() => null)
        if (!mounted.current) return
        if (ids === null || ids.length > 0) return setUnsent(ids === null ? null : ids.length)
      }
      if (action === 'disconnect' && !revoked.current) {
        if ((await auth.disconnect()) !== 'revoked') return setError('signin.network')
        revoked.current = true
      }
      try {
        await deleteNoteDatabase()
      } catch {
        return setError('settings.deleteFailed')
      }
      clearSessionHistories() // undo history must not outlive the notes
      auth.signOut() // the gate shows the sign-in screen
    } finally {
      setBusy(false)
    }
  }
  const [visible, setVisible] = useState(() => sharedVisibleTools().read())
  const [exportFailed, setExportFailed] = useState(false)
  const exporting = useRef(false) // a second press while one runs is ignored
  async function exportSyncLog() {
    if (exporting.current) return
    exporting.current = true
    setExportFailed(false)
    try {
      const { name, text } = await exportLog()
      downloadBlob(name, text, 'application/x-ndjson')
    } catch {
      if (mounted.current) setExportFailed(true)
    } finally {
      exporting.current = false
    }
  }
  // The view replaced the library: move focus to its heading so the change is announced.
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => title.current?.focus(), [])

  // Web has no penOnly/penDiag items; the account section sits behind the sign-in gate.
  const sections = settingsSections({ signedIn: true, platform: 'web' })
  const [active, setActive] = useState<string>(sections[0]!.id)
  const lockUntil = useRef(0) // ignore scroll-spy while a smooth scroll runs
  const heading = (id: string) => document.getElementById(`settings-sec-${id}`)
  useEffect(() => {
    if (help) return
    const spy = () => {
      if (Date.now() < lockUntil.current) return
      const hs = sections.flatMap((x) => {
        const h = heading(x.id)
        return h ? [{ id: x.id, top: h.getBoundingClientRect().top, h }] : []
      })
      if (!hs.length) return
      // The sticky chip row covers the top: headings count from below it (scroll-margin-top).
      const viewportTop = parseFloat(getComputedStyle(hs[0]!.h).scrollMarginTop) || 0
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 1
      setActive(settingsActiveSection({ headings: hs, viewportTop, offset: 8, atEnd }))
    }
    spy() // initial highlight, also after returning from Help
    window.addEventListener('scroll', spy, { passive: true })
    window.addEventListener('resize', spy)
    return () => {
      window.removeEventListener('scroll', spy)
      window.removeEventListener('resize', spy)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sections is constant here
  }, [help])
  function go(id: string) {
    const h = heading(id)
    if (!h) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    lockUntil.current = reduce ? 0 : Date.now() + 700
    setActive(id)
    h.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
    h.focus({ preventScroll: true })
  }
  if (help) return <Help onClose={() => setHelp(false)} />
  const items: Record<string, ReactNode> = {
    language: (
      <fieldset className="settings-group">
        <legend>{t('settings.language')}</legend>
        {CHOICES.map((c) => (
          <label key={c.value} className="option">
            <input
              type="radio"
              name="language"
              value={c.value}
              checked={choice === c.value}
              onChange={() => setChoice(c.value)}
            />
            {/* Native names are read in their own language even inside the other UI language. */}
            <span lang={c.value === 'system' ? undefined : c.value}>{t(c.label)}</span>
          </label>
        ))}
      </fieldset>
    ),
    theme: (
      <fieldset className="settings-group">
        <legend>{t('settings.theme')}</legend>
        <div className="segmented">
          {THEMES.map((v) => (
            <label key={v} className="segmented-option">
              <input type="radio" name="theme" value={v} checked={theme === v} onChange={() => setTheme(v)} />
              <span>{t(`settings.theme.${v}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
    ),
    leftHanded: (
      <label className="settings-group option">
        <input type="checkbox" checked={leftHanded} onChange={(e) => setLeftHanded(e.target.checked)} />
        <span>{t('settings.leftHanded')}</span>
      </label>
    ),
    straighten: (
      <label className="settings-group option">
        <input type="checkbox" checked={straighten} onChange={(e) => setStraighten(e.target.checked)} />
        <span>{t('settings.straighten')}</span>
      </label>
    ),
    smooth: (
      <fieldset className="settings-group">
        <legend>{t('settings.smooth')}</legend>
        <label className="option">
          <input
            type="range"
            className="setting-range"
            min={0}
            max={SMOOTH_MAX}
            step={1}
            value={smooth}
            aria-valuetext={smooth === 0 ? t('settings.smooth.off') : String(smooth)}
            onChange={(e) => setSmooth(Number(e.target.value))}
          />
          <output>{smooth}</output>
        </label>
      </fieldset>
    ),
    pressureCurve: <PressureCurveSetting />,
    visibleTools: (
      <div className="settings-group" role="group" aria-labelledby="visible-tools-label">
        <span id="visible-tools-label">{t('settings.visibleTools')}</span>
        <div className="settings-stepper">
          <button type="button" className="btn" aria-label={t('settings.visibleToolsLess')} disabled={visible <= VISIBLE_TOOLS_MIN} onClick={() => setVisible(sharedVisibleTools().write(visible - 1))}>
            −
          </button>
          <output aria-live="polite">{visible}</output>
          <button type="button" className="btn" aria-label={t('settings.visibleToolsMore')} disabled={visible >= VISIBLE_TOOLS_MAX} onClick={() => setVisible(sharedVisibleTools().write(visible + 1))}>
            +
          </button>
        </div>
      </div>
    ),
    penPalette: <PenPaletteEditor />,
    help: (
      <button ref={helpBtn} type="button" className="btn" onClick={() => setHelp(true)}>
        {t('settings.help')}
      </button>
    ),
    privacy: (
      <a className="btn" href="/privacy" target="_blank" rel="noopener noreferrer">
        {t('settings.privacy')}
      </a>
    ),
    exportLog: (
      <div className="settings-group">
        <button type="button" className="btn" onClick={() => void exportSyncLog()}>
          {t('settings.syncLogExport')}
        </button>
        {exportFailed && <p role="alert">{t('settings.syncLogExportFailed')}</p>}
      </div>
    ),
    // Logout and disconnect stay in one group, as before.
    logOut: (
      <div className="settings-group">
        <button ref={buttons.logout} type="button" className="btn" onClick={() => void open('logout')}>
          {t('settings.logout')}
        </button>
        <button ref={buttons.disconnect} type="button" className="btn" onClick={() => void open('disconnect')}>
          {t('settings.disconnect')}
        </button>
      </div>
    ),
  }
  return (
    <section className="settings" aria-labelledby="settings-title">
      <header className="settings-header">
        <h1 id="settings-title" ref={title} tabIndex={-1}>
          {t('settings.title')}
        </h1>
        <button type="button" className="btn" onClick={onClose}>
          {t('settings.close')}
        </button>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label={t('settings.cat.nav')}>
          {sections.map((sec) => (
            <button
              key={sec.id}
              type="button"
              className="btn settings-nav-item"
              aria-current={active === sec.id ? 'true' : undefined}
              onClick={() => go(sec.id)}
            >
              {t(`settings.cat.${sec.id}`)}
            </button>
          ))}
        </nav>
        <div className="settings-main">
          {sections.map((sec) => (
            <section key={sec.id} className="settings-section" aria-labelledby={`settings-sec-${sec.id}`}>
              <h2 id={`settings-sec-${sec.id}`} className="settings-section-title" tabIndex={-1}>
                {t(`settings.cat.${sec.id}`)}
              </h2>
              {sec.items.map((id) => items[id] && <Fragment key={id}>{items[id]}</Fragment>)}
            </section>
          ))}
        </div>
      </div>
      {action && (
        <ConfirmDialog
          body={
            unsent === 0
              ? `${t(action === 'logout' ? 'logout.question' : 'disconnect.question')} ${t(action === 'logout' ? 'logout.confirm' : 'disconnect.confirm')}`
              : unsent === null
                ? t(action === 'logout' ? 'unsent.logout.unknown' : 'unsent.disconnect.unknown')
                : fmt(t(action === 'logout' ? 'unsent.logout' : 'unsent.disconnect'), { n: unsent })
          }
          confirmLabel={t(
            error
              ? 'signin.network.retry'
              : unsent !== 0
                ? action === 'logout' ? 'unsent.logout.discard' : 'unsent.disconnect.discard'
                : action === 'logout' ? 'settings.logout' : 'settings.disconnect',
          )}
          {...(unsent !== 0 && { armedLabel: t('unsent.armed') })}
          cancelLabel={t('dialog.cancel')}
          destructive={action === 'disconnect' || unsent !== 0}
          busy={busy}
          error={error && t(error)}
          onConfirm={() => void confirm()}
          onCancel={() => {
            setAction(null)
            buttons[action].current?.focus() // back to the button that opened it
          }}
        />
      )}
    </section>
  )
}
