import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyEvent } from 'react'
import { fmt, useI18n, type Key } from '../../i18n'
import type { Pen } from '../../model/pen'
import { sessionHistory } from '../../ops/sessionHistories'
import { auth } from '../../drive/auth'
import { openNoteStore, type NoteStore } from '../../storage/noteStore'
import { acquireNoteLock } from '../../storage/noteLock'
import { sharedPenSlots, type PenSlotsStore } from '../../storage/penSlots'
import { savesSettled } from '../../storage/saveQueue'
import { registerOpenNote } from '../../sync/openNotes'
import type { NoteReceiver } from '../../sync/noteReceiver'
import type { UploadCoordinator } from '../../sync/uploadCoordinator'
import { Banner } from '../sync/Banner'
import { unresolvedOf } from '../../sync/conflicts'
import type { Conflict } from '../../sync/merge'
import { useNoteConflicts, useNoteIssue, useSyncUi } from '../sync/syncUi'
import { SyncIndicator } from '../sync/SyncIndicator'
import { ConflictDialog, type ConflictItem, type ResolveOutcome, pageNo, resultKey } from './ConflictDialog'
import { PenPopover } from './PenPopover'
import { PenToolbar } from './PenToolbar'
import { onResolveRequest, takeResolveRequest } from './resolveRequest'
import { detectEditedBy } from './useLibrary'
import { ZOOM_MAX, ZOOM_MIN } from '../../render/pagePainter'
import { ARROW_STEP, Writer, ZOOM_STEP, type ViewInfo, type WriterMessage } from './writer'

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
}

// Per note: the release of the lock a left editor still holds.
const releasing = new Map<string, Promise<void>>()
// Editors mounted in this tab: a remount (StrictMode, fast leave and reopen) is not a close.
const mountedNotes = new Set<string>()

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
  uploads,
  receiver,
}: {
  noteId: string
  openStore?: () => NoteStore
  penStore?: PenSlotsStore
  /** Told when the note is closed, after its last save and its lock are released (Story 3.12); records a resolved conflict (Story 3.22). */
  uploads?: Pick<UploadCoordinator, 'noteClosed'> & Partial<Pick<UploadCoordinator, 'conflictResolved' | 'syncNow'>>
  /** Receives remote changes before the editor opens and checks the remote head after (Story 3.14). */
  receiver?: Pick<NoteReceiver, 'beforeOpen' | 'noteOpened'> & Partial<Pick<NoteReceiver, 'noteClosed'>>
}) {
  const { t } = useI18n()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [message, setMessage] = useState<{ key: WriterMessage; n: number } | null>(null)
  const [pens, setPens] = useState<Pen[]>(() => penStore.read())
  const [popover, setPopover] = useState<number | null>(null)
  const popoverOpen = useRef(false)
  popoverOpen.current = popover !== null
  const [selected, setSelected] = useState(0)
  const selectedRef = useRef(0)
  selectedRef.current = selected
  // Bumped when the history changes so the undo/redo buttons re-read their state.
  const [, setRevision] = useState(0)
  const [view, setView] = useState<ViewInfo | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // The note is being received before it opens, for over a second.
  const [slow, setSlow] = useState(false)
  // Writes refused on a conflict page (Story 3.20): the banner is emphasized, "읽기 전용 페이지예요" is announced.
  const [blocked, setBlocked] = useState(0)
  const [alert, setAlert] = useState({ text: '', n: 0 })
  const say = (text: string) => setAlert((a) => ({ text, n: a.n + 1 }))
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

  const section = useRef<HTMLElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
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
            const w = new Writer(
              sessionHistory(note),
              store,
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
              return { gap: g, extraBottom: (toolbar.current?.offsetHeight ?? 0) + g }
            }
            w.onView = (v) => live && setView(v)
            writer = w // owned from here: the cleanup finalizes it
            // A writable editor is the tab that may upload this note while it is open.
            unregister()
            unregister = readOnly
              ? () => {}
              : registerOpenNote(noteId, {
                  flush: () => w.flushSaves(),
                  unsaved: () => w.unsaved(),
                  strokeEnd: () => w.strokeEnd(),
                  current: () => w.history.note,
                  applyMerge: (a) => w.applyMerge(a),
                })
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
          // A note Drive deleted is removed now (nothing unsent) or restored (something unsent), once it is not open.
          if (!mountedNotes.has(noteId)) await receiver?.noteClosed?.(noteId).catch(() => {})
        })
        .then(() => {
          // The last save is on disk and the lock is free: the closing upload may read the note.
          unregister()
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
    if (readOnly) setPopover(null)
  }, [readOnly])
  // F6 / Shift+F6 cycle corner -> toolbar -> canvas; 1 picks the first slot.
  useEffect(() => {
    if (!ready) return
    const onKey = (e: KeyboardEvent) => {
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
      } else if (e.key === '1' && !e.shiftKey) {
        const target = e.target as Node | null
        const inside = [toolbar.current, canvas.current].some((r) => r && (r.contains(target) || r.contains(active)))
        if (inside && !readOnly) setSelected(0)
      }
    }
    // Capture, so a handler lower down cannot hide the key.
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [ready, readOnly])

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
      const d = arrow[e.key]
      if (d && !e.shiftKey) {
        e.preventDefault()
        writer.panBy(d[0], d[1])
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

  // A toolbar that changes height changes the room under the page.
  useEffect(() => {
    if (!loaded || !toolbar.current || typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(() => loaded.writer.layout())
    ro.observe(toolbar.current)
    return () => ro.disconnect()
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
    const items = [...menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length : i) - 1
    items[next]?.focus()
  }

  const onBack = () => {
    if (!loaded || leaving.current) return
    leaving.current = true
    // Finish the stroke and the saves first; leave even when the last try fails.
    // finalize never rejects in practice; if it hangs, leave after 5 s anyway.
    const done = loaded.writer.finalize().catch(() => {})
    const giveUp = new Promise<void>((r) => setTimeout(r, LEAVE_WAIT_MS))
    void Promise.race([done, giveUp]).then(() => mounted.current && backToLibrary())
  }

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
    const record = () => uploads.conflictResolved!(noteId, saved!.conflict as unknown as Record<string, unknown>)
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
    void Promise.resolve()
      .then(() => uploads?.syncNow?.(noteId))
      .catch(() => {})
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

  const scale = view?.scale ?? 1
  const percent = Math.round(scale * 100)
  const atMin = scale <= ZOOM_MIN + 1e-9
  const atMax = scale >= ZOOM_MAX - 1e-9
  // Spoken when the level changes, and when the menu opens.
  const levelText = fmt(t('editor.zoomLevel'), { percent })
  const [announce, setAnnounce] = useState('')
  const lastPercent = useRef(percent)
  useEffect(() => {
    const changed = lastPercent.current !== percent
    lastPercent.current = percent
    setAnnounce(menuOpen || changed ? levelText : '')
  }, [percent, menuOpen, levelText])
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
          <div className="editor-top">
            <div className="editor-corner">
              <button ref={back} type="button" className="btn editor-back" aria-label={t('library.backToLibrary')} onClick={onBack}>
                <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.75" fill="none" />
                </svg>
              </button>
              <span className="editor-title">{loaded.title}</span>
            </div>
            <PenToolbar
              ref={toolbar}
              pens={pens}
              selected={selected}
              onSelect={(i) => !readOnly && setSelected(i)}
              onEdit={(i) => {
                if (readOnly || loaded.writer.busy()) return
                setPens(penStore.read()) // another tab may have changed it
                setPopover(i)
              }}
              canUndo={loaded.writer.canUndo}
              canRedo={loaded.writer.canRedo}
              onUndo={() => loaded.writer.undo()}
              onRedo={() => loaded.writer.redo()}
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
                  <button type="button" role="menuitem" className="editor-menu-item" title={t('editor.fitWidthTip')} onClick={() => choose('width')}>
                    {t('editor.fitWidth')}
                  </button>
                  <button type="button" role="menuitem" className="editor-menu-item" onClick={() => choose('page')}>
                    {t('editor.fitPage')}
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="editor-page-area" role="group" aria-label={`${t('editor.canvas')}: ${pageLabel ?? ''}`}>
            <canvas
              ref={canvas}
              className="editor-canvas"
              role="img"
              tabIndex={0}
              aria-label={pageLabel}
              aria-describedby={descId}
            />
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
          <div role="status" aria-live="polite" className="sr-only">
            {announce}
          </div>
          <div role="status" aria-live="polite" className="sr-only" data-result="">
            {resultText}
          </div>
          <div role="alert" className="sr-only" key={alert.n}>
            {alert.text}
          </div>
          {dialog && <ConflictDialog items={dialog} skipped={skipped.current} onResolve={resolveChoices} onClose={closeDialog} />}
          {popover !== null && !readOnly && pens[popover] && (
            <PenPopover
              pen={pens[popover]}
              anchor={toolbar.current?.querySelector<HTMLElement>(`[data-slot="${popover}"]`) ?? null}
              onUsePressure={(usePressure) => {
                const next = pens.map((p, i) => (i === popover ? { ...p, usePressure } : p))
                penStore.write(next)
                setPens(next)
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
