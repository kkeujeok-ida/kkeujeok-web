import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyEvent } from 'react'
import { fmt, useI18n, type Key } from '../../i18n'
import { defaultFor, type Pen, type PenTool } from '../../model/pen'
import { addSlot, indexAfterMove, indexAfterRemove, moveSlot, pickByTool, removeSlot } from '../../model/penSlotList'
import { elementClipboard } from '../../model/elementClipboard'
import { isBlankText } from '../../model/textLayout'
import { sessionHistory } from '../../ops/sessionHistories'
import { auth } from '../../drive/auth'
import { openNoteStore, type NoteStore } from '../../storage/noteStore'
import { acquireNoteLock } from '../../storage/noteLock'
import { sharedPenSlots, type PenSlotsStore } from '../../storage/penSlots'
import { sharedRecentColors, type RecentColorsStore } from '../../storage/recentColors'
import { savesSettled } from '../../storage/saveQueue'
import { registerOpenNote } from '../../sync/openNotes'
import type { NoteReceiver } from '../../sync/noteReceiver'
import type { UploadCoordinator } from '../../sync/uploadCoordinator'
import { Banner } from '../sync/Banner'
import { unresolvedOf } from '../../sync/conflicts'
import type { Conflict } from '../../sync/merge'
import { issueOf, useNoteConflicts, useNoteIssue, useNoteReceiving, useOffline, useSyncUi } from '../sync/syncUi'
import { readLocalSidecars, type RestoreFailure } from '../../sync/versionHistory'
import type { VersionEntry } from '../../sync/versionList'
import { SyncIndicator } from '../sync/SyncIndicator'
import { ConflictDialog, type ConflictItem, type ResolveOutcome, pageNo, resultKey } from './ConflictDialog'
import { PenPopover } from './PenPopover'
import { EraserPopover } from './EraserPopover'
import { sharedEraserSettings, type EraserSettingsStore } from '../../storage/eraserSettings'
import { PenToolbar } from './PenToolbar'
import { sharedToolbarPosition, type ToolbarPositionStore } from '../../storage/toolbarPosition'
import { sharedViewMode, VIEW_MODES, type ViewMode, type ViewModeStore } from '../../storage/viewMode'
import { sharedPenDetected, type PenDetectedStore } from '../../storage/penDetected'
import { revealShift } from './toolbarDock'
import { useToolbarDock } from './useToolbarDock'
import { SelectionMenu } from './SelectionMenu'
import { TextEditOverlay } from './TextEditOverlay'
import { VersionHistory } from './VersionHistory'
import { onResolveRequest, takeResolveRequest } from './resolveRequest'
import { detectEditedBy, sortBy, toItem } from './useLibrary'
import { neighbours, publishNoteOrder, readNoteOrder, setPendingJump, takeJump } from './noteOrder'
import { ZOOM_MAX, ZOOM_MIN } from '../../render/pagePainter'
import type { ImageHost } from '../../render/imageHost'
import { ARROW_STEP, Writer, ZOOM_STEP, type EditInfo, type ErasedInfo, type Tool, type SelectionBox, type ViewInfo, type WriterMessage } from './writer'

/** The noteId of a `#/notes/{noteId}` hash, else null. */
export function parseNoteRoute(hash: string): string | null {
  const m = /^#\/notes\/([^/]+)$/.exec(hash)
  if (!m) return null
  try {
    return decodeURIComponent(m[1]!)
  } catch {
    return null
  }
}

export const noteHref = (noteId: string) => `#/notes/${encodeURIComponent(noteId)}`
export const goToLibrary = () => globalThis.location.replace('#/')

// The hash we came from. When it was the library, "back" pops that entry instead
// of stacking a second library entry on the history.
let prevHash: string | null = null
globalThis.addEventListener?.('hashchange', (e) => {
  try {
    prevHash = new URL((e as HashChangeEvent).oldURL).hash
  } catch {
    prevHash = null
  }
})
function backToLibrary() {
  if (prevHash !== null && parseNoteRoute(prevHash) === null) globalThis.history.back()
  else goToLibrary()
}

const SNACKBAR_MS = 4000
/** The "slot deleted" snackbar with [되돌리기] stays this long. */
const DELETE_UNDO_MS = 6000
/** The scale badge stays this long after the last zoom. */
const ZOOM_BADGE_MS = 1500
/** An assertive announcement stays in its live region this long. */
const ALERT_MS = 5000
/** A blocked write is announced at most this often. */
const BLOCKED_ALERT_GAP_MS = 1000
const LEAVE_WAIT_MS = 5000
/** Opening waits for a receive; past this the wait text says so. */
export const RECEIVE_WAIT_TEXT_MS = 1000
const MESSAGE_KEY: Record<WriterMessage, Key> = {
  saveFailed: 'editor.saveFailed',
  strokeNotAdded: 'editor.strokeNotAdded',
  historyNotApplied: 'editor.historyNotApplied',
  imageTooLarge: 'editor.imageTooLarge',
  imageConverted: 'editor.imageConverted',
  imageConvertFailed: 'editor.imageConvertFailed',
  imageUnsupported: 'editor.imageUnsupported',
  imageUnreadable: 'editor.imageUnreadable',
  imageStoreFailed: 'editor.imageStoreFailed',
}

// Per note: the release of the lock a left editor still holds.
const releasing = new Map<string, Promise<void>>()
// Editors mounted in this tab: a remount (StrictMode, fast leave and reopen) is not a close.
const mountedNotes = new Set<string>()

/** A closed-note upload (or another tab) holds the note lock: wait this long for the merged result, then open read-only. */
const LOCK_WAIT_MS = 3000

/** `readOnly`: another tab holds the note. `newer`: its Drive file is of a newer format (Story 3.18). */
type Loaded = { title: string; writer: Writer; readOnly: boolean; newer: boolean }

/**
 * The writing screen: the page on a canvas, the pen toolbar and the top-left
 * editor-corner. A missing or unreadable note goes back to the library.
 */
export function NoteEditor({
  noteId,
  openStore = () => openNoteStore(undefined, { getAccount: () => auth.getState().account }),
  penStore = sharedPenSlots(),
  recentStore = sharedRecentColors(),
  eraserStore = sharedEraserSettings(),
  toolbarStore = sharedToolbarPosition(),
  viewModeStore = sharedViewMode(),
  penDetectedStore = sharedPenDetected(),
  uploads,
  receiver,
  images,
  lockWaitMs = LOCK_WAIT_MS,
}: {
  noteId: string
  openStore?: () => NoteStore
  penStore?: PenSlotsStore
  recentStore?: RecentColorsStore
  /** The eraser way and "return to the pen" (device setting). */
  eraserStore?: EraserSettingsStore
  /** Where the toolbar sits (device setting). */
  toolbarStore?: ToolbarPositionStore
  /** How the pages are laid out (device setting). */
  viewModeStore?: ViewModeStore
  /** Whether a pen was ever seen on this device (device setting). */
  penDetectedStore?: PenDetectedStore
  /** Told when the note is closed, after its last save and its lock are released (Story 3.12); records a resolved conflict (Story 3.22). */
  uploads?: Pick<UploadCoordinator, 'noteClosed'> & Partial<Pick<UploadCoordinator, 'conflictResolved' | 'syncNow'>>
  /** Receives remote changes before the editor opens and checks the remote head after (Story 3.14). */
  receiver?: Pick<NoteReceiver, 'beforeOpen' | 'noteOpened'> & Partial<Pick<NoteReceiver, 'noteClosed'>>
  /** The image bytes, their sync state and pictures (Story 4.13); without it images are grey boxes and none can be added. */
  images?: ImageHost
  /** How long a held note lock is waited for before the note opens read-only (decision: 3 s). */
  lockWaitMs?: number
}) {
  const { t } = useI18n()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [message, setMessage] = useState<{ key: WriterMessage; n: number } | null>(null)
  const [pens, setPens] = useState<Pen[]>(() => penStore.read())
  const [recent, setRecent] = useState<string[]>(() => recentStore.read())
  const [popover, setPopover] = useState<number | null>(null)
  const popoverOpen = useRef(false)
  const [eraserPop, setEraserPop] = useState(false)
  popoverOpen.current = popover !== null || eraserPop
  const [selected, setSelected] = useState(0)
  const [tool, setTool] = useState<Tool>('pen')
  const [eraser, setEraser] = useState(() => eraserStore.read())
  // Read by the writer's callbacks, which outlive a render.
  const eraserRef = useRef(eraser)
  eraserRef.current = eraser
  const erasedRef = useRef<(i: ErasedInfo) => void>(() => {})
  erasedRef.current = (i) => {
    // Back to the pen: a pen touched a stroke with the eraser tool (not a button erase, not the mouse).
    if (i.pointerType === 'pen' && i.touched && !i.temporary && eraserRef.current.returnToPen) setTool('pen')
  }
  const [edit, setEdit] = useState<EditInfo | null>(null)
  const [box, setBox] = useState<SelectionBox | null>(null)
  const [ratio, setRatio] = useState(true)
  const selectedRef = useRef(0)
  selectedRef.current = selected
  const pensRef = useRef(pens)
  pensRef.current = pens
  // The slot last used per tool (P / H pick it); carried through moves and deletes with the slot.
  const lastUsed = useRef<Record<PenTool, number | null>>({ pen: null, highlighter: null })
  useEffect(() => {
    const p = pens[selected]
    if (p) lastUsed.current[p.tool] = selected
  }, [pens, selected])
  // The state before the last delete, for [되돌리기]; any other slot change drops it.
  const [deleted, setDeleted] = useState<{ pens: Pen[]; selected: number; last: Record<PenTool, number | null> } | null>(null)
  // Bumped when the history changes so the undo/redo buttons re-read their state.
  const [, setRevision] = useState(0)
  const [view, setView] = useState<ViewInfo | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>(() => viewModeStore.read())
  const [modeSay, setModeSay] = useState('')
  // The note is being received before it opens, for over a second.
  const [slow, setSlow] = useState(false)
  // Writes refused on a conflict page (Story 3.20): the banner is emphasized, "읽기 전용 페이지예요" is announced.
  const [blocked, setBlocked] = useState(0)
  const [alert, setAlert] = useState({ text: '', n: 0 })
  const say = (text: string) => setAlert((a) => ({ text, n: a.n + 1 }))
  const imagesRef = useRef(images)
  imagesRef.current = images
  const picker = useRef<HTMLInputElement>(null)
  const sayRef = useRef(say)
  sayRef.current = say
  const tRef = useRef(t)
  tRef.current = t
  const lastBlockedAlert = useRef(-Infinity)
  // The conflict resolve dialog (Story 3.22): the items it shows, who had focus before, the polite result words.
  const ui = useSyncUi()
  const [dialog, setDialog] = useState<ConflictItem[] | null>(null)
  const dialogOpener = useRef<HTMLElement | null>(null)
  const dialogOpening = useRef(false)
  const [resultText, setResultText] = useState('')
  // Resolutions that are in the note but whose `sync.json` write failed, by page id and rev: a retry only writes
  // `sync.json` again, so the note is never resolved twice (keep-both would add a page).
  const unrecorded = useRef(new Map<string, { conflict: Conflict; used: string }>())
  // Pages this editor just settled: an older status snapshot that still lists them must not lock them again.
  const settledPages = useRef(new Set<string>())
  // Unresolved entries the dialog could not show (no sidecar / no page).
  const skipped = useRef(0)
  const wantResolve = useRef(false)
  // The version history dialog (Story 3.25).
  const [historyOpen, setHistoryOpen] = useState(false)
  const receiving = useNoteReceiving(noteId)
  const receivingRef = useRef(receiving)
  receivingRef.current = receiving

  const section = useRef<HTMLElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const dock = useToolbarDock(toolbarStore, toolbar, !!loaded)
  const pageArea = useRef<HTMLDivElement>(null)
  const dockRef = useRef(dock)
  dockRef.current = dock
  const canvas = useRef<HTMLCanvasElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const leaving = useRef(false)
  const mounted = useRef(true)
  const descId = useId()

  // Takes the note's lock, loads the note and owns its store until the editor is
  // left. Without the lock the note opens read-only and is reloaded when the
  // other tab lets go.
  useEffect(() => {
    mounted.current = true
    mountedNotes.add(noteId)
    // A request made for this open is taken now (and any other is dropped): it never outlives it.
    wantResolve.current ||= takeResolveRequest(noteId)
    let live = true
    let writer: Writer | null = null
    let unregister: () => void = () => {}

    // A save of this note that is still running must land before it is read.
    const load = async (readOnly: boolean): Promise<Loaded | null> => {
      const store = openStore()
      try {
        await savesSettled(3000)
        const r = live ? await store.loadNote(noteId) : null
        // A newer-format remote file was found earlier: the note opens read-only from the first frame.
        const sync = live ? await store.readSync(noteId).catch(() => null) : null
        const err = sync?.info.lastError ?? null
        const newer = err?.class === 'unreadable' && err.reason === 'unsupportedVersion'
        if (live) {
          const note = r?.result === 'ok' ? r.note : undefined
          const title: unknown = note?.meta?.title
          if (!note || typeof title !== 'string' || !Array.isArray(note.pages) || note.pages.length === 0) {
            goToLibrary()
          } else {
            const make = (n: typeof note, st: typeof store): Writer => {
              const w = new Writer(
                sessionHistory(n),
                st,
                // Read at each stroke, so a toggle applies from the next one.
                () => {
                  const l = penStore.read()
                  return l[selectedRef.current] ?? l[0]!
                },
                (key) => live && setMessage((p) => ({ key, n: (p?.n ?? 0) + 1 })),
                detectEditedBy,
                () => live && setRevision((n) => n + 1),
              )
              w.readOnly = readOnly || newer
              w.images = imagesRef.current ?? null
              // Pages with an unresolved conflict are read-only from the first frame (Story 3.20).
              if (sync) w.history.setLocked(unresolvedOf(sync.info).map((c) => String(c.pageId)))
              w.onBlocked = () => {
                if (!live) return
                setBlocked((n) => n + 1)
                const now = Date.now()
                if (now - lastBlockedAlert.current < BLOCKED_ALERT_GAP_MS) return
                lastBlockedAlert.current = now
                sayRef.current(tRef.current('editor.pageReadOnly'))
              }
              // The toolbar and the gap are measured when the view is laid out.
              w.insets = () => {
                // The token may be rem: measure it as a length instead of reading its text.
                const probe = document.createElement('div')
                probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--spacing-3)'
                document.body.append(probe)
                const px = probe.getBoundingClientRect().width
                probe.remove()
                const g = px > 0 ? px : 12
                // The top-docked toolbar keeps its room (existing behaviour, tests); a left/right dock or a float in the upper half takes none; the lower half covers the bottom edge.
                const el = toolbar.current
                const r = el?.getBoundingClientRect()
                const low = !!r && (r.top + r.bottom) / 2 > window.innerHeight / 2
                return { gap: g, extraBottom: !el || (!dockRef.current.floating && dockRef.current.pos.dock === 'top') || low ? el ? el.offsetHeight + g : g : 0 }
              }
              w.onView = (v) => live && setView(v)
              w.onBox = (b) => live && setBox(b)
              w.onErased = (i) => live && erasedRef.current(i)
              w.eraserMode = eraserRef.current.mode
              w.onEdit = (i) => live && setEdit(i)
              // Nothing is announced for an empty selection.
              w.onSelection = (n) => live && n > 0 && setResultText(fmt(tRef.current('editor.selected'), { n }))
              return w
            }
            let w = make(note, store)
            writer = w // owned from here: the cleanup finalizes it
            // A writable editor is the tab that may upload this note while it is open.
            const register = (x: Writer) =>
              registerOpenNote(noteId, {
                flush: () => x.flushSaves(),
                unsaved: () => x.unsaved(),
                strokeEnd: () => x.strokeEnd(),
                current: () => x.history.note,
                applyMerge: (a) => x.applyMerge(a),
              })
            unregister()
            unregister = readOnly ? () => {} : register(w)
            // A receive may have replaced the note before it was registered as open: read it again and,
            // when the disk has another note, start the editor from that one (nothing of ours is unsaved yet).
            if (!readOnly) {
              let fresh: typeof note | undefined
              try {
                const again = await store.loadNote(noteId)
                fresh = again?.result === 'ok' ? again.note : undefined
              } catch {
                // keep the first writer
              }
              if (live && fresh && !w.unsaved() && JSON.stringify(fresh) !== JSON.stringify(w.history.note)) {
                unregister()
                // The old writer holds nothing unsaved; finalizing it closes its store, so the new one gets its own.
                await w.finalize().catch(() => {})
                w = make(fresh, openStore())
                writer = w
                unregister = register(w)
              }
            }
            return { title, writer: w, readOnly, newer }
          }
        }
      } catch {
        if (live) goToLibrary()
      }
      // Without a writer nobody else will close the connection.
      store.close()
      return null
    }

    // A lock this tab's own earlier effect is still giving up (StrictMode, fast
    // leave and reopen) must be gone first, or the new load would open read-only.
    const lockP = (async () => {
      await releasing.get(noteId)
      if (receiver) {
        // A card or a note with a remote change is received first (UX-DR58); on failure the device copy opens.
        const timer = setTimeout(() => live && setSlow(true), RECEIVE_WAIT_TEXT_MS)
        try {
          await receiver.beforeOpen(noteId)
        } catch {
          // a card that could not be downloaded leaves no note: the load below goes back to the library
        } finally {
          clearTimeout(timer)
          if (live) setSlow(false)
        }
      }
      return acquireNoteLock(noteId)
    })()

    void (async () => {
      const l = await lockP
      if (!live) return // the cleanup releases it
      // The working copy is read only with the lock (it is then what an upload left merged); a lock that stays
      // taken opens the note read-only, and the editor takes over when it frees.
      if (l.state === 'waiting' && lockWaitMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([l.whenHeld, new Promise<void>((r) => (timer = setTimeout(r, lockWaitMs)))])
        } catch {
          // a rejected wait is treated as the wait being over
        } finally {
          clearTimeout(timer)
        }
        if (!live) return
      }
      const cur = await load(l.state === 'waiting')
      if (!cur) return void l.release()
      // A lock granted while the first load ran: do not show the stale read-only note.
      if (live && !(cur.readOnly && l.state === 'held')) setLoaded(cur)
      // The remote head is asked once the editor is up; a change comes in through it.
      if (live && !cur.readOnly) void receiver?.noteOpened(noteId).catch(() => {})
      if (!cur.readOnly) return
      await l.whenHeld
      if (!live) return
      // The other tab's final save has landed: read what it wrote, as the writer.
      await cur.writer.finalize().catch(() => {})
      const next = live ? await load(false) : null
      if (!live) return
      if (next) setLoaded(next)
      else {
        setLoaded(null) // no banner over a note that is gone
        void l.release()
      }
    })()

    return () => {
      live = false
      mounted.current = false
      mountedNotes.delete(noteId)
      // Leaving by the browser's back button ends here: finish and save in the
      // background; the library waits for it before it lists the notes. The
      // lock goes last, so the next tab reads the final save.
      const done: Promise<void> = (writer?.finalize().catch(() => {}) ?? Promise.resolve())
        .then(() => lockP)
        .then((l) => l.release())
        .catch(() => {})
        .then(async () => {
          // No longer the open note: the receiver below deletes a note only when none is open.
          unregister()
          // A note Drive deleted is removed now (nothing unsent) or restored (something unsent), once it is not open.
          if (!mountedNotes.has(noteId)) await receiver?.noteClosed?.(noteId).catch(() => {})
        })
        .then(() => {
          // The last save is on disk and the lock is free: the closing upload may read the note.
          if (!mountedNotes.has(noteId)) void uploads?.noteClosed(noteId)
        })
        .finally(() => {
          if (releasing.get(noteId) === done) releasing.delete(noteId)
        })
      releasing.set(noteId, done)
    }
    // openStore is read once per note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId])

  // The library that had focus is gone; put focus on the way back.
  const ready = loaded !== null
  useEffect(() => {
    if (ready) back.current?.focus()
  }, [ready])

  useEffect(() => {
    if (!loaded || !canvas.current) return
    return loaded.writer.attach(canvas.current)
  }, [loaded])

  // The words of the placeholders; a change of the pictures or of their sync state repaints and re-reads the image list.
  useEffect(() => {
    if (!loaded || !images) return
    images.labels = { downloading: t('image.downloading'), failed: t('image.failed'), broken: t('image.broken') }
    return images.subscribe(() => {
      loaded.writer.redraw()
      setRevision((n) => n + 1)
    })
  }, [loaded, images, t])

  // Image files go in by the toolbar picker, by drop and by paste: each one is one edit, selected afterwards (Story 4.13).
  const addImages = (files: Blob[], at?: { x: number; y: number } | 'center') => {
    const w = loaded?.writer
    if (!w || files.length === 0) return
    void (async () => {
      for (const f of files) {
        if (await w.insertImage(f, at)) {
          w.setTool('lasso')
          setTool('lasso')
        }
      }
    })()
  }
  const isImageFile = (f: File) => f.type.startsWith('image/') || /.(heic|heif)$/i.test(f.name)
  useEffect(() => {
    if (!loaded || !images) return
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types?.includes('Files')
    // A file dropped anywhere on the page must not make the browser open it.
    const onOver = (e: DragEvent) => hasFiles(e) && e.preventDefault()
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      if (popoverOpen.current || document.querySelector('[role="dialog"], [aria-modal="true"]')) return
      e.preventDefault()
      addImages([...(e.dataTransfer?.files ?? [])].filter(isImageFile), { x: e.clientX, y: e.clientY })
    }
    document.addEventListener('dragover', onOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragover', onOver)
      document.removeEventListener('drop', onDrop)
    }
  })

  // The snackbar goes away by itself.
  useEffect(() => {
    if (!message) return
    const id = setTimeout(() => setMessage(null), SNACKBAR_MS)
    return () => clearTimeout(id)
  }, [message])

  // The Drive file turned out to be of a newer format while the note is open: read-only from now on.
  const issue = useNoteIssue(noteId)
  const newer = issue?.kind === 'newVersion' || loaded?.newer === true
  useEffect(() => {
    if (newer && loaded) loaded.writer.readOnly = true
  }, [newer, loaded])
  const readOnly = (loaded?.readOnly ?? false) || newer
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  // Conflict pages (Story 3.20): the writer learns about pages the status store knows (never unlocks), and
  // a conflict that appears while the editor is open is announced at once.
  const conflicts = useNoteConflicts(noteId)
  const knownConflicts = useRef<Set<string> | null>(null)
  const conflictsRef = useRef(conflicts)
  conflictsRef.current = conflicts
  useEffect(() => {
    if (!conflicts) return
    for (const id of settledPages.current) if (!conflicts.some((c) => c.pageId === id)) settledPages.current.delete(id)
    loaded?.writer.history.lockPages(conflicts.map((c) => c.pageId).filter((id) => !settledPages.current.has(id)))
    const known = knownConflicts.current
    const fresh = known ? conflicts.find((c) => !known.has(c.pageId)) : undefined
    knownConflicts.current = new Set(conflicts.map((c) => c.pageId))
    if (fresh) {
      say(fmt(t(fresh.kind === 'remoteDeleted' ? 'editor.conflictDetectedDeleted' : 'editor.conflictDetected'), { n: fresh.originalIndex + 1 }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicts, loaded])
  // An assertive announcement goes away by itself.
  useEffect(() => {
    if (!alert.text) return
    const id = setTimeout(() => setAlert((a) => ({ ...a, text: '' })), ALERT_MS)
    return () => clearTimeout(id)
  }, [alert])
  useEffect(() => {
    if (!resultText) return
    const id = setTimeout(() => setResultText(''), ALERT_MS)
    return () => clearTimeout(id)
  }, [resultText])
  // Read-only began while the popover was open: close it.
  useEffect(() => {
    if (readOnly) {
      setPopover(null)
      setEraserPop(false)
    }
  }, [readOnly])
  // The writer follows the tool (a reloaded writer starts as the pen); the pen drops the selection.
  useEffect(() => {
    loaded?.writer.setTool(tool)
  }, [loaded, tool])
  useEffect(() => {
    if (loaded) loaded.writer.eraserMode = eraser.mode
  }, [loaded, eraser.mode])
  useEffect(() => {
    if (loaded) loaded.writer.ratioLock = ratio
  }, [loaded, ratio])
  // F6 / Shift+F6 cycle corner -> toolbar -> canvas; 1 picks the first slot.
  useEffect(() => {
    if (!ready) return
    // A key press while a mouse-focused button holds focus makes :focus-visible match it; mark pointer focus so CSS can hide that ring. Tab / F6 clear it.
    const onPointer = (e: PointerEvent) => {
      if (toolbar.current?.contains(e.target as Node)) toolbar.current.dataset.pointerFocus = ''
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' || e.key === 'F6') delete toolbar.current?.dataset.pointerFocus
      if (e.ctrlKey || e.altKey || e.metaKey || popoverOpen.current) return
      const regions = [section.current?.querySelector<HTMLElement>('[data-banner]'), back.current?.parentElement, toolbar.current, canvas.current].filter((r): r is HTMLElement => !!r)
      const active = document.activeElement
      if (e.key === 'F6') {
        const at = regions.findIndex((r) => r.contains(active))
        const step = e.shiftKey ? -1 : 1
        const next = at < 0 ? (step > 0 ? 0 : regions.length - 1) : (at + step + regions.length) % regions.length
        e.preventDefault()
        const to = regions[next]
        if (to === toolbar.current) toolbar.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus()
        else if (to === canvas.current) canvas.current?.focus()
        else if (to?.hasAttribute('data-banner')) (to.querySelector<HTMLElement>('button, a') ?? to).focus()
        else back.current?.focus()
      } else if (/^Digit[1-9]$/.test(e.code) || /^[1-9]$/.test(e.key) || e.code === 'KeyP' || e.code === 'KeyH' || /^[ph]$/i.test(e.key)) {
        // 1-9 pick that slot; P / H the last used pen / highlighter slot.
        const target = e.target as Element | null
        const inside = [toolbar.current, canvas.current].some((r) => r && (r.contains(target) || r.contains(active)))
        if (!inside || readOnly || e.shiftKey || e.repeat || e.isComposing) return
        if (target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || document.querySelector('[role="dialog"], [aria-modal="true"]')) return
        const digit = /^Digit([1-9])$/.exec(e.code)?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : '')
        const list = pensRef.current
        const i = digit
          ? Number(digit) - 1
          : (['pen', 'highlighter'] as const).map((k) => pickByTool(list, k, lastUsed.current[k]))[e.code === 'KeyH' || e.key.toLowerCase() === 'h' ? 1 : 0]!
        if (i < 0 || i >= list.length) return
        e.preventDefault()
        setSelected(i)
        setTool('pen')
      } else if ((e.code === 'KeyL' || e.key.toLowerCase() === 'l') && !e.shiftKey && !e.repeat && !e.isComposing) {
        const target = e.target as Element | null
        const inside = [toolbar.current, canvas.current].some((r) => r && (r.contains(target) || r.contains(active)))
        if (inside && !target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) setTool('lasso')
      } else if ((e.code === 'KeyE' || e.key.toLowerCase() === 'e') && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && !e.isComposing) {
        const target = e.target as Element | null
        const inside = [toolbar.current, canvas.current].some((r) => r && (r.contains(target) || r.contains(active)))
        if (inside && !readOnly && !target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') && !document.querySelector('[role="dialog"], [aria-modal="true"]')) setTool('eraser')
      } else if ((e.code === 'KeyT' || e.key.toLowerCase() === 't') && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && !e.isComposing) {
        const target = e.target as Element | null
        const inside = [toolbar.current, canvas.current].some((r) => r && (r.contains(target) || r.contains(active)))
        if (inside && !readOnly && !target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) setTool('text')
      }
    }
    // Capture, so a handler lower down cannot hide the key.
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointer, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointer, true)
    }
  }, [ready, readOnly])

  // Slot list changes. Each one writes the device setting and drops a pending delete undo.
  const commitSlots = (next: Pen[]) => {
    penStore.write(next)
    setPens(next)
    setDeleted(null)
  }
  const focusSlot = (i: number) => setTimeout(() => toolbar.current?.querySelector<HTMLElement>(`[data-slot="${i}"]`)?.focus(), 0)
  const addPenSlot = () => {
    if (readOnly) return
    const next = addSlot(pens, selected)
    commitSlots(next)
    setSelected(next.length - 1)
    setTool('pen')
    if (!loaded?.writer.busy()) setPopover(next.length - 1)
  }
  const movePenSlot = (from: number, to: number) => {
    if (readOnly || from === to || !pens[from] || to < 0 || to >= pens.length) return
    commitSlots(moveSlot(pens, from, to))
    setSelected(indexAfterMove(selected, from, to))
    for (const k of ['pen', 'highlighter'] as const) {
      const l = lastUsed.current[k]
      if (l !== null) lastUsed.current[k] = indexAfterMove(l, from, to)
    }
    setAnnounce(fmt(t('editor.slotMoved'), { n: to + 1 }))
  }
  const deletePenSlot = (i: number) => {
    if (readOnly || pens.length <= 1 || !pens[i]) return
    const snapshot = { pens, selected, last: { ...lastUsed.current } }
    const next = removeSlot(pens, i)
    commitSlots(next)
    const kept = indexAfterRemove(selected, i)
    if (kept === null) setTool('pen')
    const to = kept ?? Math.min(i, next.length - 1)
    setSelected(to)
    for (const k of ['pen', 'highlighter'] as const) {
      const l = lastUsed.current[k]
      if (l !== null) lastUsed.current[k] = indexAfterRemove(l, i)
    }
    setPopover(null)
    setDeleted(snapshot)
    focusSlot(to)
  }
  const undoDelete = () => {
    if (!deleted || readOnly) return
    commitSlots(deleted.pens)
    setSelected(deleted.selected)
    lastUsed.current = deleted.last
    focusSlot(deleted.selected)
  }
  useEffect(() => {
    if (!deleted) return
    const id = setTimeout(() => setDeleted(null), DELETE_UNDO_MS)
    return () => clearTimeout(id)
  }, [deleted])

  // Ctrl/Cmd+Z undoes, Ctrl+Y and Ctrl/Cmd+Shift+Z redo, wherever focus is
  // except in a text field (which keeps its own undo).
  useEffect(() => {
    if (!loaded) return
    const { writer } = loaded
    const typing = (n: EventTarget | null) => {
      const el = n as HTMLElement | null
      return !!el?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    }
    const onKey = (e: KeyboardEvent) => {
      // A held key or an IME composition must not undo again and again.
      if (e.repeat || e.isComposing || !(e.ctrlKey || e.metaKey) || e.altKey) return
      // The physical key first: other layouts (Hangul) report 'ㅋ' or 'Process'.
      const k = e.code === 'KeyZ' ? 'z' : e.code === 'KeyY' ? 'y' : e.key.toLowerCase()
      if (k !== 'z' && k !== 'y') return
      if (k === 'y' && (!e.ctrlKey || e.shiftKey)) return // no Cmd+Y
      if (typing(e.target) || typing(document.activeElement)) return
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return
      if (writer.readOnly) return
      const redo = k === 'y' || e.shiftKey
      if (redo ? writer.redo() : writer.undo()) e.preventDefault()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [loaded])

  // Ctrl/Cmd+A on the canvas selects the whole page with the lasso; Esc drops the selection.
  useEffect(() => {
    if (!loaded) return
    const { writer } = loaded
    const typingTarget = (n: EventTarget | null) => !!(n as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.altKey) return
      if (e.key === 'Escape') {
        if (typingTarget(e.target)) return
        // Esc in the selection menu only returns to the canvas (the selection stays).
        if ((e.target as HTMLElement | null)?.closest?.('[data-selection-menu]')) return
        // A menu, popover or dialog closes first.
        if (popoverOpen.current || document.querySelector('[role="dialog"], [aria-modal="true"], [role="menu"]')) return
        if (writer.selectedCount > 0) {
          writer.clearSelection()
          e.preventDefault()
        }
        return
      }
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || !(e.code === 'KeyA' || e.key.toLowerCase() === 'a')) return
      if (document.activeElement !== canvas.current || typingTarget(e.target) || popoverOpen.current) return
      e.preventDefault()
      writer.setTool('lasso')
      setTool('lasso')
      writer.selectAll()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [loaded])

  // Ctrl+C / X / V and Delete on the canvas act on the elements (Story 4.7); the tab's own clipboard, never the system's.
  // Focus in a field, a dialog or the selection menu keeps the browser's behavior.
  useEffect(() => {
    if (!loaded) return
    const { writer } = loaded
    const typing = (n: EventTarget | null) => !!(n as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.isComposing || e.altKey || e.shiftKey) return
      if (document.activeElement !== canvas.current || typing(e.target) || popoverOpen.current) return
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return
      const mod = e.ctrlKey || e.metaKey
      // The typed letter first (Dvorak, Colemak); the physical key only for non-Latin layouts (Hangul).
      const k = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : e.code === 'KeyC' ? 'c' : e.code === 'KeyX' ? 'x' : e.code === 'KeyV' ? 'v' : ''
      let done = false
      if (mod) {
        if (k === 'c') done = writer.copySelection()
        else if (k === 'x') done = writer.cutSelection()
        // Elements copied here and nothing since the window lost focus: they win; else the paste event decides (text first).
        else if (k === 'v' && elementClipboard.fresh && (done = writer.pasteClipboard())) {
          writer.setTool('lasso')
          setTool('lasso')
        }
      } else if (e.key === 'Delete') done = writer.deleteSelection()
      if (done) e.preventDefault()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [loaded])

  // The paste event on the canvas (Story 4.10): plain text from the system clipboard becomes a text box. It is read from the
  // event only, never with the async clipboard API. Elements copied in this tab win while the window kept its focus.
  useEffect(() => {
    if (!loaded) return
    const { writer } = loaded
    const onPaste = (e: ClipboardEvent) => {
      if (document.activeElement !== canvas.current || popoverOpen.current) return
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return
      // No elements copied here, an image file on the system clipboard: an image (Story 4.13). Else the text rules below.
      const pics = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (!elementClipboard.fresh && pics.length > 0) {
        e.preventDefault()
        addImages(pics.slice(0, 1))
        return
      }
      const text = e.clipboardData?.getData('text/plain') ?? ''
      const done = !elementClipboard.fresh && !isBlankText(text) ? writer.pasteText(text) : elementClipboard.size > 0 ? writer.pasteClipboard() : writer.pasteText(text)
      if (done) {
        writer.setTool('lasso')
        setTool('lasso')
      }
      e.preventDefault()
    }
    document.addEventListener('paste', onPaste, true)
    return () => document.removeEventListener('paste', onPaste, true)
  }, [loaded])

  // A press outside the box in edit (and outside its bar) confirms it; the canvas handles its own presses.
  useEffect(() => {
    setEdit(null)
    if (!loaded) return
    const { writer } = loaded
    const onPress = (e: PointerEvent) => {
      if (!writer.editing) return
      const n = e.target as Element | null
      if (n?.closest?.('[data-text-edit]') || (n && canvas.current?.contains(n))) return
      writer.commitEdit()
    }
    document.addEventListener('pointerdown', onPress, true)
    return () => document.removeEventListener('pointerdown', onPress, true)
  }, [loaded])

  // Text tool + Enter (not while typing in a box): a new box in the middle of the view.
  useEffect(() => {
    if (!loaded || tool !== 'text') return
    const { writer } = loaded
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (document.activeElement !== canvas.current || writer.editing || popoverOpen.current) return
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return
      if (writer.createTextAtCenter()) e.preventDefault()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [loaded, tool])

  // Canvas focus: Ctrl/Cmd+= + - 0 zoom and fit, arrows scroll. Space is the hand
  // while focus is on the canvas, and not in a text field.
  useEffect(() => {
    if (!loaded) return
    const { writer } = loaded
    const typing = (n: EventTarget | null) =>
      !!(n as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    const isSpace = (e: KeyboardEvent) => e.code === 'Space' || e.key === ' '
    const onDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.altKey) return
      const active = document.activeElement
      const onCanvas = active === canvas.current
      if (isSpace(e)) {
        if (e.ctrlKey || e.metaKey || typing(e.target) || typing(active)) return
        if (!onCanvas) return // on a button Space presses it
        writer.setHand(true)
        if (onCanvas) e.preventDefault()
        return
      }
      if (!onCanvas) return
      // PgUp / PgDn / Home / End move between the pages of a note that has more than one.
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && writer.history.note.pages.length > 1) {
        const last = writer.history.note.pages.length - 1
        if (e.key === 'PageDown' || e.key === 'PageUp') {
          e.preventDefault()
          writer.pageStep(e.key === 'PageDown' ? 1 : -1)
          return
        }
        if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault()
          writer.goToPage(e.key === 'Home' ? 0 : last)
          return
        }
      }
      if (e.ctrlKey || e.metaKey) {
        const zoomIn = e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd'
        const zoomOut = e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract'
        const reset = e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0'
        if (!zoomIn && !zoomOut && !reset) return
        e.preventDefault()
        if (reset) writer.fit('width')
        else writer.zoomBy(zoomIn ? ZOOM_STEP : 1 / ZOOM_STEP)
        return
      }
      const arrow: Record<string, [number, number]> = {
        ArrowLeft: [-ARROW_STEP, 0],
        ArrowRight: [ARROW_STEP, 0],
        ArrowUp: [0, -ARROW_STEP],
        ArrowDown: [0, ARROW_STEP],
      }
      // With a selection the arrows move it (1 pt, Shift 10 pt); without one, or read-only, they scroll.
      const nudge: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
      const n = nudge[e.key]
      if (n && !e.isComposing && writer.nudge(n[0] * (e.shiftKey ? 10 : 1), n[1] * (e.shiftKey ? 10 : 1))) {
        e.preventDefault()
        return
      }
      const d = arrow[e.key]
      if (d && !e.shiftKey) {
        e.preventDefault()
        writer.scroll(d[0], d[1])
      }
    }
    const onUp = (e: KeyboardEvent) => {
      // After a drag with Space held, its release must not press a toolbar button.
      if (isSpace(e) && writer.setHand(false)) e.preventDefault()
    }
    document.addEventListener('keydown', onDown, true)
    document.addEventListener('keyup', onUp, true)
    return () => {
      document.removeEventListener('keydown', onDown, true)
      document.removeEventListener('keyup', onUp, true)
    }
  }, [loaded])

  // The page layout and the pen record are device settings the writer follows.
  useEffect(() => {
    loaded?.writer.setViewMode(viewMode)
  }, [loaded, viewMode])
  useEffect(() => {
    if (!loaded) return
    const { writer } = loaded
    writer.penOnly = penDetectedStore.read()
    writer.onPenSeen = () => {
      penDetectedStore.mark()
      writer.penOnly = true
    }
  }, [loaded, penDetectedStore])

  // A toolbar that changes height changes the room under the page.
  useEffect(() => {
    if (!loaded || !toolbar.current || typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(() => loaded.writer.layout())
    ro.observe(toolbar.current)
    return () => ro.disconnect()
  }, [loaded])

  // A dock change that keeps the toolbar's size does not resize it: lay the view out again.
  useEffect(() => {
    loaded?.writer.layout()
  }, [loaded, dock.pos])

  // A focused text box or button on the page that the toolbar covers is scrolled clear, once (UX-DR21).
  useEffect(() => {
    const area = pageArea.current
    if (!loaded || !area) return
    const onIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement
      const bar = toolbar.current
      if (!bar || el.tagName === 'CANVAS' || loaded.writer.busy()) return
      const m = revealShift(el.getBoundingClientRect(), bar.getBoundingClientRect(), area.getBoundingClientRect())
      // The view moves the other way from the box: panning right slides the page left.
      if (m) loaded.writer.panBy(-m.x, -m.y)
    }
    area.addEventListener('focusin', onIn)
    return () => area.removeEventListener('focusin', onIn)
  }, [loaded])

  // The zoom menu closes on Esc or a press outside, and focus returns to the button.
  useEffect(() => {
    if (!menuOpen) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setMenuOpen(false)
      more.current?.focus()
    }
    const onPress = (e: PointerEvent) => {
      const n = e.target as Node
      if (menu.current?.contains(n) || more.current?.contains(n)) return
      setMenuOpen(false)
      more.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPress, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPress, true)
    }
  }, [menuOpen])

  const onMenuKeyDown = (e: ReactKeyEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const items = [...menu.current!.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length : i) - 1
    items[next]?.focus()
  }

  const leave = (then: () => void) => {
    if (!loaded || leaving.current) return
    leaving.current = true
    // Finish the stroke and the saves first; leave even when the last try fails.
    // finalize never rejects in practice; if it hangs, leave after 5 s anyway.
    const done = loaded.writer.finalize().catch(() => {})
    const giveUp = new Promise<void>((r) => setTimeout(r, LEAVE_WAIT_MS))
    void Promise.race([done, giveUp]).then(() => mounted.current && then())
  }
  const onBack = () => leave(backToLibrary)

  // The library's order (Story 5.14). A note opened by address has no published order: the notes by name stand in for it.
  const [orderTick, setOrderTick] = useState(0)
  useEffect(() => {
    if (!loaded || readNoteOrder().some((i) => i.noteId === noteId)) return
    let live = true
    const store = openStore()
    store
      .listNotes()
      .then((es) => {
        if (live) publishNoteOrder(sortBy(es.map(toItem), 'nameAsc').map((i) => ({ noteId: i.noteId, title: i.title, remote: !!i.remote, blocked: !!i.blocked })))
      })
      .catch(() => {})
      .finally(() => {
        store.close()
        if (live) setOrderTick((n) => n + 1)
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, noteId])
  const offline = useOffline()
  const unreadableNote = (i: { noteId: string }) => {
    const snap = ui?.status.getSnapshot()
    return issueOf(snap?.notes.get(i.noteId))?.kind === 'unreadable'
  }
  void orderTick
  const around = neighbours(readNoteOrder(), noteId, { offline, skip: unreadableNote })
  const jump = (dir: -1 | 1) => {
    const to = dir < 0 ? around.prev : around.next
    if (!to || !loaded || leaving.current) return
    setMenuOpen(false)
    loaded.writer.commitEdit()
    loaded.writer.clearSelection()
    const from = { fromId: noteId, fromTitle: loaded.title, toId: to }
    leave(() => {
      setPendingJump(from)
      globalThis.location.hash = noteHref(to)
    })
  }
  // Arrival by a jump: the position chip, "back to ..." with [되돌리기] and a polite word.
  const [chip, setChip] = useState<string | null>(null)
  const [backText, setBackText] = useState<string | null>(null)
  useEffect(() => {
    if (!loaded) return
    const j = takeJump(noteId)
    if (!j) return
    const p = neighbours(readNoteOrder(), noteId, { offline, skip: unreadableNote })
    setChip(fmt(t('editor.noteChip'), { title: loaded.title, n: p.n, total: p.total }))
    setBackText(fmt(t('editor.noteBackTo'), { title: j.fromTitle }))
    setResultText(fmt(t('editor.noteOpened'), { title: loaded.title }))
    // No cleanup: a reload of the same note (read-only -> writer) must not strand the chip.
    setTimeout(() => setChip(null), SNACKBAR_MS)
    setTimeout(() => setBackText(null), DELETE_UNDO_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  /**
   * The unresolved conflicts with both versions at hand. An entry whose sidecar record is gone, or whose page is gone
   * (other than a page the other device deleted), is skipped: there is nothing to compare.
   */
  const loadItems = async (l: Loaded): Promise<{ items: ConflictItem[]; unresolved: number }> => {
    const s = await l.writer.store.readSync(noteId) // never throws; an unreadable record has no conflicts
    const un = unresolvedOf(s.info)
    const items: ConflictItem[] = []
    if (un.length === 0) return { items, unresolved: 0 }
    const otherTime = await (ui?.otherTime?.(s.info.fileId ?? null) ?? Promise.resolve(null)).catch(() => null)
    for (const c of un) {
      try {
        const sc = await l.writer.store.sidecars.get(noteId, String(c.pageId), String(c.rev))
        if (!sc) continue
        const cur = l.writer.history.note.pages.find((p) => p.id === c.pageId) ?? null
        if (!cur && c.kind !== 'remoteDeleted') continue
        const entry = { ...c, originalIndex: typeof c.originalIndex === 'number' ? c.originalIndex : 0 } as unknown as Conflict
        items.push({ entry, sidecar: sc, current: cur, otherTime })
      } catch {
        // a damaged entry is skipped; the others can still be settled
      }
    }
    return { items, unresolved: un.length }
  }

  /** [해결하기] and a library card of a conflicted note. */
  const openDialog = async () => {
    if (!loaded || loaded.readOnly || loaded.writer.leaving || dialog || dialogOpening.current) return
    dialogOpening.current = true
    try {
      const { items, unresolved } = await loadItems(loaded)
      if (!mounted.current) return
      // The record says there is nothing to settle while the status store still shows a conflict: an unreadable record.
      if (unresolved === 0) return (conflictsRef.current?.length ?? 0) > 0 ? say(t('conflict.resolveFailed')) : undefined
      if (items.length === 0) return say(t('conflict.resolveFailed')) // no silent dead end
      dialogOpener.current = document.activeElement as HTMLElement | null
      skipped.current = unresolved - items.length
      setDialog(items)
    } finally {
      dialogOpening.current = false
    }
  }
  const openDialogRef = useRef(openDialog)
  openDialogRef.current = openDialog
  // A request asked for before the note was loaded (a card) is served once it is.
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  useEffect(() => {
    if (!loaded || loaded.readOnly || !wantResolve.current) return
    wantResolve.current = false
    void openDialogRef.current()
  }, [loaded])
  useEffect(
    () =>
      onResolveRequest((id) => {
        if (id !== noteId || !takeResolveRequest(noteId)) return
        if (loadedRef.current) void openDialogRef.current()
        else wantResolve.current = true
      }),
    [noteId],
  )

  /**
   * One `resolveConflict` through the editor's queue, then `sync.json`. Answers the choice that was applied, or null
   * when nothing was settled. The pages are unlocked from the record as committed, never from a read that failed.
   */
  const resolveOne = async (item: ConflictItem, choice: string): Promise<string | null> => {
    // Nothing is applied when the result could not be recorded afterwards.
    if (!loaded || !uploads?.conflictResolved) return null
    const { writer } = loaded
    const key = `${item.entry.pageId}:${item.entry.rev}`
    let saved = unrecorded.current.get(key)
    if (!saved) {
      const out = writer.applyResolved(item.entry, item.sidecar, choice)
      if (out.result !== 'resolved') return null
      saved = { conflict: out.conflict, used: out.used }
      unrecorded.current.set(key, saved)
    }
    // The resolved note is on disk before `sync.json` says so.
    if (!(await writer.flushSaves())) return null
    const record = () => uploads.conflictResolved!(noteId, saved!.conflict as unknown as Record<string, unknown>, saved!.used)
    let info
    try {
      info = await record()
    } catch {
      try {
        info = await record() // once more, then the result stays in memory
      } catch {
        // A write that succeeded and then threw: the entry is resolved already, which is what we wanted.
        const now = await writer.store.readSync(noteId).catch(() => null)
        const done = now?.info.conflicts.some((c) => c.pageId === item.entry.pageId && c.rev === item.entry.rev && c.resolvedAt != null)
        if (!now || !done) return null
        info = now.info
      }
    }
    unrecorded.current.delete(key)
    settledPages.current.add(item.entry.pageId)
    writer.setLocked(unresolvedOf(info).map((c) => String(c.pageId)))
    return saved.used
  }

  /** Settles the chosen conflicts one after the other; the first failure stops the rest. */
  const resolveChoices = async (choices: [ConflictItem, string][]): Promise<ResolveOutcome> => {
    const settled = new Set<string>()
    let message: string | null = null
    for (const [item, choice] of choices) {
      const used = await resolveOne(item, choice)
      if (used === null) break
      settled.add(item.entry.pageId)
      if (choices.length === 1) message = fmt(t(resultKey(used)), { n: pageNo(item) })
    }
    if (settled.size === 0) return { settled, message }
    if (choices.length > 1) message = t(settled.size === 1 ? 'conflict.resolvedAllOne' : 'conflict.resolvedAll').replace('{n}', String(settled.size))
    if (mounted.current) setResultText(message ?? '')
    // The resolution goes up (the note stays open).
    syncSoon()
    return { settled, message }
  }

  const closeDialog = (all: boolean) => {
    setDialog(null)
    // Entries without both versions are still open: not finished, and the person is told.
    const left = skipped.current
    const done = all && left === 0
    if (all && left > 0) say(fmt(t('conflict.skipped'), { n: left }))
    // The last conflict is settled: back to the page. Otherwise to where the dialog came from.
    const back = dialogOpener.current
    queueMicrotask(() => {
      if (!mounted.current) return
      if (!done && back?.isConnected) back.focus()
      else canvas.current?.focus()
    })
  }

  const openHistory = () => {
    if (receiving || !ui?.versions) return
    setMenuOpen(false)
    setHistoryOpen(true)
  }
  /** The upload of a change that just happened (the note stays open); the version history reloads when it is done. */
  const lastSync = useRef<Promise<void> | null>(null)
  const syncSoon = () => {
    const p: Promise<void> = Promise.resolve()
      .then(() => uploads?.syncNow?.(noteId))
      .catch(() => {})
      .finally(() => {
        if (lastSync.current === p) lastSync.current = null // done: later opens have nothing to wait for
      })
    lastSync.current = p
  }

  const closeHistory = (restored: boolean) => {
    setHistoryOpen(false)
    if (restored) setResultText(t('version.restored'))
    // Focus goes back to the ⋯ button, which opened it.
    queueMicrotask(() => mounted.current && more.current?.focus())
  }

  /**
   * One restore (spec version-history): the procedure runs in the restorer; the note changes through the writer's queue.
   * The pages whose conflicts the restore settled are unlocked from the record as committed, never from a read.
   */
  const restoreVersion = async (entry: VersionEntry, fileId: string): Promise<RestoreFailure | null> => {
    const versions = ui?.versions
    if (!loaded || !versions || leaving.current || loaded.writer.leaving || readOnly || receiving) return 'notApplied'
    const { writer } = loaded
    if (writer.busy()) return 'busy'
    const r = await versions.restorer.restore({
      noteId,
      fileId,
      entry,
      live: () => writer.history.note,
      // Checked again at the moment of the apply: a tab or a receive may have started during the upload.
      apply: (run) => !readOnlyRef.current && !receivingRef.current && !leaving.current && writer.applyRestored(run),
      flush: () => writer.flushSaves(),
    })
    if (r.failure !== null) return r.failure === 'notApplied' && writer.busy() ? 'busy' : r.failure
    if (r.locked) {
      for (const c of conflictsRef.current ?? []) if (!r.locked.includes(c.pageId)) settledPages.current.add(c.pageId)
      if (mounted.current) writer.setLocked(r.locked)
    }
    // The restored note goes up like any edit.
    syncSoon()
    return null
  }

  const scale = view?.scale ?? 1
  const percent = Math.round(scale * 100)
  const atMin = scale <= ZOOM_MIN + 1e-9
  const atMax = scale >= ZOOM_MAX - 1e-9
  // Spoken when the level changes, and when the menu opens.
  const levelText = fmt(t('editor.zoomLevel'), { percent })
  const [announce, setAnnounce] = useState('')
  const lastPercent = useRef(percent)
  // The small scale badge at the top right shows after a zoom and goes away shortly after.
  const [badge, setBadge] = useState(false)
  useEffect(() => {
    const changed = lastPercent.current !== percent
    lastPercent.current = percent
    setAnnounce(menuOpen || changed ? levelText : '')
    if (!changed) return
    setBadge(true)
    const id = setTimeout(() => setBadge(false), ZOOM_BADGE_MS)
    return () => clearTimeout(id)
  }, [percent, menuOpen, levelText])
  const modeName = (m: ViewMode) => t({ vertical: 'editor.viewVertical', horizontal: 'editor.viewHorizontal', twoPage: 'editor.viewTwoPage' }[m] as 'editor.viewVertical')
  const pickMode = (m: ViewMode) => {
    setViewMode(viewModeStore.write(m))
    setModeSay(fmt(t('editor.viewModeChanged'), { mode: modeName(m) }))
    setMenuOpen(false)
    more.current?.focus()
  }
  const choose = (fit: 'width' | 'page') => {
    loaded?.writer.fit(fit)
    setMenuOpen(false)
    more.current?.focus()
  }

  const pages = loaded?.writer.history.note.pages ?? []
  const total = pages.length
  // The page in view (a page key or scrolling moved it); 0 until the view is laid out.
  const at = Math.min(view?.page ?? 0, Math.max(0, total - 1))
  const labelOf = (i: number) => {
    const page = pages[i]
    return page
      ? fmt(t('editor.page'), {
          n: i + 1,
          total,
          orientation: t(page.width > page.height ? 'library.orientation.landscape' : 'library.orientation.portrait'),
        })
      : undefined
  }
  const pageLabel = labelOf(at)
  // The confirmed text boxes, readable by a screen reader.
  const textBoxes = pages.flatMap((p) => (p.elements as { id?: string; type?: string; text?: unknown }[]).filter((e) => e?.type === 'text' && typeof e.text === 'string').map((e) => ({ id: e.id as string, text: e.text as string })))

  // The images, readable by a screen reader with their state (placeholder, waiting to be saved).
  const imageEls = pages.flatMap((p) => (p.elements as { id?: string; type?: string; asset?: unknown }[]).filter((e) => e?.type === 'image' && typeof e.asset === 'string').map((e) => ({ id: e.id as string, asset: e.asset as string })))

  return (
    <section ref={section} className="editor" aria-label={loaded?.title} aria-busy={!loaded}>
      <Banner otherTab={loaded?.readOnly === true} noteId={noteId} pulse={blocked} onClose={() => (loaded ? onBack() : goToLibrary())} />
      {!loaded && (
        <p role="status" className="cover-date">
          {t(slow ? 'sync.receivingLatest' : 'library.loading')}
        </p>
      )}
      {loaded && (
        <>
          {dock.outlines.map((o) => (
            <div key={o.dock} aria-hidden="true" className={o.near ? 'toolbar-snap toolbar-snap-near' : 'toolbar-snap'} style={{ left: o.left, top: o.top, width: o.width, height: o.height }} />
          ))}
          <div className="editor-top">
            <div className="editor-corner">
              <button ref={back} type="button" className="btn editor-back" aria-label={t('library.backToLibrary')} onClick={onBack}>
                <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.75" fill="none" />
                </svg>
              </button>
            </div>
            <PenToolbar
              ref={toolbar}
              pens={pens}
              selected={selected}
              onSelect={(i) => {
                if (readOnly) return
                setSelected(i)
                setTool('pen')
              }}
              onAdd={addPenSlot}
              onMove={movePenSlot}
              onEdit={(i) => {
                if (readOnly || loaded.writer.busy()) return
                setTool('pen')
                setPens(penStore.read()) // another tab may have changed it
                setRecent(recentStore.read())
                setPopover(i)
              }}
              canUndo={loaded.writer.canUndo}
              canRedo={loaded.writer.canRedo}
              onUndo={() => loaded.writer.undo()}
              onRedo={() => loaded.writer.redo()}
              tool={tool}
              onToolChange={setTool}
              eraserMode={eraser.mode}
              onEraserEdit={() => {
                if (readOnly || loaded.writer.busy()) return
                setEraser(eraserStore.read()) // another tab may have changed it
                setEraserPop(true)
              }}
              dock={dock}
              onDocked={(d) => setAnnounce(fmt(t('editor.toolbarDocked'), { place: t({ top: 'editor.dockTop', left: 'editor.dockLeft', right: 'editor.dockRight', bottom: 'editor.dockBottom' }[d] as 'editor.dockTop') }))}
              {...(images && { onImage: () => picker.current?.click() })}
              readOnly={readOnly}
            />
            <div
              className="editor-more"
              onBlur={(e) => {
                // Tab left the menu: close it (a null target is a press on a non-focusable spot).
                const to = e.relatedTarget as Node | null
                if (menuOpen && to && !e.currentTarget.contains(to)) setMenuOpen(false)
              }}
            >
              <div className="editor-corner">
                <SyncIndicator noteId={noteId} />
                <button
                  ref={more}
                  type="button"
                  className="btn editor-back"
                  aria-label={t('editor.more')}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((o) => !o)}
                >
                  <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="3" cy="8" r="1.4" fill="currentColor" />
                    <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                    <circle cx="13" cy="8" r="1.4" fill="currentColor" />
                  </svg>
                </button>
              </div>
              {badge && !menuOpen && (
                <span className="editor-zoom-badge" data-testid="zoom-badge" aria-hidden="true">
                  {percent}%
                </span>
              )}
              {menuOpen && (
                <div ref={menu} role="menu" aria-label={t('editor.more')} className="editor-menu" onKeyDown={onMenuKeyDown}>
                  <div role="none" className="editor-menu-row">
                    <button
                      type="button"
                      role="menuitem"
                      aria-disabled={atMin}
                      aria-label={t('editor.zoomOut')}
                      title={t('editor.zoomOutTip')}
                      className={atMin ? 'toolbar-action toolbar-action-disabled' : 'toolbar-action'}
                      onClick={() => !atMin && loaded.writer.zoomBy(1 / ZOOM_STEP)}
                    >
                      <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M3 8h10" stroke="currentColor" strokeWidth="1.75" fill="none" />
                      </svg>
                    </button>
                    <span className="editor-zoom-level" aria-hidden="true">
                      {percent}%
                    </span>
                    <button
                      type="button"
                      role="menuitem"
                      aria-disabled={atMax}
                      aria-label={t('editor.zoomIn')}
                      title={t('editor.zoomInTip')}
                      className={atMax ? 'toolbar-action toolbar-action-disabled' : 'toolbar-action'}
                      onClick={() => !atMax && loaded.writer.zoomBy(ZOOM_STEP)}
                    >
                      <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M3 8h10M8 3v10" stroke="currentColor" strokeWidth="1.75" fill="none" />
                      </svg>
                    </button>
                  </div>
                  <button type="button" role="menuitem" className="editor-menu-item" title={viewMode === 'vertical' ? t('editor.fitWidthTip') : `${t('editor.fitHeight')} (Ctrl+0)`} onClick={() => choose('width')}>
                    {t(viewMode === 'vertical' ? 'editor.fitWidth' : 'editor.fitHeight')}
                  </button>
                  <button type="button" role="menuitem" className="editor-menu-item" onClick={() => choose('page')}>
                    {t('editor.fitPage')}
                  </button>
                  <div role="group" aria-label={t('editor.viewMode')} className="editor-menu-group">
                    {VIEW_MODES.map((m) => (
                      <button key={m} type="button" role="menuitemradio" aria-checked={viewMode === m} className="editor-menu-item" onClick={() => pickMode(m)}>
                        {modeName(m)}
                      </button>
                    ))}
                  </div>
                  {([-1, 1] as const).map((d) => {
                    const off = (d < 0 ? around.prev : around.next) === null
                    return (
                      <button key={d} type="button" role="menuitem" className="editor-menu-item" aria-disabled={off} onClick={() => !off && jump(d)}>
                        {t(d < 0 ? 'editor.prevNote' : 'editor.nextNote')}
                      </button>
                    )
                  })}
                  {ui?.versions && (
                    <button
                      type="button"
                      role="menuitem"
                      className="editor-menu-item"
                      aria-disabled={receiving}
                      {...(receiving ? { title: t('sync.receivingLatest') } : {})}
                      onClick={openHistory}
                    >
                      {t('version.title')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          <div ref={pageArea} className="editor-page-area" role="group" aria-label={`${t('editor.canvas')}: ${pageLabel ?? ''}`}>
            <input
              ref={picker}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
              multiple
              hidden
              data-image-picker=""
              onChange={(e) => {
                const files = [...(e.target.files ?? [])].filter(isImageFile)
                e.target.value = '' // the same file can be picked again
                addImages(files, 'center')
                canvas.current?.focus()
              }}
            />
            <canvas
              ref={canvas}
              className="editor-canvas"
              role="img"
              tabIndex={0}
              aria-label={pageLabel}
              aria-describedby={descId}
            />
            {box && !readOnly && !loaded.writer.pageLocked && (
              <SelectionMenu
                box={box}
                origin={{ x: canvas.current?.offsetLeft ?? 0, y: canvas.current?.offsetTop ?? 0 }}
                ratioLock={ratio}
                onRatioLock={() => setRatio((r) => !r)}
                onScale={(f) => loaded.writer.scaleSelection(f)}
                onRotate={() => loaded.writer.rotateSelection(90)}
                onColor={(c) => loaded.writer.setSelectionColor(c)}
                onWidth={(w) => loaded.writer.setSelectionWidth(w)}
                onCopy={() => (loaded.writer.copySelection(), canvas.current?.focus())}
                onCut={() => (loaded.writer.cutSelection(), canvas.current?.focus())}
                onDelete={() => (loaded.writer.deleteSelection(), canvas.current?.focus())}
                onLeave={() => canvas.current?.focus()}
              />
            )}
            {edit && !readOnly && (
              <TextEditOverlay key={edit.id} info={edit} writer={loaded.writer} origin={{ x: canvas.current?.offsetLeft ?? 0, y: canvas.current?.offsetTop ?? 0 }} onDone={() => canvas.current?.focus()} />
            )}
            {imageEls.length > 0 && images && (
              <ul className="sr-only" aria-label={t('editor.images')}>
                {imageEls.map((im) => {
                  const state = images.state(im.asset)
                  const key = state === 'failed' ? 'editor.imageFailed' : state === 'downloading' ? 'editor.imageDownloading' : images.pending(im.asset) ? 'editor.imagePending' : 'editor.imageItem'
                  return (
                    <li key={im.id}>
                      {t(key)}
                      {state === 'failed' && (
                        <button type="button" onClick={() => images.retry(im.asset)}>
                          {t('editor.imageRetry')}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            {textBoxes.length > 0 && (
              <ul className="sr-only" aria-label={t('editor.textBoxes')}>
                {textBoxes.map((b) => (
                  <li key={b.id}>{b.text}</li>
                ))}
              </ul>
            )}
            <span id={descId} className="sr-only">
              {loaded.writer.pageLocked ? `${t('editor.handwriting')}. ${t('editor.conflictDescription')}` : t('editor.handwriting')}
            </span>
            {total > 1 && (
              <ul className="sr-only" aria-label={t('editor.pages')}>
                {pages.map((p, i) => (
                  <li key={p.id} aria-current={i === at ? 'page' : undefined}>
                    {labelOf(i)}
                  </li>
                ))}
              </ul>
            )}
            {view?.y && (
              <span className="editor-scroll editor-scroll-y" aria-hidden="true">
                <span style={{ top: `${view.y.start * 100}%`, height: `${view.y.size * 100}%` }} />
              </span>
            )}
            {view?.x && (
              <span className="editor-scroll editor-scroll-x" aria-hidden="true">
                <span style={{ left: `${view.x.start * 100}%`, width: `${view.x.size * 100}%` }} />
              </span>
            )}
          </div>
          <div role="status" className="snackbar">
            {message ? t(MESSAGE_KEY[message.key]) : ''}
          </div>
          {deleted && (
            <div role="status" className="snackbar snackbar-action">
              <span>{t('editor.slotDeleted')}</span>
              <button type="button" className="snackbar-button" onClick={undoDelete}>
                {t('editor.undoDelete')}
              </button>
            </div>
          )}
          {chip && (
            <div role="status" className="editor-position-chip">
              {chip}
            </div>
          )}
          {backText && (
            <div role="status" className="snackbar snackbar-action">
              <span>{backText}</span>
              <button
                type="button"
                className="snackbar-button"
                onClick={() => {
                  setBackText(null)
                  setChip(null)
                  globalThis.history.back()
                }}
              >
                {t('editor.noteUndo')}
              </button>
            </div>
          )}
          <div role="status" aria-live="polite" className="sr-only">
            {announce}
          </div>
          <div role="status" aria-live="polite" className="sr-only" data-view-mode="">
            {modeSay}
          </div>
          <div role="status" aria-live="polite" className="sr-only" data-result="">
            {resultText}
          </div>
          <div role="alert" className="sr-only" key={alert.n}>
            {alert.text}
          </div>
          {historyOpen && ui?.versions && (
            <VersionHistory
              noteId={noteId}
              source={ui.versions.source}
              probe={ui.versions.probe}
              readFileId={async () => (await loaded.writer.store.readSync(noteId)).info.fileId}
              readLocal={() => readLocalSidecars(loaded.writer.store, noteId)}
              pendingSync={() => lastSync.current}
              restoreBlocked={readOnly || receiving}
              blockedTitle={t(readOnly ? 'editor.readOnlyTip' : 'sync.receivingLatest')}
              onRestore={restoreVersion}
              onClose={closeHistory}
            />
          )}
          {dialog && <ConflictDialog items={dialog} skipped={skipped.current} onResolve={resolveChoices} onClose={closeDialog} />}
          {eraserPop && !readOnly && (
            <EraserPopover
              mode={eraser.mode}
              returnToPen={eraser.returnToPen}
              anchor={toolbar.current}
              onChange={(patch) => {
                if (patch.mode && patch.mode !== eraser.mode) setAnnounce(t(patch.mode === 'partial' ? 'editor.eraserSayPartial' : 'editor.eraserSayStroke'))
                setEraser(eraserStore.write(patch))
              }}
              onClose={() => {
                setEraserPop(false)
                toolbar.current?.querySelector<HTMLElement>('[data-tool="eraser"]')?.focus()
              }}
            />
          )}
          {popover !== null && !readOnly && pens[popover] && (
            <PenPopover
              pen={pens[popover]}
              anchor={toolbar.current}
              canDelete={pens.length > 1}
              onDelete={() => deletePenSlot(popover)}
              recent={recent}
              onRecent={(hex) => setRecent(recentStore.push(hex))}
              onChange={(patch) => {
                const cur = pens[popover]!
                if (patch.tool !== undefined && patch.tool === cur.tool) return
                const next = patch.tool !== undefined ? defaultFor(patch.tool) : { ...cur, ...patch }
                if (patch.tool !== undefined) setAnnounce(t(`editor.tool.${patch.tool}`))
                commitSlots(pens.map((p, i) => (i === popover ? next : p)))
              }}
              onClose={() => {
                setPopover(null)
                toolbar.current?.querySelector<HTMLElement>(`[data-slot="${popover}"]`)?.focus()
              }}
            />
          )}
        </>
      )}
    </section>
  )
}
