// The version history dialog (Story 3.25, UX-DR52): the versions of a note, newest first, and [이 버전으로 복원].
// Modal: focus is trapped, Esc closes (or takes back an armed restore), the list moves with the arrow keys and Enter
// reaches the restore button. It only shows and asks; the editor runs the restore (`onRestore`).
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyEvent } from 'react'
import { useI18n, type Key } from '../../i18n'
import type { Page } from '../../model/note'
import { StrokePathCache, fitViewport, paintPage } from '../../render/pagePainter'
import type { Inspection, RestoreFailure, VersionData, VersionSource } from '../../sync/versionHistory'
import { versionListRule, type VersionEntry } from '../../sync/versionList'

/** The online probe is given this long; a slower answer counts as offline. */
export const PROBE_TIMEOUT_MS = 3000
/** Previews are downloaded this many at a time. */
const PREVIEW_PARALLEL = 3

type Phase = 'loading' | 'offline' | 'failed' | 'ready'

const FAILURE_KEY: Record<RestoreFailure, Key> = {
  unreadable: 'version.restoreUnreadable',
  notSaved: 'version.restoreNotSaved',
  notPinned: 'version.restorePinFailed',
  notApplied: 'version.restoreFailed',
  busy: 'version.restoreBusyStroke',
  changed: 'version.restoreChanged',
}

/** The probe's answer; `onTimeout` when it takes over `PROBE_TIMEOUT_MS` or fails. The timer never outlives the call. */
async function asked(probe: () => Promise<boolean>, onTimeout: boolean): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      probe().catch(() => onTimeout),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(onTimeout), PROBE_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const keyOf = (noteId: string, e: VersionEntry) => (e.kind === 'revision' ? `r:${e.revisionId}` : `s:sc:${noteId}:${e.pageId}:${e.rev}`)

const ratioOf = (w: number, h: number) => {
  const r = w / h
  return Number.isFinite(r) && r > 0 ? Math.min(2.5, Math.max(0.4, r)) : 1
}

/** The first page on a small canvas. A page that cannot be drawn leaves it empty; never throws. */
function Preview({ page, label }: { page: Page; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const draw = () => {
      try {
        const r = c.getBoundingClientRect()
        if (!(r.width > 0 && r.height > 0)) return // not laid out yet; the observer calls again
        const dpr = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
        c.width = Math.max(1, Math.round(r.width * dpr))
        c.height = Math.max(1, Math.round(r.height * dpr))
        const ctx = c.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        paintPage(ctx, page, fitViewport(r.width, r.height, page.width, page.height), new StrokePathCache())
      } catch {
        // an empty preview
      }
    }
    draw()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null
    ro?.observe(c)
    return () => ro?.disconnect()
  }, [page])
  return (
    <div className="version-preview" style={{ aspectRatio: String(ratioOf(page.width, page.height)) }}>
      <canvas ref={ref} role="img" aria-label={label} />
    </div>
  )
}

export function VersionHistory({
  noteId,
  source,
  probe,
  readFileId,
  restoreBlocked,
  blockedTitle,
  onRestore,
  onClose,
  now = () => new Date().toISOString(),
}: {
  noteId: string
  source: VersionSource
  /** Is there a connection? Asked once per load, given `PROBE_TIMEOUT_MS`. */
  probe: () => Promise<boolean>
  /** The Drive file id of the note from its sync record; null = never uploaded. */
  readFileId: () => Promise<string | null>
  /** Another tab holds the note, or it is being received: [이 버전으로 복원] is disabled with a tooltip. */
  restoreBlocked: boolean
  /** Why it is blocked (read-only tab, receiving); the tooltip of the disabled buttons. */
  blockedTitle?: string
  /** Runs the restore of one entry. `null` = restored. */
  onRestore: (entry: VersionEntry, fileId: string) => Promise<RestoreFailure | null>
  /** `restored`: a version was restored. Otherwise the person closed the dialog. */
  onClose: (restored: boolean) => void
  now?: () => string
}) {
  const { t, locale } = useI18n()
  const [phase, setPhase] = useState<Phase>('loading')
  const [data, setData] = useState<VersionData | null>(null)
  // What the downloads showed, by key (`r:<revision id>`, `s:<kkeujeokId>`).
  const [infos, setInfos] = useState<Record<string, Inspection['info']>>({})
  const [pages, setPages] = useState<Record<string, Page>>({})
  const [unreachable, setUnreachable] = useState<ReadonlySet<string>>(new Set())
  const [armed, setArmed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [cur, setCur] = useState(0)
  const alive = useRef(true)
  const loadNo = useRef(0)
  const started = useRef(new Set<string>())
  const sidecarFiles = useRef(new Map<string, string>()) // kkeujeokId -> Drive file id
  const fileId = useRef<string | null>(null)
  const queue = useRef<(() => Promise<void>)[]>([])
  const running = useRef(0)
  const box = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()

  useEffect(() => {
    alive.current = true
    closeButton.current?.focus()
    return () => void (alive.current = false)
  }, [])

  // Downloads wait their turn so a long list does not open dozens of requests at once.
  const pump = () => {
    while (running.current < PREVIEW_PARALLEL && queue.current.length > 0) {
      const job = queue.current.shift()!
      running.current++
      void job().finally(() => {
        running.current--
        if (alive.current) pump()
      })
    }
  }

  const load = () => {
    const no = ++loadNo.current
    const stale = () => !alive.current || no !== loadNo.current
    setPhase('loading')
    setArmed(null)
    setError('')
    queue.current = []
    started.current = new Set()
    void (async () => {
      try {
        const online = await asked(probe, false)
        if (stale()) return
        if (!online) return setPhase('offline')
        const id = await readFileId()
        if (stale()) return
        fileId.current = id
        // A note that was never uploaded has no history.
        const d: VersionData = id === null ? { headRevisionId: null, revisions: [], sidecars: [] } : await source.load(noteId, id)
        if (stale()) return
        sidecarFiles.current = new Map()
        for (const f of [...d.sidecars].reverse()) {
          const kid = f.appProperties?.kkeujeokId
          if (kid) sidecarFiles.current.set(kid, f.id) // the first file wins
        }
        // A list the rule refuses is a failed load, not an empty history.
        if ('error' in build(d, {})) return setPhase('failed')
        setInfos({})
        setPages({})
        setUnreachable(new Set())
        setData(d)
        setCur(0)
        setPhase('ready')
      } catch {
        if (!stale()) setPhase('failed')
      }
    })()
  }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** `version.list` over what is known now; the older versions only (the current one is what the note shows). */
  const build = (d: VersionData, known: Record<string, Inspection['info']>) =>
    versionListRule({
      now: now(),
      noteId,
      headRevisionId: d.headRevisionId,
      revisions: d.revisions.map((v) => ({ id: v.id, modifiedTime: v.modifiedTime, keepForever: v.keepForever === true, info: known[`r:${v.id}`] ?? null })),
      sidecars: d.sidecars.map((f) => ({ appProperties: f.appProperties ?? null, info: known[`s:${f.appProperties?.kkeujeokId}`] ?? null })),
    })
  const entries = (): VersionEntry[] => {
    const r = data ? build(data, infos) : null
    return r && 'entries' in r ? r.entries.filter((e) => !(e.kind === 'revision' && e.current)) : []
  }

  /** Downloads the version once, for its preview and device name. */
  const ensure = (e: VersionEntry) => {
    const key = keyOf(noteId, e)
    const id = fileId.current
    if (id === null || started.current.has(key)) return
    started.current.add(key)
    const no = loadNo.current
    queue.current.push(async () => {
      try {
        const kid = key.slice(2)
        const r =
          e.kind === 'revision'
            ? await source.inspectRevision(noteId, id, e.revisionId)
            : await (() => {
                const file = sidecarFiles.current.get(kid)
                if (!file) throw new Error('no sidecar file')
                return source.inspectSidecar(noteId, file, e.pageId, e.rev)
              })()
        if (!alive.current || no !== loadNo.current) return
        setInfos((m) => ({ ...m, [key]: r.info }))
        if (r.info.ok && r.page) setPages((m) => ({ ...m, [key]: r.page! }))
      } catch {
        // Unknown, not unreadable: no preview, the restore stays possible.
        if (alive.current && no === loadNo.current) setUnreachable((s) => new Set(s).add(key))
      }
    })
    pump()
  }

  const list = phase === 'ready' ? entries() : []
  // The downloads start when the list is on screen (an effect, never during render).
  useEffect(() => {
    for (const e of list) ensure(e)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  // The armed entry left the list: the question goes with it.
  useEffect(() => {
    if (armed !== null && !list.some((e) => keyOf(noteId, e) === armed)) setArmed(null)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  const restoreTap = async (e: VersionEntry) => {
    const id = fileId.current
    if (busy || restoreBlocked || id === null || !e.restorable) return
    const key = keyOf(noteId, e)
    if (armed !== key) return setArmed(key)
    setBusy(true)
    setArmed(null)
    setError('')
    let failure: RestoreFailure | null = 'notApplied'
    try {
      failure = await onRestore(e, id)
    } catch {
      // generic failure
    }
    if (!alive.current) return
    if (failure === null) return onClose(true)
    let offline = false
    if (failure === 'notSaved') {
      offline = !(await asked(probe, true))
      if (!alive.current) return
    }
    setBusy(false)
    setError(t(failure === 'notSaved' && offline ? 'version.restoreOffline' : FAILURE_KEY[failure]))
  }

  const items = () => [...box.current!.querySelectorAll<HTMLElement>('[data-version-item]')]
  const focusItem = (i: number) => {
    const els = items()
    const el = els[Math.max(0, Math.min(els.length - 1, i))]
    el?.focus()
  }

  const onKeyDown = (e: ReactKeyEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (busy) return
      if (armed !== null) return setArmed(null)
      onClose(false)
    } else if (e.key === 'Tab') {
      const els = [...box.current!.querySelectorAll<HTMLElement>('button:not([tabindex="-1"]), [tabindex="0"]')].filter((x) => x.getAttribute('aria-hidden') !== 'true')
      if (els.length === 0) return e.preventDefault()
      const i = els.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i + 1) % els.length
      e.preventDefault()
      els[next]?.focus()
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const active = document.activeElement as HTMLElement | null
      if (!active?.hasAttribute('data-version-item')) return // on a button the keys keep their meaning
      e.preventDefault()
      const at = items().indexOf(active)
      focusItem(e.key === 'Home' ? 0 : e.key === 'End' ? items().length - 1 : at + (e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Enter') {
      const active = document.activeElement as HTMLElement | null
      if (!active?.hasAttribute('data-version-item')) return
      e.preventDefault()
      active.querySelector<HTMLElement>('[data-restore]')?.focus()
    }
  }

  const fmtTime = (iso: string) => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d)
    } catch {
      return ''
    }
  }

  let body
  if (phase === 'loading') {
    body = (
      <div role="status" aria-label={t('version.loading')} className="version-list">
        {[0, 1, 2].map((i) => (
          <div key={i} className="version-item version-placeholder" aria-hidden="true" />
        ))}
      </div>
    )
  } else if (phase === 'offline') {
    body = (
      <p role="status" className="version-message">
        {t('version.offline')}
      </p>
    )
  } else if (phase === 'failed') {
    body = (
      <div className="version-message">
        <p role="status">{t('version.failed')}</p>
        <button type="button" className="btn" onClick={load}>
          {t('version.retry')}
        </button>
      </div>
    )
  } else if (list.length === 0) {
    body = (
      <p role="status" className="version-message">
        {t('version.empty')}
      </p>
    )
  } else {
    const at = Math.min(cur, list.length - 1)
    body = (
      <ul className="version-list" aria-label={t('version.list')}>
        {list.map((e, i) => {
          const key = keyOf(noteId, e)
          const time = fmtTime(e.at)
          const tags = [...(e.kind === 'sidecar' ? [t('version.tagConflict')] : []), ...(e.kind === 'revision' && e.beforeRestore ? [t('version.tagBeforeRestore')] : [])]
          const label = [time, ...(e.deviceName ? [e.deviceName] : []), ...tags].filter(Boolean).join(', ')
          const page = pages[key]
          const unavailable = unreachable.has(key) || (infos[key] !== undefined && infos[key]!.ok !== true)
          const isArmed = armed === key
          const blocked = restoreBlocked || busy || !e.restorable
          return (
            <li
              key={key}
              data-version-item=""
              className="version-item"
              aria-label={label}
              tabIndex={i === at ? 0 : -1}
              onFocus={() => setCur(i)}
            >
              <div className="version-preview-slot">
                {page ? (
                  <Preview page={page} label={t('version.previewLabel')} />
                ) : (
                  <div className="version-preview version-preview-empty" style={{ aspectRatio: '0.7' }}>
                    {unavailable && <span>{t('version.previewUnavailable')}</span>}
                  </div>
                )}
              </div>
              <div className="version-body">
                <span className="version-time">{time}</span>
                {e.deviceName && <span className="version-device">{e.deviceName}</span>}
                {tags.length > 0 && (
                  <span className="version-tags">
                    {tags.map((x) => (
                      <span key={x} className="version-tag">
                        {x}
                      </span>
                    ))}
                  </span>
                )}
                {/* aria-disabled, not disabled: a disabled button would drop focus out of the trap. */}
                <button
                  type="button"
                  data-restore=""
                  className="btn version-restore"
                  tabIndex={i === at ? 0 : -1}
                  aria-disabled={blocked}
                  {...(restoreBlocked ? { title: blockedTitle ?? t('editor.readOnlyTip') } : {})}
                  onBlur={() => setArmed((a) => (a === key ? null : a))}
                  onClick={() => !blocked && void restoreTap(e)}
                >
                  {isArmed ? t('version.restoreConfirm') : t('version.restore')}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div
      className="dialog-scrim"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        // A press anywhere but on an armed button takes the question back.
        if (armed !== null && !(e.target as HTMLElement).closest('[data-restore]')) setArmed(null)
      }}
    >
      <div ref={box} className="dialog version-history" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || phase === 'loading'}>
        <div className="version-head">
          <p id={titleId} className="dialog-title">
            {t('version.title')}
          </p>
          <button ref={closeButton} type="button" className="btn" aria-disabled={busy} onClick={() => !busy && onClose(false)}>
            {t('version.close')}
          </button>
        </div>
        {body}
        <div role="alert" className="dialog-error">
          {error}
        </div>
        <div role="status" aria-live="polite" className="sr-only">
          {busy ? t('version.restoring') : armed !== null ? t('version.restoreConfirm') : ''}
        </div>
        {busy && <p className="version-message">{t('version.restoring')}</p>}
      </div>
    </div>
  )
}
