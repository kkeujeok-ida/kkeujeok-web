// Finds, creates and repairs the `Kkeujeok` root folder (spec drive-layout
// "Idempotent creation", AD-15). Items are found only by `appProperties.kkeujeokId`.
// Mirrors kkeujeok-client/lib/drive/root_folder.dart. Never rejects: every
// failure is a RootResult of status `failed`.
import type { NoteStore } from '../storage/noteStore'
import type { SyncDevice, SyncDeviceStore } from '../storage/syncDevice'
import type { SyncLog } from '../sync/syncLog'
import { classifyDriveError } from '../sync/errorClass'
import { DriveError, type DriveClient, type DriveFile, childrenQuery, kkeujeokIdQuery } from './driveClient'
import { driveDuplicatesRule } from './duplicates'

export const ROOT_KKEUJEOK_ID = 'root'
export const ROOT_FOLDER_NAME = 'Kkeujeok'
const ROOT_LOCK_NAME = 'kkeujeok-root'
/** A tab that holds the root lock longer than this is treated as hung. */
const ROOT_LOCK_WAIT_MS = 30_000
const FOLDER_MIME = 'application/vnd.google-apps.folder'

export type RootStatus =
  /** Not asked yet, or no Drive call is allowed (no account, other account). */
  | 'idle'
  | 'preparing'
  | 'ready'
  /** The root was trashed or deleted: the person decides. */
  | 'missing'
  /** A call failed; `errorClass` says which class. */
  | 'failed'

export type RootResult = { status: RootStatus; folderId?: string; errorClass?: string }

/** What one run needs from IndexedDB; opened per run and closed after it. */
export type RootStorage = {
  device: SyncDeviceStore
  notes: Pick<NoteStore, 'listNotes' | 'resetSync'>
  close(): void
}

export type RootFolderService = ReturnType<typeof createRootFolderService>

export function createRootFolderService(deps: {
  client: DriveClient
  open: () => RootStorage
  log: Pick<SyncLog, 'append'>
  account: () => { sub: string; email: string } | null
  /** Pages followed per listing; a listing that never ends is cut here. */
  maxPages?: number
  /** `navigator.locks`; without it `prepare` runs without exclusivity (two tabs may race). */
  locks?: LockManager | undefined
  /** Wait after creating the root, before the re-list; lets Drive's listing catch up. */
  settleMs?: number
}) {
  const { client, open, log, account } = deps
  const maxPages = deps.maxPages ?? 10
  const locks = 'locks' in deps ? deps.locks : globalThis.navigator?.locks
  const settleMs = deps.settleMs ?? 0
  let flight: Promise<RootResult> | null = null

  /** Makes sure the root exists and is cached. Concurrent callers share one run. */
  const ensureRoot = (): Promise<RootResult> => flight ?? start(false)
  /** The foreground check: a root that only moved is found silently, a trashed one is `missing`. */
  const checkRoot = ensureRoot
  /** [새로 만들기]: notes forget their Drive file first, then a new root is found or created. */
  const recreate = (): Promise<RootResult> => start(true)

  async function start(recreating: boolean): Promise<RootResult> {
    // No await before the registration, so a caller that finds no flight registers its own at once.
    while (flight) await flight
    const run: Promise<RootResult> = prepare(recreating).finally(() => {
      if (flight === run) flight = null
    })
    flight = run
    return run
  }

  async function fail(cls: string, status?: number, reason?: string): Promise<RootResult> {
    await log.append('error', {
      class: cls,
      ...(status !== undefined && status >= 100 && status <= 599 && { status }),
      ...(reason !== undefined && { reason }),
    })
    return { status: 'failed', errorClass: cls }
  }

  /** Every page up to maxPages; `truncated` when more was left. */
  async function all(q: string): Promise<{ files: DriveFile[]; truncated: boolean }> {
    const files: DriveFile[] = []
    let token: string | undefined
    for (let page = 0; page < maxPages; page++) {
      const p = await client.list(q, { pageToken: token })
      files.push(...p.files)
      token = p.nextPageToken
      if (!token) return { files, truncated: false }
    }
    return { files, truncated: true }
  }

  /** The cached root when alive; null when gone or trashed. */
  async function getCached(id: string): Promise<DriveFile | null> {
    try {
      const f = await client.get(id, { fields: 'id,trashed' })
      return f.trashed ? null : f
    } catch (e) {
      if (e instanceof DriveError && e.kind === 'http' && e.status === 404) return null
      throw e
    }
  }

  /**
   * The folder `drive.duplicates` keeps; the others get their children moved and are
   * trashed last. A failure leaves the duplicate for the next run.
   */
  async function keepOne(found: DriveFile[], gone: () => boolean): Promise<string | null> {
    const r = driveDuplicatesRule({
      kkeujeokId: ROOT_KKEUJEOK_ID,
      items: found.map((f) => ({ id: f.id, createdTime: f.createdTime ?? '9999-12-31T23:59:59.999Z' })),
    })
    if ('error' in r || r.keep === null) throw new Error('no root to keep') // found is never empty here
    let cleaned = 0
    for (const dup of r.merge) {
      try {
        const kids = await all(childrenQuery(dup))
        for (const c of kids.files) {
          if (gone()) return null
          await client.update(c.id, { addParents: r.keep, removeParents: dup })
        }
        if (kids.truncated) {
          await fail('fatal', undefined, 'listTruncated')
          break // children may be left in it: never trash it
        }
        if (gone()) return null
        await client.update(dup, { trashed: true }) // last
        cleaned++
      } catch (e) {
        if (!(e instanceof DriveError)) throw e
        await fail(classifyDriveError(e), e.status, e.reason)
        break
      }
    }
    if (cleaned > 0) await log.append('duplicatesCleaned', { count: cleaned })
    return r.keep
  }

  const otherIntents = (d: SyncDevice) => d.createIntents.filter((i) => i.kkeujeokId !== ROOT_KKEUJEOK_ID)

  /**
   * Every note forgets its Drive file and base and is pending again, with the same
   * noteId. Only the sync record is written, so edits made while this runs stay.
   */
  async function resetNotes(notes: RootStorage['notes']) {
    for (const row of await notes.listNotes()) await notes.resetSync(row.noteId)
  }

  /** The whole run under one lock, so two tabs never create the root at once. */
  async function prepare(recreating: boolean): Promise<RootResult> {
    if (!locks) return prepareLocked(recreating)
    let result: RootResult | undefined
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), ROOT_LOCK_WAIT_MS)
    try {
      await locks.request(ROOT_LOCK_NAME, { signal: ctl.signal }, async () => {
        clearTimeout(timer) // granted: the limit only covers the wait
        result = await prepareLocked(recreating)
      })
    } catch (e) {
      if (ctl.signal.aborted) return fail('fatal', undefined, 'lockTimeout')
      await log.append('error', { class: 'fatal', reason: e instanceof Error ? e.message : String(e) }).catch(() => {})
      return fail('fatal', undefined, 'lock')
    } finally {
      clearTimeout(timer)
    }
    return result ?? fail('fatal', undefined, 'lock')
  }

  async function prepareLocked(recreating: boolean): Promise<RootResult> {
    let storage: RootStorage | undefined
    try {
      const a = account()
      if (!a) return { status: 'idle' }
      // The account may sign out or change during any await below.
      const gone = () => account()?.sub !== a.sub
      storage = open()
      const { device, notes } = storage

      let dev = await device.read()
      if (dev.sub !== null && dev.sub !== a.sub) return { status: 'idle' } // Story 3.8 handles it
      if (dev.sub === null) {
        if (!(await device.adoptAccount(a.sub, a.email))) {
          const now = await device.read()
          if (now.sub !== null && now.sub !== a.sub) return { status: 'idle' } // another tab tagged it
          return await fail('fatal', undefined, 'deviceUnreadable')
        }
        dev = await device.read()
      }
      const cached = dev.rootFolderId
      if (gone()) return { status: 'idle' }

      if (cached === null || recreating) {
        // A recreate drops every other pending creation: they pointed into the root that is gone.
        await device.write({
          ...dev,
          createIntents: [
            ...otherIntents(dev), // a recreate clears them with the final write, once the new root exists
            { kkeujeokId: ROOT_KKEUJEOK_ID, kind: 'root', parentId: 'root' },
          ],
        })
      }

      let { files: found, truncated } = await all(kkeujeokIdQuery(ROOT_KKEUJEOK_ID))
      let id: string | undefined
      let createdId: string | undefined
      if (found.length === 0) {
        if (cached !== null && !recreating) {
          const f = await getCached(cached)
          if (!f) return { status: 'missing' }
          id = f.id // the listing lagged behind
        } else {
          if (gone()) return { status: 'idle' } // no write to Drive for a signed-out account
          const created = await client.create({
            name: ROOT_FOLDER_NAME,
            mimeType: FOLDER_MIME,
            parents: ['root'],
            appProperties: { kkeujeokId: ROOT_KKEUJEOK_ID },
          })
          if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs))
          ;({ files: found, truncated } = await all(kkeujeokIdQuery(ROOT_KKEUJEOK_ID)))
          createdId = created.id
          if (gone()) return { status: 'idle' }
          if (found.length === 0) id = created.id // the listing lags
        }
      }
      // Notes keep their file ids when the old root is among the folders being merged.
      const merged = cached !== null && found.some((f) => f.id === cached)
      if (id === undefined && truncated) {
        // A partial listing must not pick the "oldest" root.
        if (merged) {
          await log.append('error', { class: 'fatal', reason: 'listTruncated' }).catch(() => {})
          id = cached
        } else if (createdId !== undefined) {
          id = createdId // never orphan the root this run made
        } else {
          return await fail('fatal', undefined, 'listTruncated')
        }
      }
      if (id === undefined) {
        const kept = await keepOne(found, gone)
        if (kept === null) return { status: 'idle' }
        id = kept
      }

      // Another device made a new root: this device's file ids are stale.
      const changed = cached !== null && id !== cached

      if (gone()) return { status: 'idle' }
      const latest = await device.read()
      if (latest.sub !== a.sub) return { status: 'idle' }
      if (changed && (recreating || !merged)) await resetNotes(notes)
      await device.write({
        ...latest,
        rootFolderId: id,
        createIntents: recreating ? [] : otherIntents(latest),
        conflictsFolderId: recreating || changed ? null : latest.conflictsFolderId,
      })
      return { status: 'ready', folderId: id }
    } catch (e) {
      if (e instanceof DriveError) return fail(classifyDriveError(e), e.status, e.reason)
      return fail('fatal', undefined, 'localWrite')
    } finally {
      storage?.close()
    }
  }

  return { ensureRoot, checkRoot, recreate }
}
