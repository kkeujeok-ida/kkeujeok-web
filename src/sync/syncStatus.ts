// What the UI knows of every note's sync state (Story 3.16): read from the same
// records as everything else (`readSync`), kept fresh by the write signal, and
// read synchronously by the tab-close warning. Holds no timer after `dispose`.
import type { NoteStore } from '../storage/noteStore'
import { unresolvedOf } from './conflicts'
import { onSyncChanged } from './syncSignal'
import type { SyncStateName } from './syncRules'

export type NoteSyncView = {
  state: SyncStateName
  hasUnsent: boolean
  lastError: { class: string; status?: number; reason?: string } | null
  /** The Drive file of the note, for "Drive에서 보기". */
  fileId?: string | null
  /** The conflicts nobody has resolved yet (Story 3.20): the read-only pages, the banner and its text. */
  conflicts?: { pageId: string; kind: string; originalIndex: number }[]
}
export type SyncSnapshot = { version: number; loaded: boolean; notes: ReadonlyMap<string, NoteSyncView> }

export type SyncStatus = ReturnType<typeof createSyncStatus>

/** Edits arrive in bursts (a stroke saves several times); after the first read, one read per note per this long. */
export const STATUS_DELAY_MS = 50

export function createSyncStatus(d: {
  store: Pick<NoteStore, 'listIds' | 'readSync'>
  /** The change feed; the real one by default. */
  signal?: (fn: (noteId: string) => void) => () => void
  delayMs?: number
}) {
  let snap: SyncSnapshot = { version: 0, loaded: false, notes: new Map() }
  const listeners = new Set<() => void>()
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const queued = new Set<string>()
  let all: Promise<void> | null = null
  // Notes signalled while `refreshAll` reads: its older read must not overwrite them.
  let touched: Set<string> | null = null

  const publish = (notes: Map<string, NoteSyncView>, loaded: boolean) => {
    if (disposed) return
    const same =
      loaded === snap.loaded &&
      notes.size === snap.notes.size &&
      [...notes].every(([k, v]) => JSON.stringify(snap.notes.get(k)) === JSON.stringify(v))
    if (same) return
    snap = { version: snap.version + 1, loaded, notes }
    listeners.forEach((fn) => fn())
  }

  /** `'gone'`: the note was removed (nothing to show, nothing unsent). */
  async function view(noteId: string): Promise<NoteSyncView | null | 'gone'> {
    try {
      const r = await d.store.readSync(noteId)
      if (r.missing) return 'gone'
      const e = r.info.lastError
      return {
        fileId: r.info.fileId,
        conflicts: unresolvedOf(r.info).map((c) => ({
          pageId: String(c.pageId),
          kind: typeof c.kind === 'string' ? c.kind : 'bothEdited',
          originalIndex: typeof c.originalIndex === 'number' ? c.originalIndex : 0,
        })),
        state: r.state,
        hasUnsent: r.hasUnsent,
        lastError: e && typeof e.class === 'string' ? { class: e.class, ...(typeof e.status === 'number' && { status: e.status }), ...(typeof e.reason === 'string' && { reason: e.reason }) } : null,
      }
    } catch {
      return null
    }
  }

  async function readQueued() {
    const ids = [...queued]
    queued.clear()
    const updates: [string, NoteSyncView][] = []
    const gone: string[] = []
    for (const id of ids) {
      const v = await view(id)
      if (disposed) return
      if (v === 'gone') gone.push(id)
      else if (v) updates.push([id, v])
    }
    // Merged into the snapshot as it is now: reads that overlap do not drop each other's notes.
    const next = new Map([...snap.notes, ...updates])
    gone.forEach((id) => next.delete(id))
    publish(next, snap.loaded)
  }

  // The first change is read at once (an edit must count as unsent before the tab can close);
  // more changes inside the delay are read together when it ends.
  const tick = () => {
    timer = null
    if (disposed || queued.size === 0) return
    void readQueued()
    timer = setTimeout(tick, d.delayMs ?? STATUS_DELAY_MS)
  }
  const unsub = (d.signal ?? onSyncChanged)((noteId) => {
    if (disposed) return
    queued.add(noteId)
    touched?.add(noteId)
    if (timer) return
    void readQueued()
    timer = setTimeout(tick, d.delayMs ?? STATUS_DELAY_MS)
  })

  const api = {
    getSnapshot: () => snap,
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    /** Reads every note again (start, tab visible, connection back). One run at a time. */
    refreshAll(): Promise<void> {
      all ??= (async () => {
        try {
          const ids = await d.store.listIds()
          const t = (touched = new Set<string>())
          const read: [string, NoteSyncView | null | 'gone'][] = []
          for (const id of ids) {
            const v = await view(id)
            if (disposed) return
            read.push([id, v])
          }
          // Merged into the snapshot as it is now; a failed read keeps the previous entry.
          const next = new Map<string, NoteSyncView>()
          for (const [id, v] of read) {
            if (v === 'gone') continue
            const cur = snap.notes.get(id)
            // A failed read with no earlier entry stays unsent: better a needless warning than a lost one.
            const fresh = v ?? { state: 'pending' as const, hasUnsent: true, lastError: null }
            next.set(id, t.has(id) ? (cur ?? fresh) : (v ?? cur ?? fresh))
          }
          for (const id of t) {
            const cur = snap.notes.get(id)
            if (cur && !next.has(id)) next.set(id, cur)
          }
          publish(next, true)
        } catch {
          // the next trigger tries again
        } finally {
          all = null
          touched = null
        }
      })()
      return all
    },
    /** True when some note has changes Drive does not have; synchronous, for `beforeunload`. */
    anyUnsent: () => !snap.loaded || [...snap.notes.values()].some((v) => v.hasUnsent),
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
      queued.clear()
      listeners.clear()
      unsub()
    },
  }
  return api
}
