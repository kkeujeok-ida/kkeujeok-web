// The version history of one note (Story 3.25, spec version-history.md): reading what Drive lists, downloading a
// version for its preview, and the restore procedure. Mirrors kkeujeok-client/lib/sync/version_history.dart.
import {
  DriveError,
  type DriveClient,
  type DriveFile,
  type DriveRevision,
  childrenQuery,
  kkeujeokIdQuery,
} from '../drive/driveClient'
import { newId } from '../model/ids'
import { decodeKkj } from '../model/kkjCodec'
import type { Note, Page } from '../model/note'
import { type RestoreCtx, restoreNote, restorePage } from '../ops/restore'
import type { NoteStore } from '../storage/noteStore'
import { unresolvedOf } from './conflicts'
import type { UploadCoordinator } from './uploadCoordinator'
import { keepForeverRule, type VersionEntry } from './versionList'

type Json = Record<string, unknown>

/** What Drive lists for the history of a note: the revisions of the note file and the files of its `.conflicts` folder. */
export type VersionData = { headRevisionId: string | null; revisions: DriveRevision[]; sidecars: DriveFile[] }

/** What a download of one version showed: `info` is the `info` of `version.list`; `page` is the page to draw as the preview. */
export type Inspection = {
  info: { ok: true; pages: { editedAt: string; editedBy: string }[] } | { ok: true; editedBy: string } | { ok: false; reason: 'unreadable' | 'unsupportedVersion' | 'purged' }
  page?: Page
  /** The parsed note of a revision. */
  note?: Note
}

const failed = (reason: 'unreadable' | 'unsupportedVersion' | 'purged'): Inspection => ({ info: { ok: false, reason } })

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const validPage = (p: unknown): p is Page =>
  typeof p === 'object' && p !== null && finite((p as Json).width) && finite((p as Json).height) && ((p as Json).width as number) > 0 && ((p as Json).height as number) > 0 && Array.isArray((p as Json).elements)

export const isPurged = (e: unknown) => e instanceof DriveError && e.kind === 'http' && e.status === 404

/** Reads the history of one note from Drive. Rejects only with DriveError. */
export function createVersionSource(drive: DriveClient) {
  async function all(q: string, fields: string): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let token: string | undefined
    do {
      const t = token
      const p = await drive.list(q, { fields: `nextPageToken,files(${fields})`, ...(t && { pageToken: t }) })
      out.push(...p.files)
      token = p.nextPageToken
    } while (token)
    return out
  }

  return {
    /** Steps 1 and 2 of "Reading the list", in this order. */
    async load(noteId: string, fileId: string): Promise<VersionData> {
      const head = (await drive.get(fileId, { fields: 'headRevisionId' })).headRevisionId ?? null
      const revisions = await drive.listRevisions(fileId)
      const sidecars: DriveFile[] = []
      for (const folder of await all(kkeujeokIdQuery(`cf:${noteId}`), 'id')) sidecars.push(...(await all(childrenQuery(folder.id), 'id,appProperties')))
      return { headRevisionId: head, revisions, sidecars }
    },

    /** Downloads a revision. A purged one (404) is a result; any other DriveError goes to the caller (the status stays unknown). */
    async inspectRevision(noteId: string, fileId: string, revisionId: string): Promise<Inspection> {
      let bytes: Uint8Array
      try {
        bytes = await drive.downloadRevision(fileId, revisionId)
      } catch (e) {
        if (isPurged(e)) return failed('purged')
        throw e
      }
      const r = await decodeKkj(bytes)
      if (r.result === 'unsupportedVersion') return failed('unsupportedVersion')
      const note = r.note
      if (!note || note.noteId !== noteId || note.pages.length === 0) return failed('unreadable')
      return {
        info: { ok: true, pages: note.pages.map((p) => ({ editedAt: p.editedAt, editedBy: p.editedBy })) },
        page: note.pages[0]!,
        note,
      }
    },

    /** Downloads a sidecar (`driveFileId`) and checks it is the record of (`pageId`, `rev`). */
    async inspectSidecar(noteId: string, driveFileId: string, pageId: string, rev: string): Promise<Inspection> {
      let bytes: Uint8Array
      try {
        bytes = await drive.downloadFile(driveFileId)
      } catch (e) {
        if (isPurged(e)) return failed('purged')
        throw e
      }
      try {
        const j = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Json
        if (j && j.noteId === noteId && j.pageId === pageId && j.rev === rev && typeof j.editedBy === 'string' && validPage(j.page)) {
          return { info: { ok: true, editedBy: j.editedBy }, page: j.page }
        }
      } catch {
        // falls through to unreadable
      }
      return failed('unreadable')
    },
  }
}
export type VersionSource = ReturnType<typeof createVersionSource>

/** Why a restore did nothing (spec version-history "Restoring"). */
export type RestoreFailure =
  /** Step 1: the version could not be read, or the operation does not apply. */
  | 'unreadable'
  /** Step 2: the current state could not be uploaded and verified. */
  | 'notSaved'
  /** Step 3: the "복원 전" revision could not be pinned. */
  | 'notPinned'
  /** Step 4: the note could not be changed. */
  | 'notApplied'
  /** A stroke is being written: nothing was done. */
  | 'busy'
  /** The note was edited after it was uploaded and pinned: nothing was restored. */
  | 'changed'

export type RestoreResult = {
  failure: RestoreFailure | null
  /**
   * The pages that still have an unresolved conflict, from the sync record as committed by the last write that
   * succeeded. Undefined when nothing was written: the editor keeps its locks (a read error never unlocks).
   */
  locked?: string[]
}

/** Same pages with the same revisions, same order and meta: nothing was edited between the two. */
const sameState = (x: Note, y: Note) =>
  x.orderRev === y.orderRev && x.metaRev === y.metaRev && x.pages.length === y.pages.length && x.pages.every((p, i) => p.id === y.pages[i]!.id && p.rev === y.pages[i]!.rev)

/** The editor's queue entry point: `run` sees the live note synchronously. False = refused (a stroke, read-only, leaving), nothing changed. */
export type RestoreApply = (run: (live: Note) => { note: Note; undoDrop: string[] } | null) => boolean

export type RestorerDeps = {
  drive: DriveClient
  store: Pick<NoteStore, 'readSync'>
  coordinator: Pick<UploadCoordinator, 'uploadForRestore' | 'reportFailure' | 'conflictResolved'>
  source?: VersionSource
  now?: () => string
  newRev?: () => string
  editedBy: () => string
}

/**
 * The restore procedure of spec version-history: read the version, upload and verify the current state, pin that
 * revision, apply the restore through the note's queue. A failed step stops the restore; the note is not changed by
 * it. Never throws.
 */
export function createVersionRestorer(d: RestorerDeps) {
  const source = d.source ?? createVersionSource(d.drive)
  const now = d.now ?? (() => new Date().toISOString())
  const newRev = d.newRev ?? newId

  type Op = { op: 'restoreNote'; version: Note } | { op: 'restorePage'; pageId: string; page: Page; originalIndex: number }

  /** The operation for `entry`; null when the version cannot be read (a network error too). */
  async function read(noteId: string, fileId: string, entry: VersionEntry): Promise<Op | null> {
    try {
      if (entry.kind === 'revision') {
        const r = await source.inspectRevision(noteId, fileId, entry.revisionId)
        return r.info.ok && r.note ? { op: 'restoreNote', version: structuredClone(r.note) } : null
      }
      const files = await d.drive.list(kkeujeokIdQuery(`sc:${noteId}:${entry.pageId}:${entry.rev}`), { fields: 'files(id)' })
      if (files.files.length === 0) return null
      const r = await source.inspectSidecar(noteId, files.files[0]!.id, entry.pageId, entry.rev)
      return r.info.ok && r.page ? { op: 'restorePage', pageId: entry.pageId, page: r.page, originalIndex: entry.originalIndex } : null
    } catch (e) {
      if (e instanceof DriveError) return null
      throw e
    }
  }

  function run(cur: Note, op: Op, conflicts: Json[]) {
    const base = { now: now(), orderRev: newRev(), editedBy: d.editedBy(), lastSeenRemoteSeq: 0 }
    return op.op === 'restoreNote'
      ? restoreNote(cur, op, { ...base, revs: op.version.pages.map(() => newRev()) } as RestoreCtx, conflicts)
      : restorePage(cur, op, { ...base, rev: newRev() } as RestoreCtx, conflicts)
  }

  /** Best effort: puts back pins that were released for a pin that failed. */
  async function repin(fileId: string, ids: string[]) {
    for (const id of ids) await d.drive.updateRevision(fileId, id, { keepForever: true }).catch(() => {})
  }

  /** Step 3: pins `revisionId` and releases the oldest pins at the cap. Any failure is a sync error of the note and ends the restore. */
  async function pin(noteId: string, fileId: string, revisionId: string): Promise<boolean> {
    const released: string[] = []
    try {
      const plan = async () => {
        const revs = await d.drive.listRevisions(fileId)
        return keepForeverRule({ revisions: revs.map((v) => ({ id: v.id, modifiedTime: v.modifiedTime, keepForever: v.keepForever === true })), target: revisionId })
      }
      let r = await plan()
      // The listing may not have caught up with the verified head: ask once more.
      if ('error' in r) r = await plan()
      if ('error' in r) throw new DriveError('parse')
      for (const id of r.release) {
        try {
          await d.drive.updateRevision(fileId, id, { keepForever: false })
          released.push(id)
        } catch (e) {
          if (isPurged(e)) continue // already purged by Drive: released all the same
          throw e
        }
      }
      if (r.mark !== null) {
        await d.drive.updateRevision(fileId, r.mark, { keepForever: true })
      }
      return true
    } catch (e) {
      await repin(fileId, released) // the old pins are not lost, whatever failed
      if (!(e instanceof DriveError)) throw e
      await d.coordinator.reportFailure(noteId, e)
      return false
    }
  }

  return {
    /** `entry` is a `version.list` entry. `live` is the note in the queue now; `flush` waits for the editor's saves. */
    async restore(a: {
      noteId: string
      fileId: string
      entry: VersionEntry
      live: () => Note
      apply: RestoreApply
      flush: () => Promise<boolean>
    }): Promise<RestoreResult> {
      const { noteId, fileId } = a
      try {
        // 1. Read the version, and try the operation on a copy.
        const op = await read(noteId, fileId, a.entry)
        if (!op) return { failure: 'unreadable' }
        const first = await d.store.readSync(noteId)
        if ('error' in run(a.live(), op, first.info.conflicts)) return { failure: 'unreadable' }

        // 2. Upload and verify the current state.
        const head = await d.coordinator.uploadForRestore(noteId, a.flush)
        if (head === null) return { failure: 'notSaved' }

        // 3. Pin that revision as "복원 전".
        if (!(await pin(noteId, fileId, head))) return { failure: 'notPinned' }

        // 4. Apply the restore as an item of the note's queue, only on the note that was uploaded and verified: an
        // edit saved since then is in neither the upload nor the pin, so the restore would overwrite it.
        const after = await d.store.readSync(noteId)
        const info = after.info
        const uploaded = after.base
        let out: ReturnType<typeof run> | null = null
        let changed = false
        const applied = a.apply((cur) => {
          if (!uploaded || !sameState(uploaded, cur)) {
            changed = true
            return null
          }
          const r = run(cur, op, info.conflicts)
          if ('error' in r) return null
          out = r
          return { note: r.note, undoDrop: r.undoDrop }
        })
        const res = out as ReturnType<typeof run> | null
        if (changed) return { failure: 'changed' }
        if (!applied || !res || 'error' in res) return { failure: 'notApplied' }

        // From here the note IS restored: nothing below may report a failure.
        const result: RestoreResult = { failure: null }
        try {
          // The restored note is on disk before `sync.json` says its conflicts are settled (one more try).
          if (!(await a.flush().catch(() => false)) && !(await a.flush().catch(() => false))) return result
          for (const [i, c] of info.conflicts.entries()) {
            const done = res.conflicts[i]
            if (c.resolvedAt != null || !done || done.resolvedAt == null) continue
            // A failed write is tried once more; the conflict then stays open and can be settled in the conflict dialog.
            for (let tries = 0; tries < 2; tries++) {
              try {
                result.locked = unresolvedOf(await d.coordinator.conflictResolved(noteId, done)).map((x) => String(x.pageId))
                break
              } catch {
                // again, then it stays open
              }
            }
          }
        } catch {
          // restored all the same; `locked` holds what was committed
        }
        return result
      } catch {
        return { failure: 'notApplied' }
      }
    },
  }
}
export type VersionRestorer = ReturnType<typeof createVersionRestorer>

/** What the editor needs for the version history (Story 3.25). */
export type Versions = {
  source: VersionSource
  restorer: VersionRestorer
  /** Is there a connection? The dialog gives it 3 s. */
  probe: () => Promise<boolean>
}
