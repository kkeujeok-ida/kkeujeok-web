import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { syncLog } from '../sync/syncLog'
import { countUnsent, defaultUnsentStore } from '../sync/unsent'
import { privacyUrl } from './PrivacyPolicy'
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
import { settingsActiveSection, settingsSearch, settingsSections } from '../model/settingsLayout'

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
  const { t, locale, choice, setChoice } = useI18n()
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
  const [query, setQuery] = useState('')
  const searching = query.trim() !== ''
  const searchInput = useRef<HTMLInputElement>(null)
  const searchButton = useRef<HTMLButtonElement>(null)
  // The search is one icon until opened; it stays open while there is a query.
  const [searchOpen, setSearchOpen] = useState(false)
  const searchWanted = useRef(false)
  const searchShown = searchOpen || query !== ''
  const openSearch = () => {
    searchWanted.current = true
    setSearchOpen(true)
  }
  useEffect(() => {
    if (searchShown && searchWanted.current) searchInput.current?.focus()
    searchWanted.current = false
  }, [searchShown])
  const savedScroll = useRef<number | null>(null)
  const shown = useRef<string[]>([]) // sections with a match; hidden headings must not drive the highlight
  const search = (q: string) => {
    if (q.trim() !== '' && savedScroll.current === null) savedScroll.current = window.scrollY
    setQuery(q)
  }
  useEffect(() => {
    if (searching || savedScroll.current === null) return
    window.scrollTo?.(0, savedScroll.current) // search cleared: back to where it began
    savedScroll.current = null
  }, [searching])
  const lockUntil = useRef(0) // ignore scroll-spy while a smooth scroll runs
  const heading = (id: string) => document.getElementById(`settings-sec-${id}`)
  useEffect(() => {
    if (help) return
    const spy = () => {
      if (Date.now() < lockUntil.current) return
      const hs = sections.filter((x) => shown.current.includes(x.id)).flatMap((x) => {
        const h = heading(x.id)
        return h ? [{ id: x.id, top: h.getBoundingClientRect().top, h }] : []
      })
      if (!hs.length) return
      // Headings count from their scroll-margin-top (0: the sticky title sits at the top).
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
  }, [help, query])
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
  // Searchable text = the item title (web items carry their hint inside the title string).
  const texts: Record<string, string> = {
    language: t('settings.language'),
    theme: t('settings.theme'),
    leftHanded: t('settings.leftHanded'),
    straighten: t('settings.straighten'),
    smooth: t('settings.smooth'),
    pressureCurve: t('settings.pressureCurve'),
    visibleTools: t('settings.visibleTools'),
    penPalette: t('settings.palette'),
    help: t('settings.help'),
    privacy: t('settings.privacy'),
    exportLog: t('settings.syncLogExport'),
    logOut: t('settings.logout'),
    disconnect: t('settings.disconnect'),
  }
  const found = settingsSearch({
    query,
    items: sections.flatMap((sec) => sec.items.filter((id) => id in texts).map((id) => ({ id, section: sec.id, text: texts[id]! }))),
  })
  const vis = new Set(found.visible)
  shown.current = sections.filter((sec) => found.counts[sec.id]).map((sec) => sec.id)
  const total = found.visible.length
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
        <input type="checkbox" role="switch" className="switch-input" checked={leftHanded} onChange={(e) => setLeftHanded(e.target.checked)} />
        <span>{t('settings.leftHanded')}</span>
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
      </label>
    ),
    straighten: (
      <label className="settings-group option">
        <input type="checkbox" role="switch" className="switch-input" checked={straighten} onChange={(e) => setStraighten(e.target.checked)} />
        <span>{t('settings.straighten')}</span>
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
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
      <a className="btn" href={privacyUrl(locale)} target="_blank" rel="noopener noreferrer">
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
        <button ref={buttons.logout} type="button" className="btn" hidden={!vis.has('logOut')} onClick={() => void open('logout')}>
          {t('settings.logout')}
        </button>
        <button ref={buttons.disconnect} type="button" className="btn" hidden={!vis.has('disconnect')} onClick={() => void open('disconnect')}>
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
        <div className={searchShown ? 'library-search is-open' : 'library-search'} role="search">
          {searchShown ? (
            <>
              <input
                id="settings-search-input"
                ref={searchInput}
                type="search"
                className="field-input"
                autoComplete="off"
                aria-label={t('settings.search.label')}
                placeholder={t('settings.search.label')}
                value={query}
                onChange={(e) => search(e.target.value)}
                onBlur={(e) => {
                  if (!query && !e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) setSearchOpen(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    e.stopPropagation()
                    search('')
                    setSearchOpen(false)
                    requestAnimationFrame(() => searchButton.current?.focus())
                  }
                }}
              />
              {query !== '' && (
                <button type="button" className="btn" onClick={() => { search(''); searchInput.current?.focus() }}>
                  {t('settings.search.clear')}
                </button>
              )}
            </>
          ) : (
            <button ref={searchButton} type="button" className="btn library-search-button" aria-label={t('settings.search.label')} aria-expanded={false} onClick={openSearch}>
              <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            </button>
          )}
        </div>
        <button type="button" className="btn" onClick={onClose}>
          {t('settings.close')}
        </button>
      </header>
      <p className="settings-search-status" aria-live="polite">
        {searching ? (total === 0 ? t('settings.search.none') : fmt(t('settings.search.count'), { n: total })) : ''}
      </p>
      <div className="settings-body">
        <nav className="settings-nav" aria-label={t('settings.cat.nav')}>
          {sections.map((sec) => (
            <button
              key={sec.id}
              type="button"
              className="btn settings-nav-item"
              hidden={!shown.current.includes(sec.id)}
              aria-current={active === sec.id ? 'true' : undefined}
              onClick={() => go(sec.id)}
            >
              {t(`settings.cat.${sec.id}`)}
              {searching && <span className="settings-nav-count">{found.counts[sec.id]}</span>}
            </button>
          ))}
        </nav>
        <div className="settings-main">
          {sections.map((sec) => (
            <section key={sec.id} className="settings-section" hidden={!shown.current.includes(sec.id)} aria-labelledby={`settings-sec-${sec.id}`}>
              <h2 id={`settings-sec-${sec.id}`} className="settings-section-title" tabIndex={-1}>
                {t(`settings.cat.${sec.id}`)}
              </h2>
              {sec.items.map(
                (id) =>
                  items[id] && (
                    <div key={id} className="settings-item" hidden={id === 'logOut' ? !vis.has('logOut') && !vis.has('disconnect') : !vis.has(id)}>
                      {items[id]}
                    </div>
                  ),
              )}
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
