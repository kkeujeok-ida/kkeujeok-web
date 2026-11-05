import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { NoteReceiver, ReceiveState } from '../../sync/noteReceiver'
import type { Page } from '../../model/note'
import { StrokePathCache, fitViewport, paintPage } from '../../render/pagePainter'
import { savesSettled, takeUnsaved } from '../../storage/saveQueue'
import { fmt, useI18n } from '../../i18n'
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
import { LIBRARY_LAYOUTS, LIBRARY_SIZES, sharedLibraryView, type LibraryView } from '../../storage/libraryView'
import { LibraryFab } from './LibraryFab'
import { PdfImportDialog, type PdfImportState } from './PdfImportDialog'
import { importPdf, type PdfImportError } from '../../library/pdfImport'
import { sharedAssetStore } from '../../sync/imageWiring'
import type { ImageHost } from '../../render/imageHost'
import type { Key } from '../../i18n'
import { NewNoteDialog } from './NewNoteDialog'
import { noteHref } from './NoteEditor'
import { requestResolve } from './resolveRequest'
import type { FolderResult, FolderService, FolderView } from '../../library/folderService'
import { SNACKBAR_MS } from '../snackbar'
import { FolderPicker } from './FolderPicker'
import { NOTE_DRAG } from './FolderTree'
import { folderHref } from './useFolders'
import { CoverArt, CoverDialog, coverUrl } from './CoverArt'
import { NameDialog } from './NameDialog'
import { ConfirmDialog } from '../ConfirmDialog'
import { FOLDER_COLORS, getFolderColor, setFolderColor } from '../../library/folderColor'
import { hintSeen, markHint } from '../../storage/hints'
import { librarySearch } from '../../library/libraryRules'
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
  uploads?: Pick<UploadCoordinator, 'deleteNote'> & Partial<Pick<UploadCoordinator, 'noteClosed'>>
  /** The list's layout and size, a device setting. */
  viewStore?: { read(): LibraryView; write(v: LibraryView): void }
  /** Story 7.6: the folders. Without it the library has no folders. */
  folders?: FolderService
  /** The folders the library shows, for [이동]. */
  folderView?: FolderView
  /** The folder being looked at: `root` = the top level, a folder id, null or unset = all notes. */
  folderId?: string | null
  /** Story 9.3: where the bytes of an imported PDF are kept. Without it the shared byte store is used. */
  images?: Pick<ImageHost, 'storePdf' | 'discardPdf'>
}

const PDF_ERROR: Record<PdfImportError, Key> = {
  tooLarge: 'pdf.import.tooLarge',
  tooManyPages: 'pdf.import.tooManyPages',
  encrypted: 'pdf.import.encrypted',
  corrupt: 'pdf.import.unreadable',
  notPdf: 'pdf.import.unreadable',
  noSpace: 'pdf.import.noSpace',
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

const SORT_KEY = 'kkeujeok.librarySort'
const DEFAULT_SORT: LibrarySort = 'editedDesc'
const asSort = (v: string | null | undefined): LibrarySort | null => (LIBRARY_SORTS as readonly string[]).includes(v ?? '') ? (v as LibrarySort) : null
function readSort(): LibrarySort {
  const fromUrl = asSort(new URLSearchParams(globalThis.location?.search).get('sort'))
  if (fromUrl) return fromUrl
  try {
    return asSort(localStorage.getItem(SORT_KEY)) ?? DEFAULT_SORT
  } catch {
    return DEFAULT_SORT
  }
}

export function Library({ openStore = defaultOpenStore, defaults = sharedDefaults(), editedBy, root, signOut = () => auth.signOut(), receiver, uploads, viewStore = sharedLibraryView(), folders, folderView, folderId = null, images }: Props) {
  const { t, locale } = useI18n()
  const lib = useLibrary(openStore, defaults, editedBy, receiver, folders)
  const inFolder = folderId !== null && folderId !== 'root'
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

  async function create(v: { title: string; background: Background; orientation: Orientation; coverId: string | null }) {
    if (entering.current) return true
    try {
      const noteId = await lib.create({ ...v, folderId: inFolder ? folderId : null })
      markHint('firstNote')
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

  // Story 9.3: a picked or dropped PDF becomes a new note in this folder.
  const [pdf, setPdf] = useState<PdfImportState | null>(null)
  const pdfAbort = useRef<AbortController | null>(null)
  const pdfInput = useRef<HTMLInputElement>(null)
  const [pdfSaid, setPdfSaid] = useState('')
  async function importFile(file: File) {
    if (pdf || pdfAbort.current || entering.current || lib.status !== 'ready') return
    const ac = new AbortController()
    pdfAbort.current = ac
    setPdf({ name: file.name, done: 0, total: 0 })
    const r = await importPdf(file, {
      signal: ac.signal,
      onProgress: (done, total) => mounted.current && setPdf((p) => p && { ...p, done, total }),
      store: (hash, bytes) => (images ? images.storePdf(hash, bytes) : sharedAssetStore().put(hash, 'pdf', bytes)),
      onSaving: () => mounted.current && setPdf((p) => p && { ...p, saving: true }),
      discard: async (hash) => {
        if (await lib.pdfReferenced(hash)) return
        await (images ? images.discardPdf(hash) : sharedAssetStore().remove(hash))
      },
      create: (imp) => lib.createFromPdf(imp, inFolder ? folderId : null),
    })
    pdfAbort.current = null
    if (!mounted.current) return
    if ('error' in r) {
      setPdf((p) => p && { ...p, error: PDF_ERROR[r.error] })
      setPdfSaid(t(PDF_ERROR[r.error]))
      return
    }
    setPdf(null)
    if ('cancelled' in r) return
    setPdfSaid(t('pdf.import.done'))
    entering.current = true
    globalThis.location.hash = noteHref(r.noteId)
  }
  const closePdf = () => {
    setPdf(null)
    section.current?.querySelector<HTMLElement>('.fab-button')?.focus()
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

  // The search and the sort live in the address (?q=&sort=); a sort in the address beats the one kept on this device.
  const [sort, setSort] = useState<LibrarySort>(() => readSort())
  const [query, setQuery] = useState(() => new URLSearchParams(globalThis.location?.search).get('q') ?? '')
  const searchInput = useRef<HTMLInputElement>(null)
  const searchButton = useRef<HTMLButtonElement>(null)
  // Story 18.8: the search is one icon until it is opened; it stays open while there is a query.
  const [searchOpen, setSearchOpen] = useState(false)
  const searchWanted = useRef(false)
  const searchShown = searchOpen || query !== ''
  const openSearch = () => {
    searchWanted.current = true
    setSearchOpen(true)
    searchInput.current?.focus()
  }
  useEffect(() => {
    if (searchShown && searchWanted.current) searchInput.current?.focus()
    searchWanted.current = false
  }, [searchShown])
  const closeSearch = (focusButton: boolean) => {
    setQuery('')
    setSearchOpen(false)
    if (focusButton) requestAnimationFrame(() => searchButton.current?.focus())
  }
  const pickSort = (v: LibrarySort) => {
    setSort(v)
    try {
      localStorage.setItem(SORT_KEY, v)
    } catch {
      /* not stored; the choice holds for this visit */
    }
  }
  useEffect(() => {
    const u = new URL(globalThis.location.href)
    if (query) u.searchParams.set('q', query)
    else u.searchParams.delete('q')
    if (sort === DEFAULT_SORT) u.searchParams.delete('sort')
    else u.searchParams.set('sort', sort)
    if (u.href !== globalThis.location.href) history.replaceState(history.state, '', u)
  }, [query, sort])
  // '/' goes to the search box unless the person is typing (or composing with an IME).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      e.preventDefault()
      openSearch()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [view, setView] = useState<LibraryView>(() => viewStore.read())
  const pickView = (v: LibraryView) => {
    setView(v)
    viewStore.write(v)
  }
  const viewName = (v: LibraryView) => `${t(`library.view.${v.size}`)} ${t(`library.view.${v.layout}`)}`
  const q = query.trim()
  // Folder scope (with its subfolders while searching), then the search, then the sort.
  const items = useMemo(() => {
    let list = lib.items
    if (folderId === 'root') list = q ? list : list.filter((i) => i.folderId == null)
    else if (folderId) list = list.filter((i) => (q && folderView ? i.folderId != null && folderView.isInside(i.folderId, folderId) : i.folderId === folderId))
    if (q) {
      // Cards not downloaded yet have no title to search: hidden while searching.
      const readable = list.filter((i) => i.title !== null && !i.remote)
      const hit = new Set(librarySearch({ query: q, titles: readable.map((i) => ({ noteId: i.noteId, title: i.title! })) }).noteIds)
      list = readable.filter((i) => hit.has(i.noteId))
    }
    return sortBy(list, sort)
  }, [lib.items, sort, folderId, q, folderView])
  // Story 18.3: the subfolders as cards before the notes (a search lists notes only); `../` leads to the parent.
  const subfolders = useMemo(() => {
    if (!folderView || folderId === null || q) return []
    const dir = sort === 'nameDesc' ? -1 : 1
    return [...folderView.childrenOf(folderId)].sort((a, b) => dir * a.name.localeCompare(b.name, locale) || (a.id < b.id ? -1 : 1))
  }, [folderView, folderId, q, sort, locale])
  const parentId = inFolder && folderView && !q ? (folderView.folder(folderId)?.parentId ?? 'root') : null
  const { status } = lib
  // The first-note hint goes for good once the library has held a note.
  useEffect(() => {
    if (status === 'ready' && items.length > 0) markHint('firstNote')
  }, [status, items.length])
  const offline = useOffline()
  type Target = { noteId: string; title: string; from: HTMLElement | null }
  const [renaming, setRenaming] = useState<Target | null>(null)
  const [covering, setCovering] = useState<(Target & { coverId: string | null }) | null>(null)
  const [moving, setMoving] = useState<Target | null>(null)
  const [newFolder, setNewFolder] = useState<HTMLElement | null | false>(false)
  const [movingFolder, setMovingFolder] = useState<{ id: string; from: HTMLElement | null } | null>(null)
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; from: HTMLElement | null } | null>(null)
  const [deletingFolder, setDeletingFolder] = useState<{ id: string; from: HTMLElement | null } | null>(null)
  const [, setColorTick] = useState(0) // the color lives in localStorage; this redraws
  const [dragFolder, setDragFolder] = useState<string | null>(null)
  const [overFolder, setOverFolder] = useState<string | null>(null)
  const [undo, setUndo] = useState<{ text: string; inverse?: FolderResult['inverse'] } | null>(null)
  useEffect(() => {
    if (!undo) return
    const id = setTimeout(() => setUndo(null), SNACKBAR_MS)
    return () => clearTimeout(id)
  }, [undo])
  // Focus goes back to the control that started a dialog; a card that moved away leaves it on the first card.
  const refocus = (from: HTMLElement | null) =>
    requestAnimationFrame(() => (from?.isConnected ? from : section.current?.querySelector<HTMLElement>('a.cover-card, .fab-button'))?.focus())
  async function confirmDelete(noteId: string) {
    if (!uploads) return
    await uploads.deleteNote(noteId)
    if (!mounted.current) return
    await lib.reload()
    refocus(null)
  }
  async function moveTo(t0: Target, target: string) {
    if (!folders) return
    const r = await folders.moveNote(t0.noteId, target)
    if (r.error) return setUndo({ text: t('library.noteMoveFailed') })
    if (r.inverse) setUndo({ text: fmt(t(target === 'root' ? 'folder.noteMovedTop' : 'folder.noteMoved'), { name: t0.title, folder: folderView?.folder(target)?.name ?? '' }), inverse: r.inverse })
  }
  async function moveFolderTo(id: string, target: string) {
    if (!folders) return
    const r = await folders.moveFolder(id, target)
    if (r.error) return setUndo({ text: t('folder.failed') })
    if (r.inverse) setUndo({ text: fmt(t('folder.moved'), { name: folderView?.folder(id)?.name ?? '' }), inverse: r.inverse })
  }
  // A folder card or `../` takes a dragged folder (never into itself or below it) and a dragged note.
  const folderDrop = (target: string) => {
    const ok = dragFolder !== null && dragFolder !== target && !!folderView && !folderView.isInside(target, dragFolder) && folderView.folder(dragFolder)?.parentId !== target
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!ok && !(dragFolder === null && e.dataTransfer.types.includes(NOTE_DRAG))) return
        e.preventDefault()
        setOverFolder(target)
      },
      onDragLeave: () => setOverFolder((o) => (o === target ? null : o)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        setOverFolder(null)
        const raw = dragFolder === null ? e.dataTransfer.getData(NOTE_DRAG) : ''
        if (raw) {
          try {
            const n = JSON.parse(raw) as { noteId: string; title: string }
            void moveTo({ noteId: n.noteId, title: n.title, from: null }, target)
          } catch {
            // not one of ours
          }
          return
        }
        const from = dragFolder
        setDragFolder(null)
        if (from && ok) void moveFolderTo(from, target)
      },
    }
  }
  const noSubfolders = subfolders.length === 0
  return (
    <section
      ref={section}
      className="library"
      aria-label={t('library.label')}
      aria-busy={status === 'loading'}
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        const f = e.dataTransfer.files[0]
        if (f) void importFile(f)
      }}
    >
      <Banner />
      <div className="library-toolbar">
        <h2 className="library-heading">{t('library.label')}</h2>
        <select
          className="field-input library-view"
          aria-label={t('library.view')}
          value={`${view.layout}:${view.size}`}
          onChange={(e) => {
            const [layout, size] = e.target.value.split(':') as [LibraryView['layout'], LibraryView['size']]
            pickView({ layout, size })
          }}
        >
          {LIBRARY_LAYOUTS.flatMap((layout) =>
            LIBRARY_SIZES.map((size) => (
              <option key={`${layout}:${size}`} value={`${layout}:${size}`}>
                {viewName({ layout, size })}
              </option>
            )),
          )}
        </select>
        <select className="field-input library-sort" aria-label={t('library.sort')} value={sort} onChange={(e) => pickSort(e.target.value as LibrarySort)}>
          {LIBRARY_SORTS.map((s) => (
            <option key={s} value={s}>
              {t(`library.sort.${s}`)}
            </option>
          ))}
        </select>
        <div className={searchShown ? 'library-search is-open' : 'library-search'} role="search">
          {searchShown ? (
            <>
              <input
                ref={searchInput}
                type="search"
                className="field-input"
                aria-label={t('library.searchHint')}
                placeholder={t('library.searchHint')}
                aria-keyshortcuts="/"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onBlur={(e) => {
                  if (!query && !e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) setSearchOpen(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    closeSearch(true)
                  }
                }}
              />
              {query && (
                <button type="button" className="btn" onClick={() => { setQuery(''); searchInput.current?.focus() }}>
                  {t('library.searchClear')}
                </button>
              )}
            </>
          ) : (
            <button ref={searchButton} type="button" className="btn library-search-button" aria-label={t('library.search')} aria-keyshortcuts="/" aria-expanded={false} onClick={openSearch}>
              <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {unsaved && (
        <p role="status" className="cover-status">
          {t('library.saveFailed')}
        </p>
      )}
      <ul className="cover-grid" data-layout={view.layout} data-size={view.size}>
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
        {parentId !== null && (
          <li className="cover-item">
            <a className={`cover-card folder-card${overFolder === parentId ? ' is-over' : ''}`} href={folderHref(parentId === 'root' ? null : parentId)} aria-label={t('folder.up')} {...folderDrop(parentId)}>
              <span className="folder-thumb" aria-hidden="true">
                <span className="folder-thumb-label">../</span>
              </span>
            </a>
          </li>
        )}
        {status === 'ready' && items.length === 0 && noSubfolders && !scanning && inFolder && !q && (
          <li className="cover-status" role="status">
            {t('folder.empty')}
          </li>
        )}
        {status === 'ready' && items.length === 0 && !scanning && q && (
          <li className="cover-status" role="status">
            {fmt(t('library.searchNoResults'), { q })}
          </li>
        )}
        {status === 'ready' && items.length === 0 && noSubfolders && !scanning && !q && (
          <li>
            <button type="button" className="cover-card" onClick={(e) => openSheet(e.currentTarget)}>
              <span className="cover-thumb cover-thumb-new" aria-hidden="true">
                <svg className="icon" viewBox="0 0 16 16">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.75" fill="none" />
                </svg>
              </span>
              <span className="cover-title">{t('library.newNote')}</span>
            </button>
            {!hintSeen('firstNote') && <p className="one-line-hint">{t('hint.firstNote')}</p>}
          </li>
        )}
        {subfolders.map((f) => (
          <li key={f.id} className="cover-item">
            <a
              className={`cover-card folder-card${overFolder === f.id ? ' is-over' : ''}`}
              href={folderHref(f.id)}
              draggable={!!folders}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', f.id)
                e.dataTransfer.effectAllowed = 'move'
                setDragFolder(f.id)
              }}
              onDragEnd={() => (setDragFolder(null), setOverFolder(null))}
              {...folderDrop(f.id)}
            >
              <span className="folder-thumb" aria-hidden="true">
                <svg className="icon folder-thumb-icon" viewBox="0 0 16 16" style={{ color: getFolderColor(f.id) ?? undefined }}>
                  <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" stroke="currentColor" strokeWidth="1" fill="currentColor" fillOpacity="0.25" />
                </svg>
              </span>
              <span className="cover-text">
                <span className="cover-title">{f.name}</span>
                <span className="cover-date">{fmt(t('folder.cardNotes'), { n: String(folderView!.noteCount(f.id)) })}</span>
              </span>
            </a>
            {folders && (
              <FolderMenu
                name={f.name}
                color={getFolderColor(f.id)}
                onRename={(from) => setRenamingFolder({ id: f.id, from })}
                onMove={(from) => setMovingFolder({ id: f.id, from })}
                onDelete={(from) => setDeletingFolder({ id: f.id, from })}
                onColor={(c) => (setFolderColor(f.id, c), setColorTick((n) => n + 1))}
              />
            )}
          </li>
        ))}
        {items.map((item) => (
          <Card
            key={item.noteId}
            item={item}
            locale={locale}
            blocked={() => entering.current}
            receiving={receive.receiving.has(item.noteId)}
            offline={offline}
            onDelete={uploads ? () => void confirmDelete(item.noteId) : undefined}
            onRename={(from) => setRenaming({ noteId: item.noteId, title: item.title ?? '', from })}
            onCover={(from) => setCovering({ noteId: item.noteId, title: item.title ?? '', coverId: item.coverId ?? null, from })}
            onMove={folders && folderView ? (from) => setMoving({ noteId: item.noteId, title: item.title ?? '', from }) : undefined}
            exportCopy={async () => {
              const f = await lib.exportCopy(item.noteId)
              downloadBlob(f.name, f.bytes as BlobPart, 'application/octet-stream')
            }}
          />
        ))}
      </ul>
      {status === 'ready' && <LibraryFab onNewNote={openSheet} onImportPdf={() => pdfInput.current?.click()} {...(folders && { onNewFolder: (from: HTMLElement | null) => setNewFolder(from) })} />}
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
      {newFolder !== false && folders && (
        <NameDialog
          title={t('folder.add')}
          initial=""
          onClose={() => {
            const from = newFolder || null
            setNewFolder(false)
            refocus(from)
          }}
          onSave={async (name) => (await folders.createFolder(name, inFolder ? folderId : 'root')).error}
        />
      )}
      {movingFolder && folderView && folderView.folder(movingFolder.id) && (
        <FolderPicker
          name={folderView.folder(movingFolder.id)!.name}
          view={folderView}
          disabled={new Set(folderView.folders.filter((f) => folderView.isInside(f.id, movingFolder.id)).map((f) => f.id))}
          selected={folderView.folder(movingFolder.id)!.parentId}
          onClose={() => {
            const from = movingFolder.from
            setMovingFolder(null)
            refocus(from)
          }}
          onPick={(target) => {
            const m = movingFolder
            setMovingFolder(null)
            refocus(m.from)
            void moveFolderTo(m.id, target)
          }}
        />
      )}
      {renamingFolder && folders && folderView?.folder(renamingFolder.id) && (
        <NameDialog
          title={t('folder.rename')}
          initial={folderView.folder(renamingFolder.id)!.name}
          onClose={() => {
            const from = renamingFolder.from
            setRenamingFolder(null)
            refocus(from)
          }}
          onSave={async (name) => (await folders.renameFolder(renamingFolder.id, name)).error}
        />
      )}
      {deletingFolder && folders && folderView?.folder(deletingFolder.id) && (
        <ConfirmDialog
          body={folderView.noteCount(deletingFolder.id) === 0 ? t('folder.deleteBodyEmpty') : fmt(t('folder.deleteBody'), { n: folderView.noteCount(deletingFolder.id) })}
          confirmLabel={t('folder.deleteConfirm')}
          cancelLabel={t('library.cancel')}
          destructive
          onCancel={() => {
            const from = deletingFolder.from
            setDeletingFolder(null)
            refocus(from)
          }}
          onConfirm={() => {
            const d = deletingFolder
            setDeletingFolder(null)
            refocus(d.from)
            void folders.deleteFolder(d.id).then((r) => r.error && setUndo({ text: t('folder.failed') }))
          }}
        />
      )}
      {renaming && (
        <NameDialog
          title={t('library.noteRenameTitle')}
          label={t('library.noteNameLabel')}
          tooLong={t('library.noteNameTooLong')}
          failed={t('library.noteRenameFailed')}
          initial={renaming.title}
          onClose={() => {
            const from = renaming.from
            setRenaming(null)
            refocus(from)
          }}
          onSave={async (name) => {
            if (!(await lib.rename(renaming.noteId, name))) return 'failed'
            void uploads?.noteClosed?.(renaming.noteId) // the new name goes up now
            return undefined
          }}
        />
      )}
      {covering && (
        <CoverDialog
          current={covering.coverId}
          onClose={() => {
            const from = covering.from
            setCovering(null)
            refocus(from)
          }}
          onSave={async (id) => {
            if (id === covering.coverId || (id === null && coverUrl(covering.coverId) === null)) return true // nothing to change; an unknown id stays
            if (!(await lib.setCover(covering.noteId, id))) return false
            void uploads?.noteClosed?.(covering.noteId)
            return true
          }}
        />
      )}
      {moving && folderView && (
        <FolderPicker
          name={moving.title}
          view={folderView}
          selected={folderView.noteFolder[moving.noteId] ?? 'root'}
          onClose={() => {
            const from = moving.from
            setMoving(null)
            refocus(from)
          }}
          onPick={(target) => {
            const m = moving
            setMoving(null)
            refocus(m.from)
            void moveTo(m, target)
          }}
        />
      )}
      {undo && (
        <div role="status" className="snackbar snackbar-action">
          <span>{undo.text}</span>
          {undo.inverse && (
            <button
              type="button"
              className="snackbar-button"
              onClick={() => {
                const inverse = undo.inverse!
                setUndo(null)
                void folders?.undo(inverse)
              }}
            >
              {t('folder.undo')}
            </button>
          )}
        </div>
      )}
      <input
        ref={pdfInput}
        type="file"
        accept="application/pdf"
        hidden
        data-testid="pdf-input"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void importFile(f)
        }}
      />
      {pdf && <PdfImportDialog state={pdf} onCancel={() => pdfAbort.current?.abort()} onClose={closePdf} />}
      <LibrarySyncing />
      <span className="sr-only" aria-live="polite">
        {q && status === 'ready' ? fmt(t('library.searchResultCount'), { n: String(items.length) }) : ''}
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {pdfSaid}
      </span>
    </section>
  )
}

// The first page on the card, drawn by the writing screen's renderer. A page
// that cannot be drawn leaves an empty card.
function Thumb({ page, coverId }: { page: Page | undefined; coverId?: string | null }) {
  const art = coverUrl(coverId)
  return art ? <CoverArt url={art} /> : <PageThumb page={page} />
}

function PageThumb({ page }: { page: Page | undefined }) {
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
  onRename,
  onCover,
  onMove,
  exportCopy,
}: {
  item: LibraryItem
  locale: string
  blocked: () => boolean
  receiving: boolean
  offline: boolean
  onDelete?: () => void
  onRename: (from: HTMLElement | null) => void
  onCover: (from: HTMLElement | null) => void
  onMove?: (from: HTMLElement | null) => void
  exportCopy: () => Promise<void>
}) {
  const { t } = useI18n()
  const issue = useNoteIssue(item.noteId)
  const titleId = useId()
  const dateId = useId()
  const statusId = useId()
  const sync = useCardStatus(item.noteId).label
  const conflicted = (useNoteConflicts(item.noteId)?.length ?? 0) > 0
  const link = useRef<HTMLAnchorElement>(null)
  // The ⋯ menu: open or in its delete confirmation; `opener` gets focus back when it closes.
  const [menu, setMenu] = useState<{ confirm: boolean } | null>(null)
  const opener = useRef<HTMLElement | null>(null)
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
            <Thumb page={item.page} coverId={item.coverId} />
            {badge && <SyncBadge label={badge} />}
          </span>
          <span className="cover-text">
            <span id={titleId} className="cover-title">{item.title}</span>
            {date && <span id={dateId} className="cover-date">{date}</span>}
          </span>
          {status}
        </div>
      </li>
    )
  }
  return (
    <li className="cover-item">
      <a
        ref={link}
        className="cover-card"
        href={noteHref(item.noteId)}
        aria-keyshortcuts="F2 Delete"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(NOTE_DRAG, JSON.stringify({ noteId: item.noteId, title: item.title }))
          e.dataTransfer.effectAllowed = 'move'
        }}
        onKeyDown={(e) => {
          if (e.key === 'F2') {
            e.preventDefault()
            onRename(e.currentTarget)
          } else if (e.key === 'Delete' && onDelete) {
            e.preventDefault()
            opener.current = e.currentTarget
            setMenu({ confirm: true })
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
          <Thumb page={item.page} coverId={item.coverId} />
          {badge && <SyncBadge label={badge} />}
        </span>
        <span className="cover-text">
          <span id={titleId} className="cover-title">
            {item.title}
          </span>
          {date && (
            <span id={dateId} className="cover-date">
              {date}
            </span>
          )}
        </span>
        {status}
      </a>
      <NoteMenu
        menu={menu}
        setMenu={setMenu}
        opener={opener}
        onRename={onRename}
        onCover={onCover}
        {...(onMove && { onMove })}
        {...(onDelete && { onDelete })}
      />
    </li>
  )
}

/**
 * The ⋯ button of a card, a sibling of the card link (UX-DR83): [이름 변경] [표지 변경] [이동] [삭제].
 * [삭제] turns the menu into its confirmation in place; Esc goes back one step and focus returns to where it started.
 */
function NoteMenu({
  menu,
  setMenu,
  opener,
  onRename,
  onCover,
  onMove,
  onDelete,
}: {
  menu: { confirm: boolean } | null
  setMenu: (m: { confirm: boolean } | null) => void
  opener: { current: HTMLElement | null }
  onRename: (from: HTMLElement | null) => void
  onCover: (from: HTMLElement | null) => void
  onMove?: (from: HTMLElement | null) => void
  onDelete?: () => void
}) {
  const { t } = useI18n()
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const del = useRef<HTMLButtonElement>(null)
  const confirm = menu?.confirm === true
  // The menu starts on its first item, the confirmation on [취소].
  useEffect(() => {
    if (menu) list.current?.querySelector<HTMLElement>(confirm ? '[data-cancel]' : '[role="menuitem"]')?.focus()
  }, [menu !== null, confirm]) // eslint-disable-line react-hooks/exhaustive-deps
  // The pointer goes elsewhere: the menu closes.
  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.cover-menu')) setMenu(null)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [menu !== null]) // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => {
    setMenu(null)
    const back = opener.current?.isConnected ? opener.current : button.current
    opener.current = null
    back?.focus()
  }
  const act = (fn: (from: HTMLElement | null) => void) => () => {
    const from = opener.current ?? button.current
    opener.current = null
    setMenu(null)
    fn(from)
  }
  return (
    <div
      className="cover-menu"
      onKeyDown={(e) => {
        if (!menu) return
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          if (confirm && opener.current === null) {
            setMenu({ confirm: false })
            requestAnimationFrame(() => del.current?.focus())
          } else close()
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const items = [...list.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
          const at = items.indexOf(document.activeElement as HTMLElement)
          items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="btn cover-menu-button"
        aria-label={t('library.noteMenu')}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => (menu ? setMenu(null) : (setMenu({ confirm: false }), void (opener.current = null)))}
      >
        ⋯
      </button>
      {menu && (
        <div ref={list} role="menu" className="cover-menu-list">
          {confirm ? (
            <>
              <p role="alert" className="cover-confirm">
                {t('library.noteDeleteBody')}
              </p>
              <button
                type="button"
                role="menuitem"
                className="btn btn-destructive"
                onClick={() => {
                  setMenu(null)
                  opener.current = null
                  onDelete?.()
                }}
              >
                {t('library.noteDeleteConfirm')}
              </button>
              <button type="button" role="menuitem" className="btn" data-cancel onClick={close}>
                {t('library.cancel')}
              </button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" className="btn" aria-keyshortcuts="F2" onClick={act(onRename)}>
                {t('library.noteRename')}
              </button>
              <button type="button" role="menuitem" className="btn" onClick={act(onCover)}>
                {t('library.noteCover')}
              </button>
              {onMove && (
                <button type="button" role="menuitem" className="btn" onClick={act(onMove)}>
                  {t('library.noteMove')}
                </button>
              )}
              {onDelete && (
                <button ref={del} type="button" role="menuitem" className="btn" aria-keyshortcuts="Delete" onClick={() => setMenu({ confirm: true })}>
                  {t('library.noteDelete')}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** The ⋯ button of a folder card: [이름 변경] [이동] [색상] [삭제]. [색상] shows the fixed colors; Esc closes and focus returns to the button. */
function FolderMenu({ name, color, onRename, onMove, onDelete, onColor }: { name: string; color: string | null; onRename: (from: HTMLElement | null) => void; onMove: (from: HTMLElement | null) => void; onDelete: (from: HTMLElement | null) => void; onColor: (c: string | null) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [colors, setColors] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.cover-menu')) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  const close = () => {
    setOpen(false)
    setColors(false)
    button.current?.focus()
  }
  const act = (fn: (from: HTMLElement | null) => void) => () => {
    setOpen(false)
    setColors(false)
    fn(button.current)
  }
  return (
    <div
      className="cover-menu"
      onKeyDown={(e) => {
        if (!open) return
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close()
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const items = [...list.current!.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')]
          const at = items.indexOf(document.activeElement as HTMLElement)
          items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="btn cover-menu-button"
        aria-label={fmt(t('folder.menu'), { name })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (setOpen(!open), setColors(false))}
      >
        ⋯
      </button>
      {open && (
        <div ref={list} role="menu" className="cover-menu-list">
          <button type="button" role="menuitem" className="btn" onClick={act(onRename)}>
            {t('folder.rename')}
          </button>
          <button type="button" role="menuitem" className="btn" onClick={act(onMove)}>
            {t('folder.move')}
          </button>
          <button type="button" role="menuitem" className="btn" aria-expanded={colors} onClick={() => setColors(!colors)}>
            {t('folder.color')}
          </button>
          {colors && (
            <div role="group" aria-label={t('folder.color')} className="folder-colors">
              {[null, ...FOLDER_COLORS].map((c) => (
                <button
                  key={c ?? 'none'}
                  type="button"
                  role="menuitemradio"
                  aria-checked={c === color}
                  aria-label={c ?? t('folder.colorDefault')}
                  className="folder-color"
                  style={{ background: c ?? 'var(--color-ink-secondary)' }}
                  onClick={() => (onColor(c), close())}
                />
              ))}
            </div>
          )}
          <button type="button" role="menuitem" className="btn" onClick={act(onDelete)}>
            {t('folder.delete')}
          </button>
        </div>
      )}
    </div>
  )
}
