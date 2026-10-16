// The note-data database of this browser (AD-10). Epics 2-3 store into it under
// this one name. Device settings live in localStorage and are not touched here.
// Whoever opens it must close the connection on `versionchange`, or a delete
// stays blocked.
import { type IDBPDatabase, wrap } from 'idb'

export const NOTE_DB_NAME = 'kkeujeok-notes'
export const NOTES_STORE = 'notes'
export const BASE_STORE = 'base'
export const SYNC_STORE = 'sync'
export const DEVICE_STORE = 'device'

/** A write did not happen. Earlier values are intact. */
export class NoteSaveError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'NoteSaveError'
  }
}

// DB version n+1 = UPGRADES[n]. A later epic appends a step and never edits an
// old one; all steps run in the one upgrade transaction.
const UPGRADES: ((db: IDBPDatabase) => void)[] = [
  (db) => void db.createObjectStore(NOTES_STORE),
  // base copy (key noteId, .kkj bytes), sync info (key noteId), device record (key 'device')
  (db) => {
    db.createObjectStore(BASE_STORE)
    db.createObjectStore(SYNC_STORE)
    db.createObjectStore(DEVICE_STORE)
  },
]

export type Db = {
  /** Runs `fn` on the open connection; reopens once after a versionchange closed it. */
  withDb<T>(fn: (db: IDBPDatabase) => Promise<T> | T): Promise<T>
  close(): void
}

/** One connection that closes itself on `versionchange` and reopens on next use. */
export function openDatabase(
  idb: IDBFactory,
  name: string,
  upgrades: ((db: IDBPDatabase) => void)[],
): Db {
  let dbp: Promise<IDBPDatabase> | null = null

  const open = (): Promise<IDBPDatabase> => {
    if (dbp) return dbp
    const req = idb.open(name, upgrades.length)
    req.onupgradeneeded = (e) => {
      const db = wrap(req.result) as unknown as IDBPDatabase
      for (let v = e.oldVersion; v < upgrades.length; v++) upgrades[v]!(db)
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

  return {
    async withDb(fn) {
      try {
        return await fn(await open())
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'InvalidStateError')) throw e
        dbp = null
        return await fn(await open())
      }
    },
    close() {
      void dbp?.then((db) => db.close(), () => {})
      dbp = null
    },
  }
}

export const openNoteDb = (idb: IDBFactory = globalThis.indexedDB): Db =>
  openDatabase(idb, NOTE_DB_NAME, UPGRADES)

// Default for how long a delete may stay blocked by another connection before it is an error.
const BLOCKED_MS = 5000

// Resolves once the database is gone (also when it never existed). Other
// connections get `versionchange` and are expected to close; if they do not
// within blockedMs, rejects. Never swallows a failure.
export function deleteNoteDatabase(
  idb: IDBFactory | undefined = globalThis.indexedDB,
  blockedMs = BLOCKED_MS,
): Promise<void> {
  if (!idb) return Promise.resolve() // no IndexedDB: no note copy can exist
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (fn: () => void) => {
      clearTimeout(timer)
      fn()
    }
    const req = idb.deleteDatabase(NOTE_DB_NAME)
    req.onsuccess = () => done(resolve)
    req.onerror = () => done(() => reject(req.error ?? new Error('delete failed')))
    // Still pending: it completes when the other connection closes.
    req.onblocked = () => {
      timer ??= setTimeout(() => reject(new Error('delete blocked')), blockedMs)
    }
  })
}
