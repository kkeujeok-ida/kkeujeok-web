// The upload triggers of spec sync.md "Triggers and polling" for the web: note
// closed, tab hidden, page load / root ready, connection back. Every method
// completes without throwing. Mirrors kkeujeok-client/lib/sync/upload_coordinator.dart,
// with Web Locks in place of the lease file (AD-10):
//   - a note that is open in this tab is uploaded by this tab (its editor holds the
//     note's lock `kkeujeok-note:<id>`), only when the tab is hidden;
//   - a closed note is uploaded by the one tab that holds the sync-only lock
//     `kkeujeok-sync`, and only when no tab holds the note's own lock (an editor
//     elsewhere has it open).
import type { NoteStore } from '../storage/noteStore'
import type { NoteUploader } from './noteUploader'
import { openNoteIds } from './openNotes'
import type { SyncLog } from './syncLog'
import { transition } from './syncRules'

export const SYNC_LOCK_NAME = 'kkeujeok-sync'
export const noteLockName = (noteId: string) => `kkeujeok-note:${noteId}`

// `backoff` is the class of a note whose 7 network retries ran out.
const RETRY_CLASSES = new Set(['backoff', 'quota', 'reauth', 'fatal'])
// These end the same way again until something else changes, so they are retried
// once per page session, not at every trigger.
const RETRY_ONCE = new Set(['conflictPending', 'verifyExhausted', 'sessionLost', 'mergeFailed'])

export type CoordinatorDeps = {
  store: Pick<NoteStore, 'listIds' | 'readSync' | 'updateSync'>
  uploader: Pick<NoteUploader, 'upload' | 'resume'>
  log: Pick<SyncLog, 'append'>
  allowed: () => boolean
  online: () => boolean
  /** Waits until every open editor's save queue is on disk. */
  flushOpen: () => Promise<void>
  /** The notes open and writable in this tab. */
  openIds?: () => string[]
  /** `navigator.locks`; without it the tab uploads without exclusivity. */
  locks?: LockManager | undefined
}

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

  /** True when no tab has the note open (nobody holds its lock). */
  async function closedEverywhere(noteId: string): Promise<boolean> {
    return !locks || (await withLock(noteLockName(noteId), true, async () => {}))
  }

  async function needsUpload(noteId: string): Promise<boolean> {
    const s = await d.store.readSync(noteId)
    return s.info.state !== 'error' && (s.hasUnsent || s.info.pendingVerify !== null)
  }

  async function one(noteId: string, o: { recover?: boolean; openHere?: boolean } = {}): Promise<void> {
    try {
      if (!(await needsUpload(noteId))) return
      if (!d.allowed() || !d.online()) return // stays pending; the next trigger picks it up
      if (!o.openHere && !(await closedEverywhere(noteId))) return // open in another tab: its tab uploads it
      await withLock(SYNC_LOCK_NAME, false, async () => {
        // Re-check inside the lock: another tab may have uploaded it while this one waited.
        if (!(await needsUpload(noteId))) return
        await (o.recover ? d.uploader.resume(noteId) : d.uploader.upload(noteId))
      })
    } catch {
      // Whatever went wrong is in sync.json and the log, or it was a crash; "Start" repeats the step.
    }
  }

  async function retry(noteId: string): Promise<void> {
    try {
      const s = await d.store.readSync(noteId)
      if (s.info.state !== 'error') return
      const err = s.info.lastError
      if (!RETRY_CLASSES.has(String(err?.class))) return // deleted, unreadable
      if (RETRY_ONCE.has(String(err?.reason))) {
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

  async function all(o: { includeOpen: boolean; recover?: boolean }): Promise<void> {
    try {
      const open = new Set(openIds())
      const ids = (await d.store.listIds()).filter((id) => o.includeOpen || !open.has(id))
      for (const id of ids) await retry(id) // once per trigger, so a failure is not retried at once
      // Interrupted uploads are finished before anything new goes.
      if (o.recover) for (const id of ids) await one(id, { recover: true, openHere: open.has(id) })
      for (const id of ids) await one(id, { openHere: open.has(id) })
    } catch {
      // listing failed; the next trigger tries again
    }
  }

  const api = {
    /** The editor is gone (its last save and lock are released): the note is uploaded when it has unsent changes. */
    noteClosed: (noteId: string) => one(noteId),

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
      await all({ includeOpen: false, recover: true })
    },

    /** The connection is back, or the gate opened again: what waited goes, except the open note. */
    unsent: () => all({ includeOpen: false, recover: true }),

    /** The upload gate opened (root folder ready): the first time this is `start`, later it uploads what waited. */
    rootReady: (): Promise<void> => (started ? api.unsent() : api.start()),
  }
  return api
}
