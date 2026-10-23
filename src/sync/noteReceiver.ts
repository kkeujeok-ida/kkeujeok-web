// Receives remote changes (spec sync.md "Triggers and polling", "Start", page-token
// rejection). Mirrors nothing yet: the Android twin (Story 3.13) is built from the
// same spec. Everything that touches the outside is injected.
//
// A note that is not here yet becomes a card from the list summary (no download); a
// note that is here and whose head moved is replaced (nothing unsent) or merged
// (unsent changes / open in the editor). A Drive or local-write failure never
// escapes `check`: it is a log entry and, for a permanent failure, the note's state.
import {
  CHANGE_FILE_FIELDS,
  DriveError,
  type DriveChange,
  type DriveClient,
  type DriveFile,
} from '../drive/driveClient'
import { driveRemoteTitleRule, listSummaryRule } from '../drive/noteSummary'
import { applyMergeToSession } from '../ops/sessionHistories'
import { decodeKkj } from '../model/kkjCodec'
import type { Note } from '../model/note'
import { NoteSaveError } from '../storage/noteDb'
import type { NoteStore } from '../storage/noteStore'
import type { RemoteCard, RemoteCardStore } from '../storage/remoteCards'
import { type SyncDevice, type SyncDeviceStore } from '../storage/syncDevice'
import { type SyncInfo, emptySync } from '../storage/syncInfo'
import { conflictLogFields } from './conflicts'
import { classifyDriveError } from './errorClass'
import type { MergeIo } from './mergeIo'
import { chained } from './noteChain'
import { getOpenNote, openNoteIds } from './openNotes'
import type { SyncLog } from './syncLog'
import { hasUnsentRule } from './hasUnsent'
import { backoffRule, transition } from './syncRules'
import { noteLockName } from './uploadCoordinator'

export const KKJ_MIME = 'application/vnd.kkeujeok.kkj'
/** `files.list` of the rescan: every live note file (folders hold no state of their own yet). */
export const NOTE_FILES_QUERY = `trashed=false and mimeType='${KKJ_MIME}'`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What the UI shows: `receiving` = notes whose card carries the ↓ badge. */
export type ReceiveState = {
  version: number
  receiving: ReadonlySet<string>
  scanning: boolean
  /** Counts the notes restored because they had unsent changes (the snackbar, Story 3.18). */
  revived: number
}
export type Channel = { post(m: unknown): void; subscribe(fn: (m: unknown) => void): () => void }

export type ReceiverDeps = {
  store: Pick<NoteStore, 'loadNote' | 'readSync' | 'updateSync' | 'commitMerge' | 'commitReceive' | 'listIds' | 'removeNote' | 'resetSync'>
  drive: DriveClient
  device: SyncDeviceStore
  remote: RemoteCardStore
  log: Pick<SyncLog, 'append'>
  merge: MergeIo
  account: () => { sub: string; email: string } | null
  /** Root folder ready. */
  allowed: () => boolean
  online: () => boolean
  sleep: (ms: number) => Promise<void>
  jitter: () => number
  /** Notes open and writable in this tab. */
  openIds?: () => string[]
  locks?: LockManager | undefined
  channel?: Channel | null
  /** A restored note that is not open here is uploaded now (the coordinator's `noteClosed`). */
  uploadNote?: (noteId: string) => Promise<void>
}

class Gone extends Error {}
class Fail extends Error {
  constructor(
    readonly cls: string,
    readonly status?: number,
    readonly reason?: string,
    /** The remote head that could not be read (`lastError.head`). */
    readonly head?: string,
  ) {
    super(`Fail(${cls}, ${reason ?? ''})`)
  }
}
type Guard = { sub: string; email: string; root: string | null; ensure(): void }
/** `skipped`: left for a later receive (kept in `retry`); `exhausted`: the same, after three rejected commits (the token is not saved). */
type Result = 'ok' | 'later' | 'skipped' | 'exhausted'

const isRejected = (e: DriveError) => e.kind === 'http' && (e.status === 400 || e.status === 404 || e.status === 410)
const TRANSIENT = new Set(['backoff', 'reauth', 'quota'])
const MAX_PAGES = 1000
type Kind = 'trashed' | 'removed'
const unresolvedOf = (i: SyncInfo) => i.conflicts.filter((c) => c.resolvedAt == null).length
/** The record says the Drive file of this note is gone. */
const goneKind = (i: SyncInfo): Kind | null => (i.lastError?.class === 'deleted' ? (i.lastError.reason === 'trashed' ? 'trashed' : 'removed') : null)
/** A note is never discarded while it holds anything Drive does not have. */
const keepsLocal = (hasUnsent: boolean, i: SyncInfo) => hasUnsent || i.state === 'conflict' || unresolvedOf(i) > 0
/** An `unreadable` note whose remote head is another one than the one that failed gets another try. */
const recoverable = (i: SyncInfo, head: string) =>
  i.state === 'error' && i.lastError?.class === 'unreadable' && typeof i.lastError.head === 'string' && i.lastError.head !== head
const nameOf = (f: DriveFile | null) => (f?.name ?? '').replace(/\.kkj$/i, '')

export type NoteReceiver = ReturnType<typeof createNoteReceiver>

export function createNoteReceiver(d: ReceiverDeps) {
  const { store, drive, log } = d
  const openIds = d.openIds ?? openNoteIds
  const locks = 'locks' in d ? d.locks : globalThis.navigator?.locks

  // ---- state for the UI --------------------------------------------------
  let state: ReceiveState = { version: 0, receiving: new Set(), scanning: false, revived: 0 }
  const listeners = new Set<() => void>()
  const set = (p: Partial<ReceiveState>) => {
    state = { ...state, ...p }
    listeners.forEach((fn) => fn())
  }
  const mark = (ids: string[]) => {
    if (ids.some((i) => !state.receiving.has(i))) set({ receiving: new Set([...state.receiving, ...ids]) })
  }
  const unmark = (ids: string[]) => {
    if (ids.some((i) => state.receiving.has(i))) set({ receiving: new Set([...state.receiving].filter((i) => !ids.includes(i))) })
  }
  /** The notes or cards changed: lists reload. `post` tells the other tabs. */
  const bump = (post = true) => {
    set({ version: state.version + 1 })
    if (post) d.channel?.post({ t: 'changed' })
  }
  /** Notes whose Drive file a call found missing; `settleGone` decides what happens to them. */
  const goneNotes = new Set<string>()
  /** Changes known and not yet received, for `beforeOpen`. */
  const pending = new Map<string, { fileId: string; head: string }>()

  /** Notes this tab skipped or gave up on: received again by the next check and by `beforeOpen`. */
  const retry = new Map<string, { fileId: string; head: string }>()
  const logged = new Set<string>()
  async function skip(noteId: string, fileId: string, head: string, reason: string, r: Result = 'skipped'): Promise<Result> {
    retry.set(noteId, { fileId, head })
    const key = `${noteId}:${head}:${reason}`
    if (!logged.has(key)) {
      logged.add(key)
      await log.append('error', { class: 'fatal', noteId, reason })
    }
    return r
  }
  function received(noteId: string) {
    retry.delete(noteId)
    for (const k of [...logged]) if (k.startsWith(`${noteId}:`)) logged.delete(k)
  }

  // ---- helpers -----------------------------------------------------------
  function guard(): Guard | null {
    const a = d.account()
    if (!a) return null
    // The account may sign out or change during any await.
    return {
      sub: a.sub,
      email: a.email,
      root: null,
      ensure() {
        if (d.account()?.sub !== a.sub) throw new Gone()
      },
    }
  }
  const usable = () => d.allowed() && d.online()

  async function logError(noteId: string | undefined, f: Fail) {
    await log.append('error', {
      class: f.cls,
      ...(noteId !== undefined && { noteId }),
      ...(f.status !== undefined && { status: f.status }),
      ...(f.reason !== undefined && { reason: f.reason }),
    })
  }

  /** One Drive call with the retry rules of sync.errorClass and sync.backoff. */
  async function call<T>(g: Guard, noteId: string | undefined, fn: () => Promise<T>, pass?: (e: DriveError) => boolean): Promise<T> {
    let attempt = 0
    for (;;) {
      try {
        return await fn()
      } catch (e) {
        if (!(e instanceof DriveError)) throw e
        if (pass?.(e)) throw e
        const cls = classifyDriveError(e)
        const reason = e.kind === 'parse' ? 'parse' : e.reason
        if (cls !== 'backoff') throw new Fail(cls, e.status, reason)
        attempt++
        const plan = backoffRule({ attempt, jitter: d.jitter() })
        if (!('retry' in plan) || plan.retry !== true) throw new Fail(cls, e.status, reason)
        await log.append('backoff', { class: cls, attempt, delayMs: plan.delayMs, ...(noteId !== undefined && { noteId }) })
        await d.sleep(plan.delayMs)
        g.ensure()
      }
    }
  }

  /** One `sync.json` write: `edit`, then `event` moves the state. Logs the state change. */
  async function move(
    noteId: string,
    event: string,
    o: { edit?: (c: SyncInfo) => SyncInfo; unsent?: boolean; base?: Note } = {},
  ): Promise<SyncInfo> {
    let from = ''
    let to = ''
    const done = await store.updateSync(
      noteId,
      (cur) => {
        let next = (o.edit ?? ((c: SyncInfo) => c))(cur)
        from = to = cur.state
        const unresolved = next.conflicts.filter((c) => c.resolvedAt == null).length
        const t = transition(cur.state, event, { unresolved, unsent: o.unsent ?? false })
        if (t) {
          to = t
          next = { ...next, state: t }
        }
        return next
      },
      o.base ? { base: o.base } : undefined,
    )
    if (from !== to) await log.append('stateChange', { noteId, from, to })
    return done
  }

  /** The note ends the receive: `verified` for syncing/conflict, `edit` for unsent changes on a synced one, `upload`+`verified` for a pending one with nothing unsent. */
  async function settle(noteId: string) {
    const s = await store.readSync(noteId)
    const st = s.info.state
    if (st === 'syncing' || st === 'conflict') await move(noteId, 'verified', { unsent: s.hasUnsent })
    else if (st === 'synced' && s.hasUnsent) await move(noteId, 'edit')
    else if (st === 'pending' && !s.hasUnsent) {
      await move(noteId, 'upload')
      await move(noteId, 'verified', { unsent: false })
    }
  }

  /** `conflictFound`: a pending note was about to be saved, so it takes `upload` first. One log entry per sidecar. */
  async function conflictFound(noteId: string, revs: string[]): Promise<void> {
    const st = (await store.readSync(noteId)).info.state
    if (st === 'pending') await move(noteId, 'upload')
    await move(noteId, 'conflictFound')
    for (const rev of revs) await log.append('conflictFound', conflictLogFields(noteId, rev))
  }

  /** The states a note passes from `state` when its receive ends with nothing unsent. */
  function hopsFrom(state: string, unresolved: number): string[] {
    if (state === 'syncing' || state === 'conflict') return [transition(state, 'verified', { unresolved, unsent: false }) ?? state]
    if (state === 'pending') {
      const s1 = transition('pending', 'upload') ?? 'pending'
      return [s1, transition(s1, 'verified', { unresolved, unsent: false }) ?? s1]
    }
    return []
  }

  async function withNoteLock(noteId: string, run: () => Promise<Result>, taken: () => Result | Promise<Result>): Promise<Result> {
    if (!locks) return run()
    let out: Result = 'ok'
    await locks.request(noteLockName(noteId), { ifAvailable: true }, async (lock) => {
      out = lock ? await run() : await taken()
    })
    return out
  }

  async function downloadNote(g: Guard, noteId: string, fileId: string, head: string): Promise<Note> {
    let bytes: Uint8Array
    try {
      bytes = await call(g, noteId, () => drive.downloadRevision(fileId, head))
    } catch (e) {
      if (!(e instanceof Fail && e.cls === 'deleted')) throw e
      // A 404 of the revision is not proof that the file is gone: ask for the file itself (its 404 is `deleted`).
      const f = await call(g, noteId, () => drive.get(fileId, { fields: 'trashed' }))
      if (f.trashed) throw e
      throw new Fail('backoff', e.status, 'revisionNotFound')
    }
    g.ensure()
    await log.append('revisionDownloaded', { noteId, revisionId: head })
    const r = await decodeKkj(bytes)
    if (r.result === 'unsupportedVersion') throw new Fail('unreadable', undefined, 'unsupportedVersion', head)
    if (!r.note || r.note.noteId !== noteId) throw new Fail('unreadable', undefined, 'parse', head)
    return r.note
  }

  /** A permanent failure of a note that is here: it ends `error`, its device copy stays. */
  async function noteFailed(noteId: string, f: Fail): Promise<Result> {
    await logError(noteId, f)
    if (TRANSIENT.has(f.cls)) return 'later'
    if (f.cls === 'deleted') goneNotes.add(noteId) // its file is gone: settled by `settleGone` once the chain is free
    try {
      await move(noteId, 'failed', {
        edit: (c) => ({
          ...c,
          lastError: {
            class: f.cls,
            ...(f.status !== undefined && { status: f.status }),
            ...(f.reason !== undefined && { reason: f.reason }),
            ...(f.cls === 'unreadable' && f.head !== undefined && { head: f.head }),
          },
        }),
      })
    } catch (e) {
      if (!(e instanceof NoteSaveError)) throw e // an unreadable sync.json stays as it is
    }
    return 'ok'
  }

  // ---- one note that is here ---------------------------------------------
  function receiveNote(g: Guard, noteId: string, fileId: string, head: string): Promise<Result> {
    return chained(noteId, async () => {
      mark([noteId])
      try {
        for (let tries = 0; tries < 3; tries++) {
          g.ensure()
          let s = await store.readSync(noteId)
          const loaded = await store.loadNote(noteId)
          const work = loaded?.result === 'ok' && loaded.writable ? loaded.note : undefined
          // The file is live again (restored from the trash), or a broken remote file has another head now: look again.
          let relinked = false
          if (work && s.info.pendingVerify === null && s.info.fileId === fileId && (goneKind(s.info) !== null || recoverable(s.info, head))) {
            await move(noteId, 'retry', { edit: (c) => ({ ...c, lastError: null }) })
            s = await store.readSync(noteId)
            relinked = true
          }
          const info = s.info
          // Not ours to do: an unreadable working copy is never overwritten; the upload owns an unfinished one.
          if (!work) {
            received(noteId)
            return 'ok'
          }
          if (info.fileId !== fileId) return skip(noteId, fileId, head, 'fileIdMismatch')
          if (head === info.baseHeadRevisionId) {
            if (relinked) {
              await settle(noteId) // the same file is back: nothing to receive, the note is whole again
              bump()
            }
            received(noteId)
            return 'ok'
          }
          if (info.state === 'error') return skip(noteId, fileId, head, 'receiveSkippedError')
          if (info.pendingVerify !== null) {
            received(noteId)
            return 'ok'
          }
          // `remoteChange` before the download: a pending note stays pending (sync.stateMachine).
          let moved = info
          if (s.state === 'pending') {
            if (info.state !== 'pending') moved = await move(noteId, 'edit') // synced, but with unsent changes
          } else if (info.state !== 'syncing') moved = await move(noteId, 'remoteChange')
          const remote = await downloadNote(g, noteId, fileId, head)
          g.ensure()
          // Decided on `work` and the base read with `info`, not on `s.hasUnsent` (another read); the store
          // checks all of it again under its lock. Without Web Locks an editor may be about to open: merge.
          const unsent =
            (hasUnsentRule({ base: s.base, working: work, pendingVerify: info.pendingVerify, unsentSidecars: info.unsentSidecars }) as { hasUnsent?: boolean })
              .hasUnsent !== false
          if (locks && !unsent && !openIds().includes(noteId)) {
            const hops = hopsFrom(moved.state, moved.conflicts.filter((c) => c.resolvedAt == null).length)
            const next: SyncInfo = { ...moved, fileId, baseHeadRevisionId: head, lastError: null, state: (hops.at(-1) ?? moved.state) as SyncInfo['state'] }
            if (!(await store.commitReceive(noteId, work, remote, next, info))) continue // it changed meanwhile: look again
            await log.append('baseAdvanced', { noteId, revisionId: head })
            let prev: string = moved.state
            for (const h of hops) {
              if (h !== prev) await log.append('stateChange', { noteId, from: prev, to: h })
              prev = h
            }
          } else {
            const r = await d.merge.merge({ noteId, base: s.base, remote })
            if (r.result === 'unsupportedVersion') throw new Fail('unreadable', undefined, 'unsupportedVersion', head)
            if (r.result !== 'merged') throw new Fail('fatal', undefined, 'mergeFailed')
            await log.append('merged', { noteId })
            await store.updateSync(noteId, (c) => ({ ...c, fileId, baseHeadRevisionId: head, lastError: null }), { base: remote })
            await log.append('baseAdvanced', { noteId, revisionId: head })
            // A conflict (Story 3.20): the sidecars are recorded; the note is a `conflict` note whose
            // sidecars the next upload sends, and the other pages keep syncing.
            if (r.conflicts && r.conflicts.length > 0) await conflictFound(noteId, r.conflicts)
            await settle(noteId)
          }
          bump()
          received(noteId)
          return 'ok'
        }
        // Three rejections: only this note waits; the pass goes on, the token stays.
        return skip(noteId, fileId, head, 'receiveRejected', 'exhausted')
      } catch (e) {
        if (e instanceof NoteSaveError) return noteFailed(noteId, new Fail('fatal', undefined, e.message === 'the sync record is unreadable' ? 'syncUnreadable' : 'localWrite'))
        if (e instanceof Fail) return noteFailed(noteId, e)
        throw e
      } finally {
        unmark([noteId])
      }
    })
  }

  function receiveLocal(g: Guard, noteId: string, fileId: string, head: string): Promise<Result> {
    if (openIds().includes(noteId)) return receiveNote(g, noteId, fileId, head)
    return withNoteLock(
      noteId,
      () => receiveNote(g, noteId, fileId, head),
      () => {
        // Open in another tab (or held by an upload here): that tab's editor receives it; this one asks again later.
        d.channel?.post({ t: 'remote', noteId, fileId, head })
        return skip(noteId, fileId, head, 'noteLocked')
      },
    )
  }

  // ---- the Drive file of a note that is here was renamed (spec drive.remoteTitle) ----
  /** Renames seen while the note was open here: applied when it is closed. */
  const renames = new Map<string, { fileId: string; name: string }>()

  /** The title follows the Drive name in working and base copy; `metaRev`, pages, head and state stay. */
  async function renameLocal(g: Guard, noteId: string, fileId: string, name: string): Promise<void> {
    if (openIds().includes(noteId)) {
      renames.set(noteId, { fileId, name })
      return
    }
    renames.delete(noteId)
    await withNoteLock(
      noteId,
      () =>
        chained(noteId, async (): Promise<Result> => {
          g.ensure()
          const s = await store.readSync(noteId)
          const loaded = await store.loadNote(noteId)
          const work = loaded?.result === 'ok' && loaded.writable ? loaded.note : undefined
          if (!work || !s.base || s.info.fileId !== fileId || s.info.pendingVerify !== null || s.info.state === 'error') return 'ok'
          const r = driveRemoteTitleRule({ name, title: work.meta.title, baseTitle: s.base.meta.title })
          if (!('title' in r)) return 'ok'
          const title = r.title
          const next = { ...work, meta: { ...work.meta, title } }
          // Working copy first: a base that is ahead would make the app "win" and rename the file back.
          if (!(await store.commitMerge(noteId, work, next, { conflicts: [], sidecars: [] }))) return 'ok'
          applyMergeToSession(noteId, next, [])
          const base = s.base
          await store.updateSync(noteId, (c) => c, { base: { ...base, meta: { ...base.meta, title } } })
          bump()
          return 'ok'
        }),
      () => 'ok',
    )
  }

  // ---- the Drive file of a note that is here is gone (Story 3.18) ----------
  const EPOCH = '1970-01-01T00:00:00.000Z'

  /** `error` + `lastError deleted`: what the banner of an open note and a later sweep read. */
  const markGone = (noteId: string, kind: Kind) =>
    move(noteId, 'failed', { edit: (c) => ({ ...c, lastError: { class: 'deleted', reason: kind } }) })

  /** Puts the note back on Drive (inside the note's chain): untrash, or forget the file so the next upload creates it again. */
  async function reviveIn(g: Guard, noteId: string, kind: Kind, fileId: string, announce: boolean): Promise<void> {
    let k = kind
    if (k === 'trashed') {
      try {
        await call(g, noteId, () => drive.update(fileId, { trashed: false }), (e) => e.kind === 'http' && e.status === 404)
      } catch (e) {
        if (!(e instanceof DriveError)) throw e
        k = 'removed' // deleted for good meanwhile
      }
    }
    g.ensure()
    if (k === 'removed') {
      const from = (await store.readSync(noteId)).info.state
      await store.resetSync(noteId)
      if (from !== 'pending') await log.append('stateChange', { noteId, from, to: 'pending' })
    } else {
      await move(noteId, 'retry', { edit: (c) => ({ ...c, lastError: null }) })
      await settle(noteId) // nothing unsent: the file is back as it was, the note is whole
    }
    if (announce) set({ revived: state.revived + 1 })
    bump()
  }

  /**
   * One decision for a note whose file is gone, inside its chain; true = upload it now. Everything is
   * read again after the last await: unsent changes (an open note is flushed first) restore it, an open
   * note without any gets the banner, a closed one is removed (only while its working copy is unchanged).
   */
  async function goneStep(g: Guard, noteId: string, fileId: string, kind: Kind): Promise<boolean> {
    for (let tries = 0; tries < 3; tries++) {
      g.ensure()
      const open = openIds().includes(noteId)
      if (open) await getOpenNote(noteId)?.flush().catch(() => false)
      g.ensure()
      const s = await store.readSync(noteId)
      const loaded = await store.loadNote(noteId)
      const work = loaded?.result === 'ok' && loaded.writable ? loaded.note : undefined
      if (!work || s.info.fileId !== fileId) return false
      if (keepsLocal(s.hasUnsent, s.info)) {
        await log.append('error', { class: 'deleted', noteId, reason: kind })
        await reviveIn(g, noteId, kind, fileId, true)
        return !open
      }
      if (open) {
        if (goneKind(s.info) === null) {
          await log.append('error', { class: 'deleted', noteId, reason: kind })
          await markGone(noteId, kind)
        }
        return false
      }
      await log.append('error', { class: 'deleted', noteId, reason: kind })
      if (await store.removeNote(noteId, work)) {
        bump()
        return false
      }
    }
    return false
  }

  async function fileGone(g: Guard, noteId: string, fileId: string, kind: Kind): Promise<Result> {
    let upload = false
    const run = () =>
      chained(noteId, async (): Promise<Result> => {
        upload = await goneStep(g, noteId, fileId, kind)
        return 'ok'
      })
    const r = openIds().includes(noteId)
      ? await run()
      : await withNoteLock(noteId, run, () => {
          d.channel?.post({ t: 'deleted', noteId, fileId, kind }) // open in another tab: that tab decides
          return 'ok'
        })
    if (upload) await d.uploadNote?.(noteId).catch(() => {})
    return r
  }

  /** `fileGone` for every note a call found missing, and (with `listed`) every note whose file the rescan did not list. */
  async function sweepGone(g: Guard, listed?: ReadonlySet<string>): Promise<void> {
    for (const id of await store.listIds()) {
      g.ensure()
      const info = (await store.readSync(id)).info
      const fileId = info.fileId
      if (fileId === null) continue
      let kind = goneKind(info)
      if (kind === null && listed && !listed.has(fileId) && info.state !== 'syncing') {
        try {
          const f = await call(g, id, () => drive.get(fileId, { fields: 'headRevisionId,trashed' }))
          if (f.trashed) kind = 'trashed'
        } catch (e) {
          if (!(e instanceof Fail && e.cls === 'deleted')) throw e
          kind = 'removed'
        }
      }
      if (kind !== null) await fileGone(g, id, fileId, kind)
    }
  }

  async function settleGone(g: Guard): Promise<void> {
    for (const id of [...goneNotes]) {
      goneNotes.delete(id)
      const info = (await store.readSync(id)).info
      const kind = goneKind(info)
      if (kind !== null && info.fileId !== null) await fileGone(g, id, info.fileId, kind)
    }
  }

  // ---- a note that is not here -------------------------------------------
  /** Downloads the head and stores the note (working = base). */
  function downloadNew(g: Guard, noteId: string, fileId: string, head: string, file: DriveFile | null = null): Promise<Result> {
    return withNoteLock(
      noteId,
      () =>
        chained(noteId, async (): Promise<Result> => {
          let note: Note
          try {
            note = await downloadNote(g, noteId, fileId, head)
          } catch (e) {
            // The file stays as it is on Drive; the card says it cannot be opened (never downloaded again for this head).
            if (e instanceof Fail && e.cls === 'unreadable') await blockCard(g, noteId, fileId, head, file, e.reason === 'unsupportedVersion' ? 'unsupportedVersion' : 'unreadable')
            throw e
          }
          g.ensure()
          const info: SyncInfo = { ...emptySync(), fileId, baseHeadRevisionId: head, state: 'synced' }
          await store.commitReceive(noteId, null, note, info, (await store.readSync(noteId)).info) // false: a copy appeared meanwhile, which stays
          await d.remote.delete(noteId)
          bump()
          return 'ok'
        }),
      () => 'ok',
    )
  }

  async function blockCard(g: Guard, noteId: string, fileId: string, head: string, file: DriveFile | null, blocked: NonNullable<RemoteCard['blocked']>) {
    g.ensure()
    const old = await d.remote.get(noteId)
    await d.remote.put({
      noteId,
      fileId,
      headRevisionId: head,
      title: old?.title ?? nameOf(file),
      folderId: old?.folderId ?? file?.parents?.[0] ?? null,
      coverId: old?.coverId ?? null,
      modifiedAt: old?.modifiedAt ?? file?.modifiedTime ?? EPOCH,
      blocked,
    })
    bump()
  }

  async function addRemote(g: Guard, file: DriveFile, noteId: string, head: string): Promise<Result> {
    const previous = await d.remote.get(noteId)
    const blocked = previous?.blocked !== undefined && previous.headRevisionId === head ? previous.blocked : undefined
    const r = listSummaryRule({
      op: 'read',
      rootFolderId: g.root,
      file: {
        id: file.id,
        name: file.name,
        appProperties: file.appProperties,
        md5Checksum: file.md5Checksum,
        modifiedTime: file.modifiedTime,
        parents: file.parents,
        thumbnailLink: file.thumbnailLink,
      },
    }) as { source?: string; card?: { title: string; folderId: string | null; coverId: string | null; modifiedAt: unknown } }
    if (r.source === 'summary' && r.card && typeof r.card.modifiedAt === 'string') {
      const card: RemoteCard = {
        noteId,
        fileId: file.id,
        headRevisionId: head,
        title: r.card.title,
        folderId: r.card.folderId,
        coverId: r.card.coverId,
        modifiedAt: r.card.modifiedAt,
        ...(blocked !== undefined && { blocked }),
      }
      g.ensure()
      const old = await d.remote.get(noteId)
      if (old && JSON.stringify(old) === JSON.stringify(card)) return 'ok'
      await d.remote.put(card)
      bump()
      return 'ok'
    }
    if (blocked !== undefined) return 'ok' // this head was downloaded and could not be read: not again
    return downloadNew(g, noteId, file.id, head, file) // no valid summary: the card is drawn from the content
  }

  async function dropCard(g: Guard, noteId: string) {
    g.ensure()
    if (await d.remote.get(noteId)) {
      await d.remote.delete(noteId)
      bump()
    }
  }

  // ---- one pass over a list of changes -----------------------------------
  async function applyAll(g: Guard, changes: DriveChange[]): Promise<boolean> {
    const local = new Set(await store.listIds())
    const cards = new Map((await d.remote.list()).map((c) => [c.noteId, c]))
    g.ensure()
    const files: { file: DriveFile; noteId: string; head: string }[] = []
    // Local notes whose file was trashed or removed (Story 3.18).
    const gone: { noteId: string; fileId: string; kind: Kind }[] = []
    let byFile: Map<string, string> | null = null
    for (const c of changes) {
      const f = c.file
      if (c.removed || !f) {
        for (const card of cards.values()) if (card.fileId === c.fileId) await dropCard(g, card.noteId)
        if (!byFile) {
          byFile = new Map()
          for (const id of local) {
            const fid = (await store.readSync(id)).info.fileId
            if (fid !== null) byFile.set(fid, id)
          }
        }
        const owner = byFile.get(c.fileId)
        if (owner !== undefined) gone.push({ noteId: owner, fileId: c.fileId, kind: 'removed' })
        continue
      }
      const id = f.appProperties.kkeujeokId
      if (f.mimeType !== KKJ_MIME || id === undefined || !UUID.test(id)) continue
      if (f.trashed) {
        await dropCard(g, id)
        if (local.has(id)) gone.push({ noteId: id, fileId: f.id, kind: 'trashed' })
        continue
      }
      if (f.headRevisionId) files.push({ file: f, noteId: id, head: f.headRevisionId })
    }
    // Badges first: the cards of the notes about to be received show ↓ before any download.
    const badge: string[] = []
    for (const { file, noteId, head } of files) {
      if (local.has(noteId)) {
        const s = await store.readSync(noteId)
        const open = s.info.state !== 'error' || goneKind(s.info) !== null || recoverable(s.info, head)
        if (s.info.fileId === file.id && head !== s.info.baseHeadRevisionId && open && s.info.pendingVerify === null) {
          badge.push(noteId)
          pending.set(noteId, { fileId: file.id, head })
        }
      } else if (cards.has(noteId) && cards.get(noteId)!.headRevisionId !== head) badge.push(noteId)
    }
    mark(badge)
    let ok = true
    // One note's step: a permanent failure is logged (and, for a note here, its state); a transient one stops the pass.
    const step = async (noteId: string, run: () => Promise<Result>): Promise<Result> => {
      try {
        return await run()
      } catch (e) {
        if (e instanceof NoteSaveError) e = new Fail('fatal', undefined, 'localWrite')
        if (!(e instanceof Fail)) throw e
        await logError(noteId, e)
        return TRANSIENT.has(e.cls) ? 'later' : 'ok'
      } finally {
        pending.delete(noteId)
        unmark([noteId])
      }
    }
    try {
      for (const x of gone) {
        g.ensure()
        if ((await step(x.noteId, () => fileGone(g, x.noteId, x.fileId, x.kind))) === 'later') return false
      }
      for (const { file, noteId, head } of files) {
        g.ensure()
        const r = await step(noteId, async () => {
          if (!local.has(noteId)) return addRemote(g, file, noteId, head)
          const res = await receiveLocal(g, noteId, file.id, head)
          if (res === 'ok' && file.name !== undefined) await renameLocal(g, noteId, file.id, file.name) // after a receive: the content may carry the old title
          return res
        })
        if (r === 'exhausted') ok = false // not received: the changes come again
        if (r === 'later') {
          ok = false
          break // a failing connection fails the next note too; the token stays and the changes come again
        }
      }
    } finally {
      for (const f of files) pending.delete(f.noteId)
      unmark(badge)
    }
    return ok
  }

  // ---- tokens, scan, poll ------------------------------------------------
  async function deviceFor(g: Guard): Promise<SyncDevice | null> {
    let dev = await d.device.read()
    if (dev.sub !== null && dev.sub !== g.sub) return null // Story 3.8 handles another account
    if (dev.sub === null) {
      if (!(await d.device.adoptAccount(g.sub, g.email))) {
        const now = await d.device.read()
        if (now.sub !== null && now.sub !== g.sub) return null
        throw new Fail('fatal', undefined, 'deviceUnreadable') // there but unreadable: never overwritten
      }
      dev = await d.device.read()
    }
    g.ensure()
    return dev
  }

  async function saveToken(g: Guard, token: string) {
    g.ensure()
    const latest = await d.device.read()
    if (latest.sub === null) throw new Fail('fatal', undefined, 'deviceUnreadable')
    if (latest.sub !== g.sub) return
    g.ensure()
    try {
      await d.device.write({ ...latest, pageToken: token })
    } catch (e) {
      if (!(e instanceof NoteSaveError)) throw e
      throw new Fail('fatal', undefined, 'deviceUnreadable')
    }
  }

  async function scan(g: Guard, rejected: boolean) {
    if (rejected) await log.append('pageTokenRejected')
    set({ scanning: true })
    try {
      // The start token comes first: what changes during the scan is listed again later.
      const start = await call(g, undefined, () => drive.getStartPageToken())
      const files: DriveFile[] = []
      let token: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const t = token
        const p = await call(g, undefined, () =>
          drive.list(NOTE_FILES_QUERY, { fields: `nextPageToken,files(${CHANGE_FILE_FIELDS})`, pageSize: 1000, ...(t && { pageToken: t }) }),
        )
        files.push(...p.files)
        token = p.nextPageToken
        if (!token) break
      }
      g.ensure()
      if (await applyAll(g, files.map((f) => ({ fileId: f.id, removed: false, file: f })))) {
        // A note whose file the scan did not list is checked: gone, or only out of this listing.
        await sweepGone(g, new Set(files.map((f) => f.id)))
        await saveToken(g, start)
      }
    } finally {
      set({ scanning: false })
    }
  }

  async function poll(g: Guard, saved: string) {
    let token = saved
    const changes = new Map<string, DriveChange>()
    let next: string | undefined
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const t = token
        const r = await call(g, undefined, () => drive.listChanges(t), isRejected)
        g.ensure()
        for (const c of r.changes) changes.set(c.fileId, c)
        if (r.nextPageToken) {
          token = r.nextPageToken
          continue
        }
        next = r.newStartPageToken
        break
      }
    } catch (e) {
      if (e instanceof DriveError && isRejected(e)) return scan(g, true)
      throw e
    }
    if (!next) throw new Fail('fatal', undefined, 'noStartToken')
    if (await applyAll(g, [...changes.values()])) await saveToken(g, next)
  }

  /** "Start": a note left `syncing` without an upload in progress is received again. */
  async function recover(g: Guard) {
    for (const id of await store.listIds()) {
      g.ensure()
      const s = await store.readSync(id)
      const fileId = s.info.fileId
      if (s.info.state !== 'syncing' || s.info.pendingVerify !== null || fileId === null) continue
      const head = await call(g, id, () => drive.get(fileId, { fields: 'headRevisionId,trashed' }))
      if (head.trashed || !head.headRevisionId) continue
      if (head.headRevisionId === s.info.baseHeadRevisionId) await chained(id, () => settle(id))
      else await receiveLocal(g, id, fileId, head.headRevisionId)
    }
    await sweepGone(g) // an upload that found its file gone left the note in `error deleted`
  }

  /** The notes skipped before (lock held, `error`, other file, rejected commits) are looked at again. */
  async function retrySkipped(g: Guard): Promise<void> {
    for (const [noteId, p] of [...retry]) {
      g.ensure()
      try {
        await receiveLocal(g, noteId, p.fileId, p.head)
      } catch (e) {
        if (e instanceof NoteSaveError) e = new Fail('fatal', undefined, 'localWrite')
        if (!(e instanceof Fail)) throw e
        await logError(noteId, e)
        if (TRANSIENT.has(e.cls)) return
      }
    }
  }

  let flight: Promise<void> | null = null
  let recovered = false

  async function run() {
    if (!usable()) return
    const g = guard()
    if (!g) return
    try {
      const dev = await deviceFor(g)
      if (!dev || dev.rootFolderId === null) return
      g.root = dev.rootFolderId
      if (dev.pageToken === null) await scan(g, false)
      else await poll(g, dev.pageToken)
      if (!recovered) {
        await recover(g)
        recovered = true
      }
      await retrySkipped(g)
      await settleGone(g)
    } catch (e) {
      if (e instanceof Gone) return
      if (e instanceof NoteSaveError) e = new Fail('fatal', undefined, 'localWrite')
      if (e instanceof Fail) return logError(undefined, e)
      throw e
    }
  }

  /** `fn` with the account guard and the failure handling of the other entry points. */
  async function guarded(noteId: string, fn: (g: Guard) => Promise<void>): Promise<void> {
    if (!usable()) return
    const g = guard()
    if (!g) return
    try {
      await fn(g)
    } catch (e) {
      if (e instanceof Gone) return
      if (e instanceof Fail) return logError(noteId, e)
      if (e instanceof NoteSaveError) return logError(noteId, new Fail('fatal', undefined, 'localWrite'))
      throw e
    }
  }

  const api = {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },

    /** Asks Drive what changed: at once on load / tab visible, then by timer. One run at a time. */
    check(): Promise<void> {
      flight ??= run().finally(() => void (flight = null))
      return flight
    },

    /**
     * Before the editor opens: a card is downloaded, a note flagged receiving is received. Offline or a
     * failed receive of a local note leaves the device copy; a failed card download rejects.
     */
    async beforeOpen(noteId: string): Promise<void> {
      if (!usable()) return
      const g = guard()
      if (!g) return
      try {
        const card = await d.remote.get(noteId)
        if (card) {
          if (card.blocked !== undefined) return // it cannot be read: nothing to open
          const f = await call(g, noteId, () => drive.get(card.fileId, { fields: 'headRevisionId,trashed' }))
          if (f.trashed || !f.headRevisionId) {
            await dropCard(g, noteId)
            throw new Fail('deleted', 404, 'trashed')
          }
          await downloadNew(g, noteId, card.fileId, f.headRevisionId)
          return
        }
        const p = pending.get(noteId) ?? retry.get(noteId)
        if (p) await receiveLocal(g, noteId, p.fileId, p.head)
      } catch (e) {
        if (e instanceof Gone) return
        if (e instanceof Fail) await logError(noteId, e)
        if (e instanceof NoteSaveError) throw new Fail('fatal', undefined, 'localWrite')
        throw e
      }
    },

    /** The editor of `noteId` is shown: its remote head is checked and received through the editor when it differs. */
    async noteOpened(noteId: string): Promise<void> {
      if (!usable()) return
      const g = guard()
      if (!g) return
      try {
        const s = await store.readSync(noteId)
        const fileId = s.info.fileId
        if (fileId === null) return
        const f = await call(g, noteId, () => drive.get(fileId, { fields: 'headRevisionId,trashed' }))
        g.ensure()
        if (f.trashed) return void (await fileGone(g, noteId, fileId, 'trashed'))
        if (!f.headRevisionId || (f.headRevisionId === s.info.baseHeadRevisionId && goneKind(s.info) === null)) return
        await receiveNote(g, noteId, fileId, f.headRevisionId)
      } catch (e) {
        if (e instanceof Fail && e.cls === 'deleted') {
          // `files.get` 404: the file is gone for good.
          try {
            return void (await fileGone(g, noteId, (await store.readSync(noteId)).info.fileId ?? '', 'removed'))
          } catch (e2) {
            if (e2 instanceof Gone) return
            if (e2 instanceof Fail) return logError(noteId, e2)
            if (e2 instanceof NoteSaveError) return logError(noteId, new Fail('fatal', undefined, 'localWrite'))
            throw e2
          }
        }
        if (e instanceof Gone) return
        if (e instanceof Fail) return logError(noteId, e)
        if (e instanceof NoteSaveError) return logError(noteId, new Fail('fatal', undefined, 'localWrite'))
        throw e
      }
    },

    /**
     * The editor of `noteId` is gone (its last save and lock are released), or [닫기] of the deleted banner
     * was pressed: a note the banner was shown for is removed when it still has nothing unsent, restored when it has.
     */
    noteClosed: (noteId: string): Promise<void> =>
      guarded(noteId, async (g) => {
        const info = (await store.readSync(noteId)).info
        const kind = goneKind(info)
        if (kind !== null && info.fileId !== null) await fileGone(g, noteId, info.fileId, kind)
        const r = renames.get(noteId)
        if (r && kind === null) await renameLocal(g, noteId, r.fileId, r.name)
      }),

    /** [다시 살리기] of the deleted banner: the file is untrashed or created again by the next upload. */
    revive: (noteId: string): Promise<void> =>
      guarded(noteId, async (g) => {
        const info = (await store.readSync(noteId)).info
        const kind = goneKind(info)
        const fileId = info.fileId
        if (kind === null || fileId === null) return
        await chained(noteId, async () => {
          g.ensure()
          const now = (await store.readSync(noteId)).info
          if (goneKind(now) === null || now.fileId !== fileId) return // restored or replaced meanwhile
          await reviveIn(g, noteId, kind, fileId, false)
        })
      }),

    /** A message of another tab: a change to refresh, or a note open here that it could not receive. */
    async onMessage(m: unknown): Promise<void> {
      const msg = m as { t?: unknown; noteId?: unknown; fileId?: unknown; head?: unknown; kind?: unknown } | null
      if (msg?.t === 'changed') return bump(false)
      if (msg?.t === 'deleted' && typeof msg.noteId === 'string' && typeof msg.fileId === 'string' && (msg.kind === 'trashed' || msg.kind === 'removed')) {
        if (!openIds().includes(msg.noteId) || !usable()) return
        const g = guard()
        if (!g) return
        const { noteId, fileId, kind } = msg as { noteId: string; fileId: string; kind: Kind }
        try {
          await fileGone(g, noteId, fileId, kind)
        } catch (e) {
          if (!(e instanceof Gone || e instanceof Fail || e instanceof NoteSaveError)) throw e
        }
        return
      }
      if (msg?.t !== 'remote' || typeof msg.noteId !== 'string' || typeof msg.fileId !== 'string' || typeof msg.head !== 'string') return
      if (!openIds().includes(msg.noteId) || !usable()) return
      const g = guard()
      if (!g) return
      try {
        await receiveNote(g, msg.noteId, msg.fileId, msg.head)
      } catch (e) {
        if (!(e instanceof Gone)) throw e
      }
    },
  }
  const unsubscribe = d.channel?.subscribe((m) => void api.onMessage(m).catch(() => {}))
  return { ...api, dispose: () => unsubscribe?.() }
}
