// The note-data database of this browser (AD-10). Epics 2-3 store into it under
// this one name. Device settings live in localStorage and are not touched here.
// Whoever opens it must close the connection on `versionchange`, or a delete
// stays blocked.
export const NOTE_DB_NAME = 'kkeujeok-notes'

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
