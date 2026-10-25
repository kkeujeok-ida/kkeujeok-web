import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { NoteReceiver, ReceiveState } from '../../sync/noteReceiver'
import type { Page } from '../../model/note'
import { StrokePathCache, fitViewport, paintPage } from '../../render/pagePainter'
import { savesSettled, takeUnsaved } from '../../storage/saveQueue'
import { useI18n } from '../../i18n'
import { createNewNoteDefaults, type Background, type NewNoteDefaults, type Orientation } from '../../storage/newNoteDefaults'
import { auth } from '../../drive/auth'
import type { RootFolderStore, RootState } from '../../drive/rootFolderStore'
import { MissingRootDialog } from '../MissingRootDialog'
import { openNoteStore, type NoteStore } from '../../storage/noteStore'
import { Banner } from '../sync/Banner'
import { CannotOpenSheet } from '../sync/CannotOpenSheet'
import { downloadBlob } from '../download'
import { LibrarySyncing, SyncBadge, useCardStatus, BADGE_KEY } from '../sync/SyncIndicator'
import { useNoteConflicts, useNoteIssue, useOffline } from '../sync/syncUi'
import { useDisplayLabel } from '../sync/useDisplayLabel'
import type { UploadCoordinator } from '../../sync/uploadCoordinator'
import { ConfirmDialog } from '../ConfirmDialog'
import { LibraryFab } from './LibraryFab'
import { NewNoteDialog } from './NewNoteDialog'
import { noteHref } from './NoteEditor'
import { requestResolve } from './resolveRequest'
import { publishNoteOrder } from './noteOrder'
import { LIBRARY_SORTS, sortBy, useLibrary, type LibraryItem, type LibrarySort } from './useLibrary'

// One per page session, so what was created last wins over a failed save.
let shared: ReturnType<typeof createNewNoteDefaults> | undefined
const sharedDefaults = () => (shared ??= createNewNoteDefaults())
const defaultOpenStore = () => openNoteStore(undefined, { getAccount: () => auth.getState().account })

type Props = {
  openStore?: () => NoteStore
  defaults?: { read(): NewNoteDefaults; write(d: NewNoteDefaults): void }
  editedBy?: string
  /** The Drive root folder (Story 3.10). Without it the library does nothing Drive-related. */
  root?: RootFolderStore
  /** [로그아웃] of the missing-root dialog: drops the in-memory token only. */
  signOut?: () => void
  /** Remote changes (Story 3.14): cards of notes not downloaded yet, the ↓ badge, the scan placeholder. */
  receiver?: Pick<NoteReceiver, 'subscribe' | 'getState'>
  /** Story 7.8: deleting a note sends what is unsent, then trashes it on Drive. Without it no delete is offered. */
  uploads?: Pick<UploadCoordinator, 'deleteNote'>
}

const NO_RECEIVE: ReceiveState = { version: 0, receiving: new Set(), scanning: false, revived: 0 }
const NO_RECEIVER = { subscribe: () => () => {}, getState: () => NO_RECEIVE }
/** The scan placeholder shows only when the scan takes longer than this. */
export const SCAN_PLACEHOLDER_MS = 1000

const IDLE: RootState = { status: 'idle' }
const NO_ROOT = { subscribe: () => () => {}, getState: () => IDLE }

function formatDate(ms: number | null, locale: string): string {
  if (ms === null) return ''
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(ms))
  } catch {
    return ''
  }
}

export function Library({ openStore = defaultOpenStore, defaults = sharedDefaults(), editedBy, root, signOut = () => auth.signOut(), receiver, uploads }: Props) {
  const { t, locale } = useI18n()
  const lib = useLibrary(openStore, defaults, editedBy, receiver)
  const rx = receiver ?? NO_RECEIVER
  const receive = useSyncExternalStore(rx.subscribe, rx.getState, () => NO_RECEIVE)
  // Grey cards while the first scan runs, only when it lasts over a second.
  const scanning = receive.scanning
  const [placeholder, setPlaceholder] = useState(false)
  useEffect(() => {
    if (!scanning) return void setPlaceholder(false)
    const id = setTimeout(() => setPlaceholder(true), SCAN_PLACEHOLDER_MS)
    return () => clearTimeout(id)
  }, [scanning])
  const [sheet, setSheet] = useState<NewNoteDefaults | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const entering = useRef(false) // a note was created and the editor is opening
  const wasOpen = useRef(false)
  const section = useRef<HTMLElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const rootState = useSyncExternalStore((root ?? NO_ROOT).subscribe, (root ?? NO_ROOT).getState, () => IDLE)
  // [나중에]: no question until the next page load or the tab is visible again.
  const [later, setLater] = useState(false)
  useEffect(() => {
    if (!root) return
    void root.checkForeground() // throttled; no spinner on a known root
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setLater(false)
      void root.checkForeground()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [root])

  // Opening again while a sheet is open or the editor is opening does nothing.
  const openSheet = (from: HTMLElement | null) => {
    if (entering.current || sheet || lib.status !== 'ready') return
    opener.current = from
    setSheet(defaults.read())
  }

  // Closing the sheet hands focus back to the button that opened it.
  useEffect(() => {
    if (wasOpen.current && !sheet && !entering.current) {
      // The opener may be gone (its card replaced); the fab is always there.
      const target = opener.current?.isConnected ? opener.current : section.current?.querySelector<HTMLElement>('.fab-button')
      target?.focus()
    }
    wasOpen.current = sheet !== null
  }, [sheet])

  async function create(v: { title: string; background: Background; orientation: Orientation }) {
    if (entering.current) return true
    try {
      const noteId = await lib.create(v)
      if (!mounted.current) return true // the library went away; the note is saved
      entering.current = true
      setSheet(null)
      globalThis.location.hash = noteHref(noteId)
      return true
    } catch (e) {
      console.warn('Could not create the note', e)
      return false
    }
  }

  // A note left with strokes that could not be saved: say so once.
  const [unsaved, setUnsaved] = useState(false)
  useEffect(() => {
    void savesSettled(3000).then(() => {
      if (mounted.current && takeUnsaved()) setUnsaved(true)
    })
  }, [])

  // The question waits while the new-note sheet covers the library and is asked when it closes.
  const asking = rootState.status === 'missing' && !later && !sheet && !entering.current
  const askOpener = useRef<HTMLElement | null>(null)
  const wasAsking = useRef(false)
  useEffect(() => {
    if (asking) askOpener.current = document.activeElement as HTMLElement | null
    else if (wasAsking.current && mounted.current) {
      const back = askOpener.current
      if (back?.isConnected && (!document.activeElement || document.activeElement === document.body)) back.focus()
    }
    wasAsking.current = asking
  }, [asking])

  const [sort, setSort] = useState<LibrarySort>('nameAsc') // by name at every start
  const items = useMemo(() => sortBy(lib.items, sort), [lib.items, sort])
  const { status } = lib
  // The writing screen walks this order (Story 5.14).
  useEffect(() => {
    if (status === 'ready') publishNoteOrder(items.map((i) => ({ noteId: i.noteId, title: i.title, remote: !!i.remote, blocked: !!i.blocked })))
  }, [status, items])
  const offline = useOffline()
  const [deleting, setDeleting] = useState<{ noteId: string; from: HTMLElement | null } | null>(null)
  async function confirmDelete() {
    const target = deleting
    setDeleting(null)
    if (!target || !uploads) return
    await uploads.deleteNote(target.noteId)
    if (mounted.current) void lib.reload()
  }
  return (
    <section ref={section} className="library" aria-label={t('library.label')} aria-busy={status === 'loading'}>
      <Banner />
      <div className="library-toolbar">
        <select className="field-input library-sort" aria-label={t('library.sort')} value={sort} onChange={(e) => setSort(e.target.value as LibrarySort)}>
          {LIBRARY_SORTS.map((s) => (
            <option key={s} value={s}>
              {t(`library.sort.${s}`)}
            </option>
          ))}
        </select>
      </div>
      {unsaved && (
        <p role="status" className="cover-status">
          {t('library.saveFailed')}
        </p>
      )}
      <ul className="cover-grid">
        {status === 'loading' && (
          <li className="cover-status" role="status">
            {t('library.loading')}
          </li>
        )}
        {rootState.status === 'preparing' && (
          <li className="cover-status" role="status">
            {t('drive.preparing')}
          </li>
        )}
        {root && rootState.status === 'failed' && (
          <li className="cover-status" role="alert">
            {rootState.errorClass === 'reauth' ? (
              <>
                <span>{t('drive.reauth')}</span>
                <button type="button" className="btn" onClick={() => void root.signInAgain()}>
                  {t('drive.reauthAction')}
                </button>
              </>
            ) : (
              <>
                <span>{t(rootState.errorClass === 'backoff' ? 'drive.networkError' : 'drive.prepareFailed')}</span>
                <button type="button" className="btn" onClick={() => void root.check()}>
                  {t('library.retry')}
                </button>
              </>
            )}
          </li>
        )}
        {(status === 'error' || lib.failed) && (
          <li className="cover-status" role="alert">
            <span>{t('library.loadFailed')}</span>
            <button type="button" className="btn" onClick={() => void lib.reload()}>
              {t('library.retry')}
            </button>
          </li>
        )}
        {placeholder && items.length === 0 && (
          <>
            {[0, 1, 2].map((n) => (
              <li key={n} aria-hidden="true">
                <div className="cover-card cover-card-placeholder">
                  <span className="cover-thumb" />
                </div>
              </li>
            ))}
          </>
        )}
        {status === 'ready' && items.length === 0 && !scanning && (
          <li>
            <button type="button" className="cover-card" onClick={(e) => openSheet(e.currentTarget)}>
              <span className="cover-thumb cover-thumb-new" aria-hidden="true">
                <svg className="icon" viewBox="0 0 16 16">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.75" fill="none" />
                </svg>
              </span>
              <span className="cover-title">{t('library.newNote')}</span>
            </button>
          </li>
        )}
        {items.map((item) => (
          <Card
            key={item.noteId}
            item={item}
            locale={locale}
            blocked={() => entering.current}
            receiving={receive.receiving.has(item.noteId)}
            offline={offline}
            onDelete={uploads ? (from) => setDeleting({ noteId: item.noteId, from }) : undefined}
            exportCopy={async () => {
              const f = await lib.exportCopy(item.noteId)
              downloadBlob(f.name, f.bytes as BlobPart, 'application/octet-stream')
            }}
          />
        ))}
      </ul>
      {status === 'ready' && <LibraryFab onNewNote={openSheet} />}
      {root && asking && (
        <MissingRootDialog onCreate={() => void root.recreate()} onLater={() => setLater(true)} onSignOut={signOut} />
      )}
      {sheet && (
        <NewNoteDialog
          defaults={sheet}
          onCreate={create}
          onClose={() => {
            if (!entering.current) setSheet(null)
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          destructive
          body={t('library.noteDeleteBody')}
          confirmLabel={t('library.noteDeleteConfirm')}
          cancelLabel={t('library.cancel')}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            setDeleting(null)
            deleting.from?.focus()
          }}
        />
      )}
      <LibrarySyncing />
    </section>
  )
}

// The first page on the card, drawn by the writing screen's renderer. A page
// that cannot be drawn leaves an empty card.
function Thumb({ page }: { page: Page | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c || !page) return
    const cache = new StrokePathCache()
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
        paintPage(ctx, page, fitViewport(r.width, r.height, page.width, page.height), cache)
      } catch {
        // an empty card
      }
    }
    draw()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null
    ro?.observe(c)
    return () => ro?.disconnect()
  }, [page])
  return (
    <span className="cover-thumb" aria-hidden="true">
      <canvas ref={ref} className="cover-thumb-canvas" />
    </span>
  )
}

/** A note whose Drive file cannot be read: "열 수 없음", and the sheet when it is pressed (UX-DR69). */
function BlockedCard({ fileId, hasUnsent, exportCopy }: { fileId: string | null; hasUnsent: boolean; exportCopy: () => Promise<void> }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <li>
      <button ref={button} type="button" className="cover-card cover-card-disabled cover-card-blocked" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="cover-thumb" aria-hidden="true" />
        <span className="cover-title">{t('library.cannotOpen')}</span>
      </button>
      {open && (
        <CannotOpenSheet
          fileId={fileId}
          hasUnsent={hasUnsent}
          onExportCopy={exportCopy}
          onClose={() => {
            setOpen(false)
            button.current?.focus() // the card stays; focus goes back to it
          }}
        />
      )}
    </li>
  )
}

function Card({
  item,
  locale,
  blocked,
  receiving,
  offline,
  onDelete,
  exportCopy,
}: {
  item: LibraryItem
  locale: string
  blocked: () => boolean
  receiving: boolean
  offline: boolean
  onDelete?: (from: HTMLElement | null) => void
  exportCopy: () => Promise<void>
}) {
  const { t } = useI18n()
  const issue = useNoteIssue(item.noteId)
  const titleId = useId()
  const dateId = useId()
  const statusId = useId()
  const sync = useCardStatus(item.noteId).label
  const conflicted = (useNoteConflicts(item.noteId)?.length ?? 0) > 0
  // The badge of a short sync is held (see useDisplayLabel); `saved` has none.
  const held = useDisplayLabel(receiving ? 'receiving' : sync ?? 'saved')
  if (item.blocked) return <BlockedCard fileId={item.blocked.fileId} hasUnsent={false} exportCopy={exportCopy} />
  if (issue?.kind === 'unreadable') return <BlockedCard fileId={issue.fileId} hasUnsent={issue.hasUnsent} exportCopy={exportCopy} />
  if (item.title === null) {
    return (
      <li>
        <div className="cover-card cover-card-disabled">
          <span className="cover-thumb" aria-hidden="true" />
          <span className="cover-title">{t('library.cannotOpen')}</span>
        </div>
      </li>
    )
  }
  const date = formatDate(item.editedMs, locale)
  // A note that is being received has the badge whatever its record says.
  const badge = held === 'saved' ? null : held
  const described = [badge ? statusId : null, date ? dateId : null].filter(Boolean).join(' ') || undefined
  const status = badge && <span id={statusId} className="sr-only">{t(BADGE_KEY[badge])}</span>
  if (offline) {
    // No connection: the card is shown but cannot be opened (UX-DR59).
    return (
      <li>
        <div className="cover-card cover-card-disabled" aria-disabled="true" aria-labelledby={titleId} aria-describedby={described} title={item.title}>
          <span className="cover-thumb-wrap">
            <Thumb page={item.page} />
            {badge && <SyncBadge label={badge} />}
          </span>
          <span id={titleId} className="cover-title">{item.title}</span>
          {status}
          {date && <span id={dateId} className="cover-date">{date}</span>}
        </div>
      </li>
    )
  }
  return (
    <li className="cover-item">
      <a
        className="cover-card"
        href={noteHref(item.noteId)}
        onKeyDown={(e) => {
          if (e.key === 'Delete' && onDelete) {
            e.preventDefault()
            onDelete(e.currentTarget)
          }
        }}
        aria-labelledby={titleId}
        aria-describedby={described}
        title={item.title}
        onClick={(e) => {
          if (blocked()) return e.preventDefault()
          // A conflicted note opens with the resolve dialog already up (Story 3.22).
          const plain = e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
          if (conflicted && plain) requestResolve(item.noteId)
        }}
      >
        <span className="cover-thumb-wrap">
          <Thumb page={item.page} />
          {badge && <SyncBadge label={badge} />}
        </span>
        <span id={titleId} className="cover-title">
          {item.title}
        </span>
        {status}
        {date && (
          <span id={dateId} className="cover-date">
            {date}
          </span>
        )}
      </a>
      {onDelete && <NoteMenu onDelete={onDelete} />}
    </li>
  )
}

/** The ⋯ button of a card, a sibling of the card link (UX-DR83): [삭제] for now. */
function NoteMenu({ onDelete }: { onDelete: (from: HTMLElement | null) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <div className="cover-menu" onKeyDown={(e) => e.key === 'Escape' && open && (setOpen(false), button.current?.focus())}>
      <button ref={button} type="button" className="btn cover-menu-button" aria-label={t('library.noteMenu')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div role="menu" className="cover-menu-list">
          <button
            type="button"
            role="menuitem"
            className="btn"
            autoFocus
            onClick={() => {
              setOpen(false)
              onDelete(button.current)
            }}
          >
            {t('library.noteDelete')}
          </button>
        </div>
      )}
    </div>
  )
}
