// The upload triggers of spec sync.md "Triggers and polling" for the web: note
// closed, tab hidden, page load / root ready, connection back. Every method
// completes without throwing. Mirrors kkeujeok-client/lib/sync/upload_coordinator.dart,
// with Web Locks in place of the lease file (AD-10):
//   - a note that is open in this tab is uploaded by this tab (its editor holds the
//     note's lock `kkeujeok-note:<id>`), only when the tab is hidden;
//   - a closed note is uploaded by the one tab that holds the note's own lock for
//     the whole upload (an editor elsewhere that has it open keeps it from us, and
//     an editor that opens meanwhile waits for it: it reads the merged result), and
//     the sync-only lock `kkeujeok-sync` per Drive request, not while a backoff sleeps.
import type { DriveError } from '../drive/driveClient'
import type { NoteStore } from '../storage/noteStore'
import type { SyncInfo } from '../storage/syncInfo'
import { PENDING_TRASH, type NoteUploader } from './noteUploader'
import { openNoteIds } from './openNotes'
import type { SyncLog } from './syncLog'
import { transition } from './syncRules'

export const SYNC_LOCK_NAME = 'kkeujeok-sync'
export const noteLockName = (noteId: string) => `kkeujeok-note:${noteId}`

// `backoff` is the class of a note whose 7 network retries ran out.
const RETRY_CLASSES = new Set(['backoff', 'quota', 'reauth', 'fatal'])
// These end the same way again until something else changes, so they are retried
// once per page session, not at every trigger.
// `md5Mismatch`, `noRevisionId`, `localWrite` and `rootMissing` are fatal ones only a manual retry ends.
const RETRY_ONCE = new Set(['verifyExhausted', 'sessionLost', 'mergeFailed', 'md5Mismatch', 'noRevisionId', 'localWrite', 'rootMissing'])

export type CoordinatorDeps = {
  store: Pick<NoteStore, 'listIds' | 'readSync' | 'updateSync'>
  uploader: Pick<NoteUploader, 'upload' | 'resume'> & Partial<Pick<NoteUploader, 'markTrash' | 'trashNote' | 'conflictResolved' | 'markResolved' | 'cleanResolvedSidecars' | 'uploadVerified' | 'reportFailure'>>
  log: Pick<SyncLog, 'append'>
  allowed: () => boolean
  online: () => boolean
  /** Waits until every open editor's save queue is on disk. */
  flushOpen: () => Promise<void>
  /** The notes open and writable in this tab. */
  openIds?: () => string[]
  /** False while the token is known to be expired (a 401): `reauth` notes are not retried by a trigger then. */
  tokenOk?: () => boolean
  /** `navigator.locks`; without it the tab uploads without exclusivity. */
  locks?: LockManager | undefined
}

/**
 * Why a note in `error` is looked at again. `trigger`: an upload trigger; `start`: page load;
 * `manual`: [다시 시도] / [지금 동기화]; `reauth`: a finished sign-in of the same account.
 * Spec sync.md Errors: `quota` is retried only at start and by hand (web); `reauth` after sign-in.
 */
type RetryMode = 'trigger' | 'start' | 'manual' | 'reauth'

export type UploadCoordinator = ReturnType<typeof createUploadCoordinator>

export function createUploadCoordinator(d: CoordinatorDeps) {
  const locks = 'locks' in d ? d.locks : globalThis.navigator?.locks
  const openIds = d.openIds ?? openNoteIds
  let started = false
  const retried = new Set<string>()

  /** Runs `fn` while holding lock `name`. `ifAvailable`: skipped (false) when taken. */
  async function withLock(name: string, ifAvailable: boolean, fn: () => Promise<void>): Promise<boolean> {
    if (!locks) {
      await fn()
      return true
    }
    let ran = false
    await locks.request(name, ifAvailable ? { ifAvailable: true } : {}, async (lock) => {
      if (!lock) return
      ran = true
      await fn()
    })
    return ran
  }

  /** A lock kept until `release` (null when `ifAvailable` found it taken). Without Web Locks: a no-op hold. */
  async function hold(name: string, ifAvailable: boolean): Promise<{ release: () => Promise<void> } | null> {
    if (!locks) return { release: async () => {} }
    let free!: () => void
    const kept = new Promise<void>((r) => (free = r))
    let granted!: (ok: boolean) => void
    const got = new Promise<boolean>((r) => (granted = r))
    const done = locks
      .request(name, ifAvailable ? { ifAvailable: true } : {}, (lock) => {
        granted(lock !== null)
        return lock ? kept : undefined
      })
      .catch(() => granted(false))
    if (!(await got)) return null
    return { release: () => (free(), done.then(() => {})) }
  }

  /** The `kkeujeok-sync` hold of each running upload, by note id. */
  type Hold = { lock: Awaited<ReturnType<typeof hold>> }
  const syncHolds = new Map<string, Hold>()

  /** The uploader's sleep: the note's sync lock is let go while it waits, so another note's upload can go. */
  async function pause(ms: number, noteId?: string): Promise<void> {
    const mine = noteId === undefined ? undefined : syncHolds.get(noteId)
    if (!mine?.lock || !locks) return void (await new Promise((r) => setTimeout(r, ms)))
    await mine.lock.release()
    mine.lock = null
    await new Promise((r) => setTimeout(r, ms))
    mine.lock = await hold(SYNC_LOCK_NAME, false)
    // No lock back, or the upload was finished meanwhile (another tab): this one stops (a crash's state; "Start" repeats it).
    if (!mine.lock) throw new Error('the sync lock could not be taken again')
    if (!(await needsUpload(noteId!))) throw new Error('the upload was finished elsewhere')
  }

  /** From one read: an upload is needed, a resolved sidecar is still to be marked on Drive. */
  async function needs(noteId: string): Promise<{ upload: boolean; mark: boolean }> {
    const s = await d.store.readSync(noteId)
    return {
      upload: s.info.state !== 'error' && (s.hasUnsent || s.info.pendingVerify !== null),
      mark: s.info.conflicts.some((c) => c.resolvedAt != null && c.sidecarMarked !== true),
    }
  }
  const needsUpload = async (noteId: string) => (await needs(noteId)).upload

  async function one(noteId: string, o: { recover?: boolean; openHere?: boolean } = {}): Promise<void> {
    try {
      const trash = (await d.store.readSync(noteId)).info.extra[PENDING_TRASH] === true
      const { upload, mark } = await needs(noteId)
      if (!trash && !upload && !mark) return
      if ((trash || upload) && (!d.allowed() || !d.online())) return // stays pending; the next trigger picks it up
      // A closed note's lock is kept for the whole upload; null: open in another tab, its tab uploads it.
      const note = o.openHere ? { release: async () => {} } : await hold(noteLockName(noteId), true)
      if (!note) return
      try {
        const mine: Hold = { lock: await hold(SYNC_LOCK_NAME, false) }
        if (!mine.lock) return // no sync lock: nothing runs unguarded
        syncHolds.set(noteId, mine)
        try {
          if (trash) {
            await d.uploader.trashNote?.(noteId) // sends what is unsent first
            return
          }
          // Re-check inside the lock: another tab may have uploaded it while this one waited.
          if (await needsUpload(noteId)) await (o.recover ? d.uploader.resume(noteId) : d.uploader.upload(noteId))
          // With nothing to send the resolve is already on Drive: the sidecar is marked under the same guards.
          if (mark) await d.uploader.markResolved?.(noteId)
        } finally {
          syncHolds.delete(noteId)
          await mine.lock?.release()
        }
      } finally {
        await note.release()
      }
    } catch {
      // Whatever went wrong is in sync.json and the log, or it was a crash; "Start" repeats the step.
    }
  }

  async function retry(noteId: string, mode: RetryMode = 'trigger'): Promise<void> {
    try {
      const s = await d.store.readSync(noteId)
      if (s.info.state !== 'error') return
      const err = s.info.lastError
      if (!RETRY_CLASSES.has(String(err?.class))) return // deleted, unreadable
      if (mode === 'reauth' && err?.class !== 'reauth') return
      if (err?.class === 'quota' && mode !== 'start' && mode !== 'manual') return // the person or the next load decides
      if (err?.class === 'reauth' && (mode === 'trigger' || mode === 'start') && d.tokenOk?.() === false) return // it would fail again
      if (mode !== 'manual' && mode !== 'reauth' && RETRY_ONCE.has(String(err?.reason))) {
        if (retried.has(noteId)) return
        retried.add(noteId)
      }
      let moved = false
      await d.store.updateSync(noteId, (cur) => {
        const t = cur.state === 'error' ? transition('error', 'retry') : null
        moved = t !== null
        return t === null ? cur : { ...cur, state: t }
      })
      if (moved) await d.log.append('stateChange', { noteId, from: 'error', to: 'pending' })
    } catch {
      // the next trigger tries again
    }
  }

  async function all(o: { includeOpen: boolean; recover?: boolean; mode?: RetryMode }): Promise<void> {
    try {
      const open = new Set(openIds())
      const ids = (await d.store.listIds()).filter((id) => o.includeOpen || !open.has(id))
      for (const id of ids) await retry(id, o.mode) // once per trigger, so a failure is not retried at once
      // Interrupted uploads are finished before anything new goes.
      if (o.recover) for (const id of ids) await one(id, { recover: true, openHere: open.has(id) })
      for (const id of ids) await one(id, { openHere: open.has(id) })
    } catch {
      // listing failed; the next trigger tries again
    }
  }

  const api = {
    /** The uploader's `sleep`: waits without holding `kkeujeok-sync`. */
    pause,

    /** The editor is gone (its last save and lock are released): the note is uploaded when it has unsent changes. */
    noteClosed: (noteId: string) => one(noteId),

    /** Story 7.8: the note is hidden at once; unsent changes go up, then the Drive file is trashed (offline: when connected). */
    async deleteNote(noteId: string): Promise<void> {
      try {
        if (await d.uploader.markTrash?.(noteId)) await one(noteId, { openHere: openIds().includes(noteId) })
      } catch {
        // the mark stays; the next trigger repeats the step
      }
    },

    /** The tab became hidden: open editors are flushed, then every unsent note, the open ones too, goes. */
    async hidden(): Promise<void> {
      try {
        await d.flushOpen()
      } catch {
        // an unsaved snapshot stays in the editor's queue
      }
      await all({ includeOpen: true })
    },

    /** Page load: interrupted uploads are finished first, then unsent notes go (open ones stay). */
    async start(): Promise<void> {
      started = true
      await all({ includeOpen: false, recover: true, mode: 'start' })
      // Resolved sidecars older than 30 days go to the Drive trash (best effort).
      void (async () => {
        const ids = await d.store.listIds()
        await withLock(SYNC_LOCK_NAME, false, async () => void (await d.uploader.cleanResolvedSidecars?.(ids)))
      })().catch(() => {
        // the next start tries again
      })
    },

    /**
     * A conflict was settled in the editor (Story 3.22): its `sync.json` entry and the state follow in one write.
     * Rejects when that could not be written. The caller then runs `syncNow`.
     */
    async conflictResolved(noteId: string, conflict: Record<string, unknown>): Promise<SyncInfo> {
      if (!d.uploader.conflictResolved) throw new Error('conflictResolved is not available')
      return d.uploader.conflictResolved(noteId, conflict as Parameters<NonNullable<typeof d.uploader.conflictResolved>>[1])
    },

    /**
     * Restore step 2 (Story 3.25): the open note's saves reach the disk (`flush` false or throwing = nothing may be
     * pinned), then the note is uploaded and verified. Answers the revision id that holds the state, or null when that
     * failed. Never throws.
     */
    async uploadForRestore(noteId: string, flush?: () => Promise<boolean>): Promise<string | null> {
      try {
        if (!d.uploader.uploadVerified) return null
        if (flush && !(await flush())) return null
        await retry(noteId, 'manual') // a note still in `error` ends below
        if (!d.allowed() || !d.online()) return null
        let head: string | null = null
        const ran = await withLock(SYNC_LOCK_NAME, false, async () => void (head = await d.uploader.uploadVerified!(noteId)))
        return ran ? head : null
      } catch {
        return null
      }
    },

    /** A Drive call of a restore (the pin) failed: the note takes the sync error (Story 3.25). Never throws. */
    async reportFailure(noteId: string, e: DriveError): Promise<void> {
      try {
        await d.uploader.reportFailure?.(noteId, e)
      } catch {
        // nothing more to do
      }
    },

    /** [지금 동기화] / [다시 시도] of one note: its open editor is flushed, an error is retried, then it uploads. */
    async syncNow(noteId: string): Promise<void> {
      try {
        const here = openIds().includes(noteId)
        if (here) await d.flushOpen()
        await retry(noteId, 'manual')
        await one(noteId, { openHere: here })
      } catch {
        // the state and the log say what happened
      }
    },

    /** A sign-in of the same account finished: notes stopped by an expired token go again. */
    async resume(): Promise<void> {
      try {
        for (const id of await d.store.listIds()) await retry(id, 'reauth')
      } catch {
        // the next trigger tries again
      }
      await all({ includeOpen: false, recover: true })
    },

    /** The connection is back, or the gate opened again: what waited goes, except the open note. */
    unsent: () => all({ includeOpen: false, recover: true }),

    /** The upload gate opened (root folder ready): the first time this is `start`, later it uploads what waited. */
    rootReady: (): Promise<void> => (started ? api.unsent() : api.start()),
  }
  return api
}
