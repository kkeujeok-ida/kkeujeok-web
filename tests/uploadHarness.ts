// Shared setup for the upload tests: a note store over fake-indexeddb, the fake
// Drive, a validating in-memory log and an uploader with every outside thing injected.
import { createHash } from 'node:crypto'
import { openNoteDb } from '../src/storage/noteDb'
import { encodeKkj } from '../src/model/kkjCodec'
import type { Note } from '../src/model/note'
import { type Ctx, applyOp, createNote } from '../src/ops/ops'
import { openNoteStore } from '../src/storage/noteStore'
import { createSyncDeviceStore, emptyDevice } from '../src/storage/syncDevice'
import { createMergeIo } from '../src/sync/mergeIo'
import { type UploaderDeps, createNoteUploader } from '../src/sync/noteUploader'
import { checkLogEntry } from '../src/sync/syncLogEntry'
import { createFakeDrive } from './fakeDrive'

export const NID = '01926f3a-0000-7000-8000-0000000000a1'
export const PA = '01926f3a-0000-7000-8000-0000000000b1'
export const PB = '01926f3a-0000-7000-8000-0000000000b2'
const T0 = '2026-10-10T04:20:00.000Z'

/** A note with the given pages (id -> rev), as another or this device would have it. */
export function mkNote(o: { noteId?: string; title?: string; pages?: Record<string, string> } = {}): Note {
  const r = createNote({
    title: o.title ?? '수학 노트',
    existingTitles: [],
    background: 'plain',
    orientation: 'portrait',
    noteId: o.noteId ?? NID,
    pageId: PA,
    pageRev: 'a1',
    metaRev: 'm1',
    orderRev: 'o1',
    now: T0,
    editedBy: 'Chrome, Windows',
  })
  if ('error' in r) throw new Error(r.error)
  const note = r.note
  const first = note.pages[0]!
  note.pages = Object.entries(o.pages ?? { [PA]: 'a1' }).map(([id, rev]) => ({ ...structuredClone(first), id, rev }))
  return note
}

export const stroke = (id: string, points = 1) => ({
  id,
  type: 'stroke',
  tool: 'pen',
  color: '#000000',
  width: 2,
  usePressure: false,
  points: Array.from({ length: points }, (_, i) => [1 + i, 2, 0.5, 0]),
})

let seq = 0
/** `note` with one stroke added to `pageId`; the page gets revision `rev`. */
export function withStroke(note: Note, pageId: string, rev: string, strokeId = `s${++seq}`): Note {
  const ctx: Ctx = { rev, now: '2026-10-11T04:20:00.000Z', editedBy: 'Chrome, Windows', lastSeenRemoteSeq: 0 }
  const r = applyOp(note, { op: 'addStroke', pageId, stroke: stroke(strokeId) }, ctx)
  if ('error' in r) throw new Error(r.error)
  return r.note
}

export const md5Of = (b: Uint8Array) => createHash('md5').update(b).digest('hex')
export const bytesOf = (n: Note) => encodeKkj(n)

export async function makeEnv(o: Partial<UploaderDeps> & { rootFolderId?: string | null } = {}) {
  const store = openNoteStore()
  const ndb = openNoteDb()
  const device = createSyncDeviceStore(ndb)
  if (o.rootFolderId !== null) await device.write({ ...emptyDevice(), rootFolderId: o.rootFolderId ?? 'ROOT' })
  const drive = createFakeDrive()
  const entries: Record<string, unknown>[] = []
  const invalid: unknown[] = []
  let nowMs = Date.UTC(2026, 9, 12)
  const hooks: { onLog?: (event: string, fields: Record<string, unknown>) => void } = {}
  const log = {
    async append(event: string, fields: Record<string, unknown> = {}) {
      const e = { at: new Date((nowMs += 1000)).toISOString(), event, ...fields }
      if (!checkLogEntry(e).ok) invalid.push(e)
      entries.push(e)
      hooks.onLog?.(event, fields)
      return true
    },
  }
  const sleeps: number[] = []
  const flags = { online: true, allowed: true }
  let ids = 0
  const merge = createMergeIo({
    store,
    editedBy: () => 'Chrome, Windows',
    now: () => '2026-10-12T04:20:00.000Z',
    newId: () => `01926f3a-0000-7000-8000-${String(++ids).padStart(12, '0')}`,
  })
  const deps: UploaderDeps = {
    store,
    drive,
    device,
    log,
    merge,
    allowed: () => flags.allowed,
    online: () => flags.online,
    sleep: async (ms) => void sleeps.push(ms),
    jitter: () => 0.5,
    ...o,
  }
  const uploader = createNoteUploader(deps)
  return {
    store,
    drive,
    device,
    entries,
    invalid,
    sleeps,
    flags,
    hooks,
    deps,
    uploader,
    /** A fresh uploader over the same store and Drive: "the tab was reloaded". */
    reload: () => createNoteUploader(deps),
    events: (name: string) => entries.filter((e) => e.event === name),
    sync: (id = NID) => store.readSync(id),
    close: () => {
      store.close()
      ndb.close()
    },
  }
}
export type Env = Awaited<ReturnType<typeof makeEnv>>

/** What another device uploads after editing one page: the stroke, and the base revision in the page's lineage (sync step 1). */
export function foreignEdit(note: Note, pageId: string, rev: string): Note {
  const before = note.pages.find((p) => p.id === pageId)!.rev
  const n = withStroke(note, pageId, rev)
  ;(n.pages.find((p) => p.id === pageId) as Record<string, unknown>).lineage = [before]
  return n
}
