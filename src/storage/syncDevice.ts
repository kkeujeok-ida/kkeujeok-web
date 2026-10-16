// Per-browser sync record (spec sync.md "On the device"), key 'device' in the
// `device` store of the note DB. No token is ever part of it; keys this client
// does not know are kept in `extra`. Each call is one IndexedDB transaction,
// so another tab cannot slip a write in between its read and its write.
import { type Db, DEVICE_STORE, NoteSaveError } from './noteDb'
import type { JsonMap } from './syncInfo'

const KEY = 'device'

export type SyncDevice = {
  sub: string | null
  email: string | null
  rootFolderId: string | null
  conflictsFolderId: string | null
  pageToken: string | null
  createIntents: JsonMap[]
  extra: JsonMap
}

const STRINGS = ['sub', 'email', 'rootFolderId', 'conflictsFolderId', 'pageToken'] as const

export const emptyDevice = (): SyncDevice => ({
  sub: null,
  email: null,
  rootFolderId: null,
  conflictsFolderId: null,
  pageToken: null,
  createIntents: [],
  extra: {},
})

const isObj = (v: unknown): v is JsonMap => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Null unless `json` has the right shape; a missing key is its default. */
export function deviceFromJson(json: unknown): SyncDevice | null {
  if (!isObj(json)) return null
  for (const k of STRINGS) if (json[k] != null && typeof json[k] !== 'string') return null
  const ci = json.createIntents ?? []
  if (!Array.isArray(ci)) return null
  for (const e of ci) {
    if (!isObj(e) || typeof e.kkeujeokId !== 'string' || typeof e.kind !== 'string' || typeof e.parentId !== 'string') {
      return null
    }
  }
  const s = (k: (typeof STRINGS)[number]) => (json[k] as string | null | undefined) ?? null
  return {
    sub: s('sub'),
    email: s('email'),
    rootFolderId: s('rootFolderId'),
    conflictsFolderId: s('conflictsFolderId'),
    pageToken: s('pageToken'),
    createIntents: ci as JsonMap[],
    extra: Object.fromEntries(
      Object.entries(json).filter(([k]) => !(STRINGS as readonly string[]).includes(k) && k !== 'createIntents'),
    ),
  }
}

export const deviceToJson = (d: SyncDevice): JsonMap => ({
  ...d.extra,
  sub: d.sub,
  email: d.email,
  rootFolderId: d.rootFolderId,
  conflictsFolderId: d.conflictsFolderId,
  pageToken: d.pageToken,
  createIntents: d.createIntents,
})

export type SyncDeviceStore = {
  /** Never throws; no record or an unreadable one is an empty record. */
  read(): Promise<SyncDevice>
  /** Never throws; tells an absent record from an unreadable one and from a failed read. */
  readState(): Promise<{ kind: 'absent' | 'unreadable' | 'failed' } | { kind: 'ok'; device: SyncDevice }>
  /**
   * Tags the browser with this account. True when there was no record or it has
   * the same `sub` (the e-mail is refreshed); false, nothing written, for another
   * account (Story 3.8) or an unreadable record. Rejects when the write fails.
   */
  adoptAccount(sub: string, email: string): Promise<boolean>
  /** Rejects when the write fails or the existing record is unreadable. */
  write(d: SyncDevice): Promise<void>
  /** Removes the record, readable or not. Best effort. */
  clear(): Promise<void>
}

export function createSyncDeviceStore(ndb: Db): SyncDeviceStore {
  // `readable` is false when a record is there but not a valid one.
  const load = (raw: unknown) => {
    if (raw === undefined) return { device: emptyDevice(), readable: true }
    const d = deviceFromJson(raw)
    return d ? { device: d, readable: true } : { device: emptyDevice(), readable: false }
  }
  // Read-modify-write in one transaction. `fn` returns the record to put, or null for no write.
  const modify = <T>(fn: (cur: ReturnType<typeof load>) => { put: SyncDevice | null; result: T }): Promise<T> =>
    ndb.withDb(async (db) => {
      const tx = db.transaction([DEVICE_STORE], 'readwrite')
      tx.done.catch(() => {})
      try {
        const store = tx.objectStore(DEVICE_STORE)
        const { put, result } = fn(load(await store.get(KEY)))
        if (put) await store.put(deviceToJson(put), KEY)
        await tx.done
        return result
      } catch (e) {
        try {
          tx.abort()
        } catch {
          // already finished
        }
        throw e instanceof NoteSaveError ? e : new NoteSaveError('could not write sync device', e)
      }
    })

  return {
    async read() {
      try {
        return await ndb.withDb(async (db) => load(await db.get(DEVICE_STORE, KEY)).device)
      } catch {
        return emptyDevice()
      }
    },
    async readState() {
      try {
        const raw: unknown = await ndb.withDb((db) => db.get(DEVICE_STORE, KEY))
        if (raw === undefined) return { kind: 'absent' as const }
        const d = deviceFromJson(raw)
        return d ? { kind: 'ok' as const, device: d } : { kind: 'unreadable' as const }
      } catch {
        return { kind: 'failed' as const }
      }
    },
    adoptAccount: (sub, email) =>
      modify((cur) => {
        const d = cur.device
        if (sub === '' || !cur.readable || (d.sub !== null && d.sub !== sub)) return { put: null, result: false }
        return { put: d.sub === sub && d.email === email ? null : { ...d, sub, email }, result: true }
      }),
    write: (d) =>
      modify((cur) => {
        if (!cur.readable) throw new NoteSaveError('sync device record is unreadable')
        return { put: d, result: undefined }
      }),
    async clear() {
      try {
        await ndb.withDb((db) => db.delete(DEVICE_STORE, KEY))
      } catch {
        // best effort
      }
    },
  }
}
