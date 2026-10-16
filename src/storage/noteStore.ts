// Note copies in IndexedDB (AD-10), key = noteId in each store of the
// `kkeujeok-notes` DB: `notes` = working copy (gzip `.kkj` bytes), `base` = base
// copy (bytes), `sync` = the note's sync record. Mirrors
// kkeujeok-client/lib/storage/note_store.dart; the three-file group write is one
// IndexedDB transaction here, so there is no commit marker or orphan cleanup.
import type { IDBPTransaction } from 'idb'
import { decodeKkj, encodeKkj } from '../model/kkjCodec'
import type { Note, NoteReadResult } from '../model/note'
import { hasUnsentRule } from '../sync/hasUnsent'
import { revisionIdPattern } from '../sync/syncLogEntry'
import {
  BASE_STORE,
  NOTES_STORE,
  NoteSaveError,
  SYNC_STORE,
  openNoteDb,
} from './noteDb'
import { type SyncInfo, type SyncState, emptySync, syncFromJson, syncToJson } from './syncInfo'
import { createRemoteCardStore, type RemoteCardStore } from './remoteCards'
import { createSyncDeviceStore } from './syncDevice'
import { emitSyncChanged } from '../sync/syncSignal'

export { NOTES_STORE, NoteSaveError }

/** The message of the error `updateSync` throws for a sync record it cannot read (never overwritten). */
export const SYNC_UNREADABLE = 'the sync record is unreadable'

export type WriteTx = IDBPTransaction<unknown, string[], 'readwrite'>

/** What `readSync` knows about one note's sync records. */
export type SyncRead = { info: SyncInfo; base: Note | null; hasUnsent: boolean; state: SyncState; /** There is no note here at all (no working copy, no record). */ missing?: true }

export type NoteStore = {
  /** Rejects with NoteSaveError for every failure. Never touches `note`. Writes `notes` only. */
  writeNote(note: Note): Promise<void>
  /** `null` when there is no record for `noteId`. */
  loadNote(noteId: string): Promise<NoteReadResult | null>
  listNotes(): Promise<{ noteId: string; result: NoteReadResult }[]>
  /** Every noteId that has a working copy. */
  listIds(): Promise<string[]>
  /**
   * Working copy, base copy and sync record in one transaction (all or nothing).
   * A null `base` keeps the stored base, which `info.baseHeadRevisionId` needs.
   */
  commitSync(working: Note, base: Note | null, info: SyncInfo): Promise<void>
  /**
   * A receive (Story 3.14): working, base (= `remote`) and sync record in one
   * transaction, only while the stored working copy still is `expected` (`null` = no
   * working copy yet). False, nothing written, when it moved meanwhile.
   */
  commitReceive(noteId: string, expected: Note | null, remote: Note, info: SyncInfo): Promise<boolean>
  /**
   * Changes one note's sync record (and base copy) without touching the working
   * copy. `change` gets the record read under the note's lock. Returns what was committed.
   */
  updateSync(noteId: string, change: (cur: SyncInfo) => SyncInfo, opts?: { base?: Note }): Promise<SyncInfo>
  /**
   * Deletes the note's three records (Story 3.18: deleted in Drive, nothing unsent), only while the
   * stored working copy still is `expected`. False, nothing deleted, when it moved or is gone.
   */
  removeNote(noteId: string, expected: Note): Promise<boolean>
  /** Forgets the Drive file: pending, no fileId/base/pendingVerify/session/intent/error. */
  resetSync(noteId: string): Promise<void>
  /** Never throws. */
  readSync(noteId: string): Promise<SyncRead>
  /** Cards of notes on Drive that are not downloaded yet (Story 3.14), over the same connection. */
  remote: RemoteCardStore
  close(): void
}

const UNREADABLE: NoteReadResult = { result: 'unreadable', writable: false }

// `instanceof` is unreliable across realms (jsdom), so go by the buffer view.
function asBytes(v: unknown): Uint8Array | null {
  return ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null
}

// Bytes by content, anything else (sync records) by JSON.
function same(a: unknown, b: unknown): boolean {
  const x = asBytes(a)
  const y = asBytes(b)
  if (x || y) return !!x && !!y && x.length === y.length && x.every((v, i) => v === y[i])
  return JSON.stringify(a) === JSON.stringify(b)
}

async function decodeRecord(noteId: string, value: unknown): Promise<NoteReadResult> {
  const bytes = asBytes(value)
  if (!bytes) return UNREADABLE
  const r = await decodeKkj(bytes)
  // The key is the identity; an inner noteId that differs is unreadable.
  return r.note && r.note.noteId !== noteId ? UNREADABLE : r
}

// What is written must read back ok (rejects NaN/Infinity and the like).
async function encodeChecked(note: Note): Promise<Uint8Array> {
  const bytes = await encodeKkj(note)
  if (!(await decodeKkj(bytes)).writable) throw new NoteSaveError('note is not valid')
  return bytes
}

const DEL = Symbol('delete')
type Expect = [store: string, key: string, value: unknown]
type Put = [store: string, key: string, value: unknown]

/**
 * `afterPut` is a test hook, called inside the write transaction after each `put`
 * (with the store's name); throwing or aborting there makes the write fail like a
 * quota error would. `getAccount` tags the browser's device record with the
 * signed-in account after each successful write.
 */
export function openNoteStore(
  idb: IDBFactory = globalThis.indexedDB,
  opts: {
    afterPut?: (tx: WriteTx, store: string) => void | Promise<void>
    /** Test hook: runs after the pre-check reads, before the write transaction. */
    afterCheck?: () => void | Promise<void>
    /** Runs after each successful write; its failure is swallowed. */
    onWrite?: () => void | Promise<void>
    getAccount?: () => { sub: string; email: string } | null
  } = {},
): NoteStore {
  const ndb = openNoteDb(idb)
  const { withDb } = ndb
  const device = createSyncDeviceStore(ndb)

  async function notify(noteId: string) {
    emitSyncChanged(noteId)
    try {
      await opts.onWrite?.()
      const a = opts.getAccount?.()
      if (a) await device.adoptAccount(a.sub, a.email)
    } catch {
      // the write is done; the tag is retried by the next write
    }
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

  // One transaction: every `expect` must still hold (another tab may have changed
  // a record since it was read), then the puts. Any failure aborts all of it.
  async function apply(stores: string[], expect: Expect[], puts: Put[]): Promise<void> {
    let tx: WriteTx | undefined
    try {
      await opts.afterCheck?.()
      tx = (await withDb((db) => db.transaction(stores, 'readwrite'))) as unknown as WriteTx
      tx.done.catch(() => {}) // the failure is reported through the awaits below
      for (const [s, k, v] of expect) {
        if (!same(await tx.objectStore(s).get(k), v)) throw new NoteSaveError('record changed while saving')
      }
      for (const [s, k, v] of puts) {
        if (v === DEL) await tx.objectStore(s).delete(k)
        else await tx.objectStore(s).put(v, k)
        await opts.afterPut?.(tx, s)
      }
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
  }

  const wrapSave = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      throw e instanceof NoteSaveError ? e : new NoteSaveError('could not write sync state', e)
    }
  }

  // The three records of a note, read in one transaction.
  const readRaw = (noteId: string) =>
    withDb((db) => {
      const tx = db.transaction([NOTES_STORE, BASE_STORE, SYNC_STORE])
      return Promise.all([
        tx.objectStore(NOTES_STORE).get(noteId) as Promise<unknown>,
        tx.objectStore(BASE_STORE).get(noteId) as Promise<unknown>,
        tx.objectStore(SYNC_STORE).get(noteId) as Promise<unknown>,
      ])
    })

  // The record to store: it must read back as a valid sync record.
  function syncRecord(info: SyncInfo): unknown {
    const json = syncToJson(info)
    if (!syncFromJson(json)) throw new NoteSaveError('sync info is not valid')
    return json
  }

  const readBytes = async (noteId: string) =>
    (await withDb((db) => db.get(NOTES_STORE, noteId))) as unknown

  const store: NoteStore = {
    async writeNote(note) {
      const { noteId } = note
      await locked(noteId, async () => {
        try {
          const bytes = await encodeChecked(note)
          // ponytail: re-decodes the existing record on every save; cache the
          // verdict if large pages make this slow.
          const existing = await readBytes(noteId)
          if (existing !== undefined && !(await decodeRecord(noteId, existing)).writable) {
            throw new NoteSaveError('existing record is not readable by this client')
          }
          await apply([NOTES_STORE], [[NOTES_STORE, noteId, existing]], [[NOTES_STORE, noteId, bytes]])
        } catch (e) {
          throw e instanceof NoteSaveError ? e : new NoteSaveError('could not write note', e)
        }
      })
      await notify(noteId)
    },

    async commitSync(working, base, info) {
      const { noteId } = working
      await locked(noteId, () =>
        wrapSave(async () => {
          const id = info.baseHeadRevisionId
          if (id !== null && !revisionIdPattern.test(id)) throw new NoteSaveError('baseHeadRevisionId is not a valid id')
          if (id === null && base) throw new NoteSaveError('a base needs a baseHeadRevisionId')
          if (base && base.noteId !== noteId) throw new NoteSaveError('base belongs to another note')
          const record = syncRecord(info)
          const workingBytes = await encodeChecked(working)
          const baseBytes = base ? await encodeChecked(base) : null
          const [oldWorking, oldBase, oldSync] = await readRaw(noteId)
          if (oldWorking !== undefined && !(await decodeRecord(noteId, oldWorking)).writable) {
            throw new NoteSaveError('existing record is not readable by this client')
          }
          if (!base && id !== null && !(await decodeRecord(noteId, oldBase)).note) {
            throw new NoteSaveError('the base copy is missing')
          }
          const puts: Put[] = [[NOTES_STORE, noteId, workingBytes]]
          if (baseBytes) puts.push([BASE_STORE, noteId, baseBytes])
          else if (id === null && oldBase !== undefined) puts.push([BASE_STORE, noteId, DEL])
          puts.push([SYNC_STORE, noteId, record])
          await apply(
            [NOTES_STORE, BASE_STORE, SYNC_STORE],
            [[NOTES_STORE, noteId, oldWorking], [BASE_STORE, noteId, oldBase], [SYNC_STORE, noteId, oldSync]],
            puts,
          )
        }),
      )
      await notify(noteId)
    },

    async commitReceive(noteId, expected, remote, info) {
      const done = await locked(noteId, () =>
        wrapSave(async () => {
          const id = info.baseHeadRevisionId
          if (id === null || !revisionIdPattern.test(id)) throw new NoteSaveError('baseHeadRevisionId is not a valid id')
          if (remote.noteId !== noteId) throw new NoteSaveError('note belongs to another id')
          const record = syncRecord(info)
          const bytes = await encodeChecked(remote)
          const [oldWorking, oldBase, oldSync] = await readRaw(noteId)
          if (expected === null) {
            if (oldWorking !== undefined) return false
          } else {
            const cur = oldWorking === undefined ? null : (await decodeRecord(noteId, oldWorking)).note
            if (!cur || JSON.stringify(cur) !== JSON.stringify(expected)) return false
          }
          try {
            await apply(
              [NOTES_STORE, BASE_STORE, SYNC_STORE],
              [[NOTES_STORE, noteId, oldWorking], [BASE_STORE, noteId, oldBase], [SYNC_STORE, noteId, oldSync]],
              [[NOTES_STORE, noteId, bytes], [BASE_STORE, noteId, bytes], [SYNC_STORE, noteId, record]],
            )
          } catch (e) {
            // Another tab wrote the working copy between the check and the transaction.
            if (e instanceof NoteSaveError && e.message === 'record changed while saving') return false
            throw e
          }
          return true
        }),
      )
      if (done) await notify(noteId)
      return done
    },

    async removeNote(noteId, expected) {
      const done = await locked(noteId, () =>
        wrapSave(async () => {
          const [oldWorking, oldBase, oldSync] = await readRaw(noteId)
          if (oldWorking === undefined) return false
          const cur = (await decodeRecord(noteId, oldWorking)).note
          if (!cur || JSON.stringify(cur) !== JSON.stringify(expected)) return false
          try {
            await apply(
              [NOTES_STORE, BASE_STORE, SYNC_STORE],
              [[NOTES_STORE, noteId, oldWorking], [BASE_STORE, noteId, oldBase], [SYNC_STORE, noteId, oldSync]],
              [[NOTES_STORE, noteId, DEL], [BASE_STORE, noteId, DEL], [SYNC_STORE, noteId, DEL]],
            )
          } catch (e) {
            if (e instanceof NoteSaveError && e.message === 'record changed while saving') return false
            throw e
          }
          return true
        }),
      )
      if (done) await notify(noteId)
      return done
    },

    async updateSync(noteId, change, o = {}) {
      const committed = await locked(noteId, () =>
        wrapSave(async () => {
          const [working, oldBase, oldSync] = await readRaw(noteId)
          if (working === undefined) throw new NoteSaveError('the note has no record')
          // No record is "none". One that is there but unreadable is never replaced by
          // an empty record: that would drop the fileId and the base.
          const cur = oldSync === undefined ? emptySync() : syncFromJson(oldSync)
          if (!cur) throw new NoteSaveError(SYNC_UNREADABLE)
          let next = change(cur)
          let id = next.baseHeadRevisionId
          const stored = !!(await decodeRecord(noteId, oldBase)).note
          // The base the old record names is gone and no new base comes: forget it, so
          // the note recovers instead of failing every commit (as readSync does).
          if (!o.base && !stored && id !== null && id === cur.baseHeadRevisionId) {
            next = { ...next, baseHeadRevisionId: null }
            id = null
          }
          if (id !== null && !revisionIdPattern.test(id)) throw new NoteSaveError('baseHeadRevisionId is not a valid id')
          if (id === null && o.base) throw new NoteSaveError('a base needs a baseHeadRevisionId')
          if (o.base && o.base.noteId !== noteId) throw new NoteSaveError('base belongs to another note')
          if (!o.base && id !== null && !stored) throw new NoteSaveError('the base copy is missing')
          const record = syncRecord(next)
          const puts: Put[] = []
          if (o.base) puts.push([BASE_STORE, noteId, await encodeChecked(o.base)])
          else if (id === null && oldBase !== undefined) puts.push([BASE_STORE, noteId, DEL])
          puts.push([SYNC_STORE, noteId, record])
          await apply(
            [BASE_STORE, SYNC_STORE],
            [[BASE_STORE, noteId, oldBase], [SYNC_STORE, noteId, oldSync]],
            puts,
          )
          return next
        }),
      )
      await notify(noteId)
      return committed
    },

    async resetSync(noteId) {
      await locked(noteId, () =>
        wrapSave(async () => {
          const [working, oldBase, oldSync] = await readRaw(noteId)
          if (working === undefined) return // no note: nothing to reset
          const old = syncFromJson(oldSync)
          const next: SyncInfo = {
            ...emptySync(),
            conflicts: old?.conflicts ?? [],
            unsentSidecars: old?.unsentSidecars ?? [],
            extra: old?.extra ?? {},
          }
          const puts: Put[] = []
          if (oldBase !== undefined) puts.push([BASE_STORE, noteId, DEL])
          puts.push([SYNC_STORE, noteId, syncRecord(next)])
          await apply(
            [BASE_STORE, SYNC_STORE],
            [[BASE_STORE, noteId, oldBase], [SYNC_STORE, noteId, oldSync]],
            puts,
          )
        }),
      )
      await notify(noteId)
    },

    readSync(noteId) {
      const none: SyncRead = { info: emptySync(), base: null, hasUnsent: true, state: 'pending' }
      return locked(noteId, async () => {
        try {
          const [workingRaw, baseRaw, syncRaw] = await readRaw(noteId)
          if (workingRaw === undefined && syncRaw === undefined) return { ...none, missing: true } satisfies SyncRead
          const info = syncFromJson(syncRaw) ?? emptySync() // unreadable = absent, nothing deleted
          const id = info.baseHeadRevisionId
          const base = id === null ? null : ((await decodeRecord(noteId, baseRaw)).note ?? null)
          // A working copy that cannot be read (missing, corrupt, newer version,
          // other note) is never "safe": unsent, pending.
          const working = (await decodeRecord(noteId, workingRaw)).note
          const unsent =
            !working ||
            (hasUnsentRule({
              base,
              working,
              pendingVerify: info.pendingVerify,
              unsentSidecars: info.unsentSidecars,
            }) as { hasUnsent?: boolean }).hasUnsent !== false
          return {
            info,
            base,
            hasUnsent: unsent,
            state: !working || (info.state === 'synced' && unsent) ? 'pending' : info.state,
          } satisfies SyncRead
        } catch {
          return none
        }
      }).catch(() => none)
    },

    loadNote(noteId) {
      return locked(noteId, async () => {
        const value = await readBytes(noteId)
        return value === undefined ? null : decodeRecord(noteId, value)
      })
    },

    async listIds() {
      const keys = await withDb((db) => db.getAllKeys(NOTES_STORE))
      return keys.filter((k): k is string => typeof k === 'string')
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

    remote: createRemoteCardStore(ndb),

    close: () => ndb.close(),
  }
  return store
}
