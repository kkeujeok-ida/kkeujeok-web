// Library state: the sorted note list and note creation. Every write goes
// through createNote (ops) and noteStore.writeNote.
import { useCallback, useEffect, useRef, useState } from 'react'
import { newId } from '../../model/ids'
import { encodeKkj } from '../../model/kkjCodec'
import type { Note, Page } from '../../model/note'
import { createNote } from '../../ops/ops'
import type { Background, NewNoteDefaults, Orientation } from '../../storage/newNoteDefaults'
import type { NoteStore } from '../../storage/noteStore'
import { savesSettled } from '../../storage/saveQueue'
import type { NoteReceiver } from '../../sync/noteReceiver'

/**
 * `title` is null for a note this client cannot open. `editedMs` is null when
 * no valid date. `page` is the first page, for the card thumbnail.
 */
export type LibraryItem = {
  noteId: string
  title: string | null
  editedMs: number | null
  page?: Page
  remote?: true
  /** A remote-only note whose file was downloaded and cannot be read or is of a newer format (Story 3.18). */
  blocked?: { reason: 'unreadable' | 'unsupportedVersion'; fileId: string }
}
type Entry = Awaited<ReturnType<NoteStore['listNotes']>>[number]

/** The newest page `editedAt` as epoch ms; unusable values are skipped. */
export function latestEditedMs(note: Note): number | null {
  let max: number | null = null
  const pages: unknown = note.pages
  if (!Array.isArray(pages)) return null
  for (const p of pages) {
    const v = (p as { editedAt?: unknown } | null)?.editedAt
    if (typeof v !== 'string') continue
    const ms = Date.parse(v)
    if (!Number.isNaN(ms) && (max === null || ms > max)) max = ms
  }
  return max
}

export function toItem({ noteId, result }: Entry): LibraryItem {
  const note = result.result === 'ok' ? result.note : undefined
  const title: unknown = note?.meta?.title
  if (!note || typeof title !== 'string') return { noteId, title: null, editedMs: null }
  const first: unknown = Array.isArray(note.pages) ? note.pages[0] : undefined
  const item: LibraryItem = { noteId, title, editedMs: latestEditedMs(note) }
  if (typeof first === 'object' && first !== null) item.page = first as Page
  return item
}

const rank = (i: LibraryItem) => (i.title === null ? 2 : i.editedMs === null ? 1 : 0)
const idDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)

/** Newest first, ties by noteId descending; undated notes, then unreadable ones, last. */
export function sortItems(items: LibraryItem[]): LibraryItem[] {
  return [...items].sort(
    (a, b) => rank(a) - rank(b) || (b.editedMs ?? 0) - (a.editedMs ?? 0) || idDesc(a.noteId, b.noteId),
  )
}

type Nav = { userAgent?: string; userAgentData?: { brands?: { brand: string }[]; platform?: string } }

/** "<browser>, <OS>" for `editedBy`; just "Browser" when the browser is unknown. */
export function detectEditedBy(nav: Nav | undefined = globalThis.navigator as Nav | undefined): string {
  const ua = nav?.userAgent ?? ''
  const brands = (nav?.userAgentData?.brands ?? []).map((b) => b.brand).filter((b) => !/not.?a.?brand/i.test(b))
  let browser = brands.find((b) => !/^chromium$/i.test(b)) ?? brands[0]
  if (!browser) {
    browser = /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome'
      : /Safari\//.test(ua) ? 'Safari'
      : undefined
  }
  const os =
    nav?.userAgentData?.platform ||
    (/Windows/.test(ua) ? 'Windows'
      : /Android/.test(ua) ? 'Android'
      : /iPhone|iPad/.test(ua) ? 'iOS'
      : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
      : /CrOS/.test(ua) ? 'ChromeOS'
      : /Linux/.test(ua) ? 'Linux'
      : '')
  if (!browser) return 'Browser'
  return os ? `${browser}, ${os}` : browser
}

export type CreateInput = { title: string; background: Background; orientation: Orientation }

export function useLibrary(
  openStore: () => NoteStore,
  defaults: { write(d: NewNoteDefaults): void },
  editedBy?: string,
  receiver?: Pick<NoteReceiver, 'subscribe' | 'getState'>,
) {
  // `failed`: a reload failed while a list was already shown; the old list stays.
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; items: LibraryItem[]; failed: boolean }>({
    status: 'loading',
    items: [],
    failed: false,
  })
  const storeRef = useRef<NoteStore | null>(null)
  const seq = useRef(0)
  const itemsRef = useRef<LibraryItem[]>([])
  itemsRef.current = state.items
  const statusRef = useRef(state.status)
  statusRef.current = state.status

  const load = useCallback(async () => {
    const s = storeRef.current
    if (!s) return
    const mine = ++seq.current
    setState((p) => (p.status === 'error' ? { status: 'loading', items: [], failed: false } : p))
    try {
      // An editor that was just left may still be saving: list after it.
      await savesSettled(3000)
      const list = await s.listNotes()
      if (storeRef.current !== s) return // left meanwhile: its connection is closed, no new one
      // Cards of notes on Drive that are not downloaded yet; a failure only leaves them out.
      const cards = await s.remote.list().catch(() => [])
      if (mine !== seq.current || storeRef.current !== s) return
      const here = new Set(list.map((e) => e.noteId))
      const remote: LibraryItem[] = cards
        .filter((c) => !here.has(c.noteId))
        .map((c) => ({
          noteId: c.noteId,
          title: c.title,
          editedMs: Date.parse(c.modifiedAt) || null,
          remote: true as const,
          ...(c.blocked && { blocked: { reason: c.blocked, fileId: c.fileId } }),
        }))
      setState({ status: 'ready', items: sortItems([...list.map(toItem), ...remote]), failed: false })
    } catch {
      if (mine !== seq.current || storeRef.current !== s) return
      setState((p) => (p.status === 'ready' ? { ...p, failed: true } : { status: 'error', items: [], failed: false }))
    }
  }, [receiver])

  // The connection lives while the library is shown, so logout's DB delete is not blocked.
  useEffect(() => {
    const s = openStore()
    storeRef.current = s
    void load()
    return () => {
      storeRef.current = null
      s.close()
    }
    // openStore is read once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Another device's change was applied (here or in another tab): list again.
  useEffect(() => {
    if (!receiver) return
    let version = receiver.getState().version
    return receiver.subscribe(() => {
      const v = receiver.getState().version
      if (v === version) return
      version = v
      void load()
    })
  }, [receiver, load])

  /** Resolves with the new noteId; rejects (nothing stored, defaults untouched) on any failure. */
  const create = useCallback(
    async ({ title, background, orientation }: CreateInput): Promise<string> => {
      const s = storeRef.current
      // Titles are numbered from the loaded list, so only a loaded library may create.
      if (!s || statusRef.current !== 'ready') throw new Error('library not ready')
      const noteId = newId()
      const r = createNote({
        title,
        existingTitles: itemsRef.current.flatMap((i) => (i.title === null ? [] : [i.title])),
        background,
        orientation,
        noteId,
        pageId: newId(),
        pageRev: newId(),
        metaRev: newId(),
        orderRev: newId(),
        now: new Date().toISOString(),
        editedBy: editedBy ?? detectEditedBy(),
      })
      if ('error' in r) throw new Error(r.error)
      await s.writeNote(r.note)
      seq.current++ // a load that started before this write must not replace the list
      defaults.write({ background, orientation })
      const item = toItem({ noteId, result: { result: 'ok', writable: true, note: r.note } })
      setState((p) => ({ ...p, items: sortItems([...p.items.filter((i) => i.noteId !== noteId), item]) }))
      return noteId
    },
    [defaults, editedBy],
  )

  /** The device copy of a note as `.kkj` bytes, for [파일로 내려받기] of the "열 수 없음" sheet. */
  const exportCopy = useCallback(async (noteId: string): Promise<{ name: string; bytes: Uint8Array }> => {
    const s = storeRef.current
    if (!s) throw new Error('library not ready')
    const r = await s.loadNote(noteId)
    if (r?.result !== 'ok' || !r.note) throw new Error('no readable copy')
    return { name: `${r.note.meta.title}-${noteId.slice(0, 8)}.kkj`, bytes: await encodeKkj(r.note) }
  }, [])

  return { status: state.status, items: state.items, failed: state.failed, reload: load, create, exportCopy }
}
