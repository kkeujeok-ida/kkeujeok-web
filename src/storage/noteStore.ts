// Note working copies in IndexedDB (AD-10). One record per note in the `notes`
// store of the `kkeujeok-notes` DB: key = noteId, value = the gzip `.kkj`
// bytes. Mirrors kkeujeok-client/lib/storage/note_store.dart.
import { type IDBPDatabase, type IDBPTransaction, wrap } from 'idb'
import { decodeKkj, encodeKkj } from '../model/kkjCodec'
import type { Note, NoteReadResult } from '../model/note'
import { NOTE_DB_NAME } from './noteDb'

export const NOTES_STORE = 'notes'

/** A save did not happen. The previous record and the in-memory note are intact. */
export class NoteSaveError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'NoteSaveError'
  }
}

// DB version n+1 = UPGRADES[n]. A later epic appends a step (base/sync stores)
// and never edits an old one; all steps run in the one upgrade transaction.
const UPGRADES: ((db: IDBPDatabase) => void)[] = [
  (db) => void db.createObjectStore(NOTES_STORE),
]

export type WriteTx = IDBPTransaction<unknown, string[], 'readwrite'>

export type NoteStore = {
  /** Rejects with NoteSaveError for every failure. Never touches `note`. */
  writeNote(note: Note): Promise<void>
  /** `null` when there is no record for `noteId`. */
  loadNote(noteId: string): Promise<NoteReadResult | null>
  listNotes(): Promise<{ noteId: string; result: NoteReadResult }[]>
  close(): void
}

const UNREADABLE: NoteReadResult = { result: 'unreadable', writable: false }

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])

// `instanceof` is unreliable across realms (jsdom), so go by the buffer view.
function asBytes(v: unknown): Uint8Array | null {
  return ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null
}

async function decodeRecord(noteId: string, value: unknown): Promise<NoteReadResult> {
  const bytes = asBytes(value)
  if (!bytes) return UNREADABLE
  const r = await decodeKkj(bytes)
  // The key is the identity; an inner noteId that differs is unreadable.
  return r.note && r.note.noteId !== noteId ? UNREADABLE : r
}

/**
 * `afterPut` is a test hook, called inside the write transaction after `put`;
 * throwing or aborting there makes the write fail like a quota error would.
 */
export function openNoteStore(
  idb: IDBFactory = globalThis.indexedDB,
  opts: {
    afterPut?: (tx: WriteTx) => void | Promise<void>
    /** Test hook: runs after the pre-check read, before the write transaction. */
    afterCheck?: () => void | Promise<void>
  } = {},
): NoteStore {
  let dbp: Promise<IDBPDatabase> | null = null

  // Opened on first use and again after a versionchange closed it.
  const open = (): Promise<IDBPDatabase> => {
    if (dbp) return dbp
    const req = idb.open(NOTE_DB_NAME, UPGRADES.length)
    req.onupgradeneeded = (e) => {
      const db = wrap(req.result) as unknown as IDBPDatabase
      for (let v = e.oldVersion; v < UPGRADES.length; v++) UPGRADES[v]!(db)
    }
    // An upgrade held up by an older connection elsewhere must not hang a save.
    let blocked = false
    const opening = new Promise<IDBPDatabase>((resolve, reject) => {
      req.onblocked = () => {
        blocked = true
        reject(new NoteSaveError('database is blocked by another connection'))
      }
      ;(wrap(req) as unknown as Promise<IDBPDatabase>).then((db) => {
        if (blocked) db.close() // the caller already gave up on this open
        else resolve(db)
      }, reject)
    })
    const p: Promise<IDBPDatabase> = opening.then(
      (db) => {
        const drop = () => {
          if (dbp === p) dbp = null
        }
        // Whoever opens the DB must yield, or logout's delete stays blocked.
        db.addEventListener('versionchange', () => {
          db.close()
          drop()
        })
        db.addEventListener('close', drop)
        return db
      },
      (e) => {
        if (dbp === p) dbp = null
        throw e
      },
    )
    return (dbp = p)
  }

  // Per-note chain so a write and a read of one note never interleave.
  const locks = new Map<string, Promise<unknown>>()
  function locked<T>(noteId: string, body: () => Promise<T>): Promise<T> {
    const run = (locks.get(noteId) ?? Promise.resolve()).then(body)
    const done = run.then(
      () => {},
      () => {},
    )
    locks.set(noteId, done)
    void done.then(() => {
      if (locks.get(noteId) === done) locks.delete(noteId)
    })
    return run
  }

  // A versionchange may close the connection between open() and its use:
  // reopen and retry once.
  async function withDb<T>(fn: (db: IDBPDatabase) => Promise<T> | T): Promise<T> {
    try {
      return await fn(await open())
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'InvalidStateError')) throw e
      dbp = null
      return await fn(await open())
    }
  }

  const readBytes = async (noteId: string) =>
    (await withDb((db) => db.get(NOTES_STORE, noteId))) as unknown

  return {
    writeNote(note) {
      const { noteId } = note
      return locked(noteId, async () => {
        let tx: WriteTx | undefined
        try {
          const bytes = await encodeKkj(note)
          // What is written must read back ok (rejects NaN/Infinity and the like).
          if (!(await decodeKkj(bytes)).writable) throw new NoteSaveError('note is not valid')
          // ponytail: re-decodes the existing record on every save; cache the
          // verdict if large pages make this slow.
          const existing = await readBytes(noteId)
          if (existing !== undefined && !(await decodeRecord(noteId, existing)).writable) {
            throw new NoteSaveError('existing record is not readable by this client')
          }
          await opts.afterCheck?.()
          tx = (await withDb((db) =>
            db.transaction([NOTES_STORE], 'readwrite'),
          )) as unknown as WriteTx
          tx.done.catch(() => {}) // the failure is reported through the awaits below
          const store = tx.objectStore(NOTES_STORE)
          // Another tab may have replaced the record since it was checked.
          const now = (await store.get(noteId)) as unknown
          const a = asBytes(existing)
          const b = asBytes(now)
          const unchanged = existing === undefined ? now === undefined : !!a && !!b && sameBytes(a, b)
          if (!unchanged) throw new NoteSaveError('record changed while saving')
          await store.put(bytes, noteId)
          await opts.afterPut?.(tx)
          await tx.done
        } catch (e) {
          try {
            tx?.abort()
          } catch {
            // already finished or aborted
          }
          if (e instanceof NoteSaveError) throw e
          throw new NoteSaveError('could not write note', e)
        }
      })
    },

    loadNote(noteId) {
      return locked(noteId, async () => {
        const value = await readBytes(noteId)
        return value === undefined ? null : decodeRecord(noteId, value)
      })
    },

    async listNotes() {
      const [keys, values] = await withDb((db) => {
        const tx = db.transaction(NOTES_STORE)
        return Promise.all([tx.store.getAllKeys(), tx.store.getAll() as Promise<unknown[]>])
      })
      const out: { noteId: string; result: NoteReadResult }[] = []
      for (const [i, key] of keys.entries()) {
        if (typeof key !== 'string') continue
        out.push({ noteId: key, result: await decodeRecord(key, values[i]) })
      }
      return out
    },

    close() {
      void dbp?.then((db) => db.close(), () => {})
      dbp = null
    },
  }
}
