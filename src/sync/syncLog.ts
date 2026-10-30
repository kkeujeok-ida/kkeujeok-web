// The local sync log (spec sync-log.md): its own IndexedDB database, outside the
// note DB, so logout (which deletes the note DB) leaves it alone. Holds no note
// content; every entry passes `checkLogEntry` before it is stored.
import { SUPPORTED_FORMAT_VERSION } from '../model/note'
import { openDatabase } from '../storage/noteDb'
import { LOG_CAUSES, checkLogEntry, validLogReason } from './syncLogEntry'

export const SYNC_LOG_DB = 'kkeujeok-sync-log'
export const LOG_STORE = 'log'

/** Entries kept; appending one more drops the oldest. */
export const syncLogKeep = 5000

type Entry = Record<string, unknown>

// A random label per browser, not tied to the account.
function deviceLabel(): string {
  try {
    let t = localStorage.getItem('kkeujeok-log-device')
    if (!t || !/^[0-9a-f]{8}$/.test(t)) {
      t = crypto.randomUUID().slice(0, 8)
      localStorage.setItem('kkeujeok-log-device', t)
    }
    return t
  } catch {
    return 'unknown'
  }
}

export function createSyncLog(
  idb: IDBFactory = globalThis.indexedDB,
  clock: () => Date = () => new Date(),
) {
  const ndb = openDatabase(idb, SYNC_LOG_DB, [
    (db) => void db.createObjectStore(LOG_STORE, { autoIncrement: true }),
  ])

  // Oldest first, broken rows skipped, at most the newest `syncLogKeep`.
  async function entries(): Promise<Entry[]> {
    const rows = (await ndb.withDb((db) => db.getAll(LOG_STORE))) as unknown[]
    const ok = rows.filter((r) => checkLogEntry(r).ok) as Entry[]
    return ok.slice(-syncLogKeep)
  }

  // Consecutive `error` entries per note since its last `synced`, in memory: a reload starts the count again
  // (shortcut: the log is diagnostic only).
  const failures = new Map<string, number>()

  /**
   * Stores one entry stamped with the clock's time. A `reason` outside its domain
   * becomes `other`. False, nothing stored, when the entry is invalid or the
   * write fails. Never throws.
   */
  async function put(event: string, fields: Entry = {}): Promise<boolean> {
    try {
      const entry: Entry = { ...fields, at: clock().toISOString(), event }
      if ('reason' in entry && !validLogReason(entry.reason)) entry.reason = 'other'
      if ('cause' in entry && !LOG_CAUSES.includes(entry.cause as string)) entry.cause = 'unknown'
      if ('exception' in entry) {
        // A type name only: other characters become `_`, 64 at most.
        const t = typeof entry.exception === 'string' ? entry.exception.replace(/[^A-Za-z0-9_.$:]/g, '_').slice(0, 64) : ''
        if (t) entry.exception = t
        else delete entry.exception
      }
      if (!checkLogEntry(entry).ok) return false
      await ndb.withDb((db) => db.add(LOG_STORE, entry))
    } catch {
      return false
    }
    // The entry is stored; a failed trim is tried again by the next append.
    try {
      await ndb.withDb(async (db) => {
        const tx = db.transaction(LOG_STORE, 'readwrite')
        const extra = (await tx.store.count()) - syncLogKeep
        if (extra > 0) for (const k of await tx.store.getAllKeys(undefined, extra)) await tx.store.delete(k)
        await tx.done
      })
    } catch {
      // kept
    }
    return true
  }

  return {
    entries,

    /**
     * Adds one entry stamped with the clock's time. A `reason` outside its domain becomes `other`.
     * False, nothing stored, when the entry is invalid or the write fails. Never throws.
     * More than 3 failures in a row of one note add a `repeatedFailure` line.
     */
    async append(event: string, fields: Entry = {}): Promise<boolean> {
      const ok = await put(event, fields)
      const id = fields.noteId
      if (!ok || typeof id !== 'string') return ok
      if (event === 'stateChange' && fields.to === 'synced') failures.delete(id)
      if (event === 'error') {
        const n = (failures.get(id) ?? 0) + 1
        failures.set(id, n)
        if (n > 3) await put('repeatedFailure', { noteId: id, count: n, ...(typeof fields.reason === 'string' && { reason: fields.reason }) })
      }
      return ok
    },


    /** The file to download: the header line, then the entries. Rejects when the log cannot be read. */
    async exportJsonl({ appVersion, buildId = 'unknown', buildNumber = 'unknown', now }: { appVersion: string; buildId?: string; buildNumber?: string; now: Date }) {
      const at = now.toISOString()
      const header = {
        type: 'header',
        app: 'kkeujeok',
        appVersion,
        buildId,
        buildNumber,
        deviceLabel: deviceLabel(),
        platform: 'web',
        supportedFormatVersion: SUPPORTED_FORMAT_VERSION,
        exportedAt: at,
      }
      const lines = [header, ...(await entries())].map((x) => `${JSON.stringify(x)}\n`)
      return { name: `kkeujeok-sync-log-${at.slice(0, 10)}.jsonl`, text: lines.join('') }
    },

    close: () => ndb.close(),
  }
}
export type SyncLog = ReturnType<typeof createSyncLog>

let shared: SyncLog | undefined
/** The one log of this page session. */
export const syncLog = (): SyncLog => (shared ??= createSyncLog())
