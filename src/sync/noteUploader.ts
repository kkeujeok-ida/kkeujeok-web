// Uploads one note at a time (spec sync.md steps 0-5 and "Start"). Mirrors
// kkeujeok-client/lib/sync/note_uploader.dart. Everything that touches the
// outside is injected. A note's calls run one after another (the page session's chain per note id, shared with the receiver).
//
// A Drive or local-write failure never throws: it ends in the state `error`
// with a `lastError` and a log entry. Any other exception is a bug (or a simulated
// crash in a test); what is stored then is what a closed tab leaves, and "Start"
// recovers it.
import {
  DriveError,
  RESUMABLE_CHUNK,
  type DriveClient,
  type DriveFile,
  type ResumableResult,
  kkeujeokIdQuery,
} from '../drive/driveClient'
import { driveDuplicatesRule } from '../drive/duplicates'
import { listSummaryRule } from '../drive/noteSummary'
import { decodeKkj, encodeKkj } from '../model/kkjCodec'
import type { Note, Page } from '../model/note'
import { NoteSaveError } from '../storage/noteDb'
import { type NoteStore, SYNC_UNREADABLE } from '../storage/noteStore'
import type { SyncDeviceStore } from '../storage/syncDevice'
import { type JsonMap, type SyncInfo } from '../storage/syncInfo'
import { md5Hex } from '../util/md5'
import { conflictLogFields } from './conflicts'
import { classifyDriveError } from './errorClass'
import { hasUnsentRule } from './hasUnsent'
import type { MergeIo } from './mergeIo'
import { chained } from './noteChain'
import type { AssetStore } from '../storage/assetStore'
import { createAssetUploader } from './assetUploader'
import { createSidecarUploader } from './sidecarUploader'
import type { SyncLog } from './syncLog'
import { backoffRule, transition, uploadKindRule, verifyPlanRule } from './syncRules'

/** The `sync.json` key of a deleted note that still waits to be trashed (an unknown key, kept by every commit). */
export const PENDING_TRASH = 'pendingTrash'

export type UploadOutcome = 'uploaded' | 'skipped' | 'failed'

/** A thumbnail PNG over this is not written. */
export const MAX_THUMBNAIL_BYTES = 2_097_152

const KKJ_MIME = 'application/vnd.kkeujeok.kkj'
const LAST_RESORT_TIME = '9999-12-31T23:59:59.999Z'

type Failure = { cls: string; status?: number; reason?: string; clearVerify?: boolean; /** The remote head that could not be read. */ head?: string }
class UploadFailure extends Error {
  constructor(readonly f: Failure) {
    super(`UploadFailure(${f.cls}, ${f.reason ?? ''})`)
  }
}
const failure = (cls: string, o: Omit<Failure, 'cls'> = {}) => new UploadFailure({ cls, ...o })

export type UploaderDeps = {
  store: NoteStore
  drive: DriveClient
  device: Pick<SyncDeviceStore, 'read' | 'update'>
  log: Pick<SyncLog, 'append'>
  merge: MergeIo
  /** The upload gate: root folder ready. */
  allowed: () => boolean
  /** False while the browser knows it is offline: no request is made. */
  online: () => boolean
  /** `noteId`: the note that waits (the coordinator lets go of its sync lock meanwhile). */
  sleep: (ms: number, noteId?: string) => Promise<void>
  /** A number in [0, 1] for `sync.backoff`. */
  jitter: () => number
  /** PNG of a page at the size the summary names; null when it cannot be drawn. */
  thumbnail?: (page: Page, width: number, height: number) => Promise<Uint8Array | null>
  md5?: (bytes: Uint8Array) => string
  /** Image asset bytes of this browser; without it the image assets of a note are not checked or uploaded. */
  assets?: AssetStore
  /** Drive holds this image asset (checked or just uploaded). */
  onAssetConfirmed?: (hash: string) => void
  /** Resumable chunk size (a multiple of 262,144); the spec value by default. */
  chunkSize?: number
  /** Milliseconds since the epoch, for the 30-day sidecar cleanup. */
  now?: () => number
}

/** A resolved conflict's sidecar stays on Drive this long (Story 3.21/3.22). */
export const SIDECAR_KEEP_MS = 30 * 24 * 60 * 60 * 1000

export type NoteUploader = ReturnType<typeof createNoteUploader>

const asS = (n: Note) => ({ orderRev: n.orderRev, metaRev: n.metaRev, pages: n.pages })

export function createNoteUploader(d: UploaderDeps) {
  const { store, drive, log } = d
  const md5 = d.md5 ?? md5Hex
  // sync.md step 0 / drive-layout: conflict sidecars go before the note, each by idempotent creation.
  const sidecars = createSidecarUploader({
    drive,
    device: d.device,
    store,
    log,
    md5,
    call: (noteId, fn, o) => call(noteId, fn, o),
    failure: (cls, o) => failure(cls, o),
  })

  // sync.md step 0 / image.md "Upload order": the image assets a note references go before it.
  const assetUp = d.assets
    ? createAssetUploader({
        drive,
        device: d.device,
        assets: d.assets,
        md5,
        call: (noteId, fn, o) => call(noteId, fn, o),
        failure: (cls, o) => failure(cls, o),
        ensureFolder: sidecars.ensureFolder,
        ...(d.onAssetConfirmed && { onConfirmed: d.onAssetConfirmed }),
      })
    : null

  // ---- state -------------------------------------------------------------
  /** True when `working` has changes `head` does not (sync.hasUnsent against that head). */
  const differs = (head: Note, working: Note) =>
    (hasUnsentRule({ base: asS(head), working: asS(working), pendingVerify: null, unsentSidecars: [] }) as { hasUnsent?: boolean })
      .hasUnsent !== false

  const workingNote = async (noteId: string) => (await store.loadNote(noteId))?.note

  /** One `sync.json` write: `edit` changes the fields, then `event` moves the state. Logs the state change. */
  async function commit(
    noteId: string,
    edit: (c: SyncInfo, stored: { working: Note | null; base: Note | null }) => SyncInfo,
    o: { event?: string; base?: Note; unsentOf?: () => boolean; committed?: () => Promise<void>; after?: (next: SyncInfo, stored: { working: Note | null; base: Note | null }) => SyncInfo } = {},
  ): Promise<SyncInfo> {
    let from = ''
    let to = ''
    const done = await store.updateSync(
      noteId,
      (cur, stored) => {
        let next = edit(cur, stored)
        from = to = cur.state
        if (o.event) {
          let f: string = cur.state
          // A synced note that has edits is `pending` (readSync says so too).
          if (f === 'synced' && o.event === 'upload') f = 'pending'
          // A conflict note that fails was uploading: conflict -> upload -> syncing -> failed.
          if (f === 'conflict' && o.event === 'failed') f = 'syncing'
          const unresolved = next.conflicts.filter((c) => c.resolvedAt == null).length
          const t = transition(f, o.event, { unresolved, unsent: o.unsentOf?.() ?? false })
          from = cur.state === 'conflict' ? 'conflict' : f
          if (t) {
            to = t
            next = { ...next, state: t }
          }
          if (o.after) {
            next = o.after(next, stored)
            to = next.state
          }
        }
        return next
      },
      o.base ? { base: o.base } : undefined,
    )
    await o.committed?.()
    if (o.event && from !== to) await log.append('stateChange', { noteId, from, to })
    return done
  }

  // ---- the run -----------------------------------------------------------
  async function run(noteId: string, recoverOnly: boolean): Promise<UploadOutcome> {
    const s = await store.readSync(noteId)
    const working = await workingNote(noteId)
    if (!working) return 'skipped' // never touched
    const info = s.info
    if (info.state === 'error') return 'skipped'
    const unfinished = info.pendingVerify !== null
    if (recoverOnly && !unfinished) return 'skipped'
    if (!unfinished && !s.hasUnsent) return 'skipped'
    if (!d.allowed() || !d.online()) return 'skipped'
    try {
      if (info.state !== 'syncing') await commit(noteId, (c) => c, { event: 'upload' })
      // Step 0: sidecars of conflicts go before the note. A resumed upload has its own order.
      if (!unfinished) await sidecars.upload(noteId)
      // Nothing but sidecars was unsent (the receiver raised the conflict): the note itself is on Drive.
      if (!unfinished && s.base && info.fileId !== null && !differs(s.base, (await workingNote(noteId)) ?? working)) {
        await sidecarsOnlyDone(noteId, s.base)
        return 'uploaded'
      }
      await drive_(noteId, working, s)
      return 'uploaded'
    } catch (e) {
      if (e instanceof UploadFailure) {
        await fail(noteId, e.f)
        return 'failed'
      }
      if (e instanceof NoteSaveError) {
        await fail(noteId, { cls: 'fatal', reason: e.message === SYNC_UNREADABLE ? 'syncUnreadable' : 'localWrite' })
        return 'failed'
      }
      throw e
    }
  }

  /** The sidecars are on Drive and the note has nothing else to send: the upload ends as a verified one. */
  async function sidecarsOnlyDone(noteId: string, base: Note): Promise<void> {
    await commit(noteId, (c) => c, {
      event: 'verified',
      unsentOf: () => false,
    })
    // An edit may have landed meanwhile.
    const after = await workingNote(noteId)
    if (after && differs(base, after)) await commit(noteId, (c) => c, { event: 'edit' })
  }

  async function fail(noteId: string, f: Failure): Promise<void> {
    await log.append('error', {
      class: f.cls,
      noteId,
      ...(f.status !== undefined && { status: f.status }),
      ...(f.reason !== undefined && { reason: f.reason }),
    })
    try {
      await commit(
        noteId,
        (c) => ({
          ...c,
          pendingVerify: f.clearVerify ? null : c.pendingVerify,
          lastError: {
            class: f.cls,
            ...(f.status !== undefined && { status: f.status }),
            ...(f.reason !== undefined && { reason: f.reason }),
            ...(f.cls === 'unreadable' && f.head !== undefined && { head: f.head }),
          },
        }),
        { event: 'failed' },
      )
    } catch (e) {
      if (!(e instanceof NoteSaveError)) throw e
      // The state could not be written (an unreadable sync.json stays as it is); the next start repeats the step.
    }
  }

  /**
   * One Drive call with the retry rules of sync.errorClass and sync.backoff. A
   * DriveError for which `pass` is true is rethrown as it is. `beforeRetry` runs
   * after each wait, before the call is repeated: it can find that the failed call
   * did happen (a lost answer) and return its result instead.
   */
  async function call<T>(
    noteId: string,
    fn: () => Promise<T>,
    o: { pass?: (e: DriveError) => boolean; beforeRetry?: () => Promise<T | null> } = {},
  ): Promise<T> {
    let attempt = 0
    for (;;) {
      try {
        if (attempt > 0 && o.beforeRetry) {
          const done = await o.beforeRetry()
          if (done !== null) return done
        }
        return await fn()
      } catch (e) {
        if (!(e instanceof DriveError)) throw e
        if (o.pass?.(e)) throw e
        const cls = classifyDriveError(e)
        const reason = e.kind === 'parse' ? 'parse' : e.reason
        const base = { ...(e.status !== undefined && { status: e.status }), ...(reason !== undefined && { reason }) }
        if (cls !== 'backoff') throw failure(cls, base)
        attempt++
        const plan = backoffRule({ attempt, jitter: d.jitter() })
        if (!('retry' in plan) || plan.retry !== true) throw failure(cls, base)
        await log.append('backoff', { class: cls, attempt, delayMs: plan.delayMs, noteId })
        await d.sleep(plan.delayMs, noteId)
      }
    }
  }

  async function download(noteId: string, fileId: string, revision: string): Promise<Note> {
    const bytes = await call(noteId, () => drive.downloadRevision(fileId, revision))
    await log.append('revisionDownloaded', { noteId, revisionId: revision })
    const r = await decodeKkj(bytes)
    if (!r.note || r.note.noteId !== noteId) {
      throw failure('unreadable', { reason: r.result === 'unsupportedVersion' ? 'unsupportedVersion' : 'parse', head: revision })
    }
    return r.note
  }

  async function all(noteId: string, q: string): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let token: string | undefined
    do {
      const t = token
      const p = await call(noteId, () => d.drive.list(q, t ? { pageToken: t } : {}))
      out.push(...p.files)
      token = p.nextPageToken
    } while (token)
    return out
  }

  /** The kept file among several with one kkeujeokId (the earliest, drive.duplicates). */
  const keepOf = (noteId: string, found: DriveFile[]) =>
    (
      driveDuplicatesRule({
        kkeujeokId: noteId,
        items: found.map((f) => ({ id: f.id, createdTime: f.createdTime ?? LAST_RESORT_TIME })),
      }) as { keep: string }
    ).keep

  async function mergeInto(noteId: string, base: Note | null, remote: Note, head?: string): Promise<void> {
    const r = await d.merge.merge({ noteId, base, remote })
    switch (r.result) {
      case 'merged':
        await log.append('merged', { noteId })
        if (r.conflicts && r.conflicts.length > 0) {
          await commit(noteId, (c) => c, { event: 'conflictFound' }) // syncing -> conflict; the other pages go on
          for (const rev of r.conflicts) await log.append('conflictFound', conflictLogFields(noteId, rev))
        }
        return
      case 'unsupportedVersion':
        throw failure('unreadable', { reason: 'unsupportedVersion', clearVerify: true, ...(head !== undefined && { head }) })
      default:
        // The editor could not take the merge now (a stroke, leaving the note): not final.
        // The next trigger merges again and `pendingVerify` stays.
        if (r.result === 'error' && r.reason === 'applyFailed') throw failure('backoff', { reason: 'mergeDeferred' })
        throw failure('fatal', { reason: 'mergeFailed', clearVerify: true })
    }
  }

  async function drive_(noteId: string, working0: Note, s: Awaited<ReturnType<NoteStore['readSync']>>): Promise<void> {
    let info = s.info
    const baseNote = s.base
    let fileId = info.fileId
    let parent: string | null = null
    let round = 1
    let ours: string | null = null
    let uploaded: Note | null = null
    let skipPre = false
    // Revisions this session uploaded: never a candidate of a verify round.
    const own = new Set<string>()
    let moved = 0

    // "Start": an unfinished upload.
    const pv = info.pendingVerify
    if (pv) {
      const o = (pv.oursRevisionId as string | null | undefined) ?? null
      if (o !== null && fileId !== null) {
        ours = o
        parent = (pv.parentRevisionId as string | null | undefined) ?? null
        round = pv.round as number
        uploaded = await download(noteId, fileId, o)
      } else if (info.resumableSession) {
        const session = info.resumableSession as { uri: string; size: number }
        try {
          const r = await call(noteId, () => drive.putResumable(session.uri, session.size, 0, null), {
            pass: (e) => e.kind === 'http' && (e.status === 404 || e.status === 410),
          })
          if (r.file?.headRevisionId) {
            const f = r.file
            fileId = f.id
            ours = f.headRevisionId!
            parent = (pv.parentRevisionId as string | null | undefined) ?? null
            round = pv.round as number
            const rev = ours
            info = await commit(noteId, (c) => ({
              ...c,
              fileId: f.id,
              pendingVerify: { ...c.pendingVerify, oursRevisionId: rev },
              resumableSession: null,
            }))
            uploaded = await download(noteId, f.id, rev)
          }
        } catch (e) {
          if (!(e instanceof DriveError)) throw e // 404 or 410: the session is gone
        }
        // A session that is not finished is not continued: the bytes it was given are
        // not kept, so the upload starts again at step 1.
      }
    }

    for (;;) {
      if (ours === null) {
        if (!skipPre) {
          // Step 1.
          if (fileId === null) {
            const root = (await d.device.read()).rootFolderId
            let intent = info.createIntent
            if (intent === null) {
              if (root === null) throw failure('fatal', { reason: 'rootMissing' })
              const made: JsonMap = { kkeujeokId: noteId, parentId: root }
              intent = made
              info = await commit(noteId, (c) => ({ ...c, createIntent: made }))
            }
            const found = await all(noteId, kkeujeokIdQuery(noteId))
            if (found.length > 0) {
              const keep = keepOf(noteId, found)
              if (found.length > 1) await log.append('duplicatesCleaned', { count: found.length - 1 })
              fileId = keep
              info = await commit(noteId, (c) => ({ ...c, fileId: keep }))
            }
          }
          if (fileId !== null) {
            const id = fileId
            const f = await call(noteId, () => drive.get(id, { fields: 'headRevisionId,trashed' }))
            if (f.trashed) throw failure('deleted', { reason: 'trashed' })
            const head = f.headRevisionId
            if (!head) throw failure('fatal', { reason: 'noRevisionId' })
            parent = head
            if (head !== info.baseHeadRevisionId) {
              const remote = await download(noteId, id, head)
              const now = (await workingNote(noteId)) ?? working0
              if (!differs(remote, now)) {
                // Our own upload from before a crash is already there.
                ours = head
                uploaded = remote
                parent = info.baseHeadRevisionId
                round = 1
                const p = parent
                info = await commit(noteId, (c) => ({
                  ...c,
                  pendingVerify: { parentRevisionId: p, oursRevisionId: head, round: 1 },
                }))
              } else {
                await mergeInto(noteId, baseNote, remote, head)
              }
            } else if (baseNote) {
              // Head == base: the merge still gives a page changed here its lineage.
              await mergeInto(noteId, baseNote, baseNote)
            }
          } else {
            parent = null
          }
        }
        if (ours === null) {
          // Step 2, after the sidecars a merge may just have raised (step 0).
          await sidecars.upload(noteId)
          // The note whose assets were just checked is the one that goes up: an edit after that waits for the next upload.
          const read = async () => (await workingNote(noteId)) ?? working0
          const snapshot = assetUp ? await assetUp.send(noteId, read) : await read()
          const fid = fileId
          const par = parent
          const up = await send(noteId, {
            fileId,
            snapshot,
            parent,
            round,
            intent: info.createIntent,
            // Just before the PATCH: the head is still what the merge used (or a revision of this session).
            headStill:
              fid === null
                ? undefined
                : async () => {
                    const h = (await call(noteId, () => drive.get(fid, { fields: 'headRevisionId' }))).headRevisionId
                    // A missing head (null or undefined) is no move.
                    return h == null || h === par || own.has(h)
                  },
          })
          if (up === null) {
            // Drive has no If-Match: the head moved, so merge again first.
            if (++moved > 3) throw failure('backoff', { reason: 'headMoved' })
            await log.append('error', { class: 'backoff', noteId, reason: 'headMoved' })
            skipPre = false
            continue
          }
          fileId = up.fileId
          ours = up.ours
          uploaded = up.note
          own.add(up.ours)
        }
      }

      // Step 3.
      const id = fileId!
      own.add(ours)
      const again = await verify(noteId, id, { parent, ours, round, baseNote, own })
      if (again === null) {
        await finish(noteId, id, ours, uploaded!)
        return
      }
      parent = again.parent
      round = again.round
      ours = null
      uploaded = null
      skipPre = true
    }
  }

  /** Step 2: one request that carries content, name and summary. */
  async function send(
    noteId: string,
    a: { fileId: string | null; snapshot: Note; parent: string | null; round: number; intent: JsonMap | null; headStill?: () => Promise<boolean> },
  ): Promise<{ fileId: string; ours: string; note: Note } | null> {
    const { fileId, snapshot, parent, round } = a
    const bytes = await encodeKkj(snapshot)
    const sum = md5(bytes)
    const summary = listSummaryRule({ op: 'write', note: snapshot, md5: sum }) as {
      error?: string
      name: string
      appProperties: Record<string, string | null>
      thumbnail: { width: number; height: number } | null
    }
    if (summary.error) throw failure('fatal', { reason: summary.error })
    let png: Uint8Array | null = null
    const hint = summary.thumbnail
    if (hint && d.thumbnail && snapshot.pages.length > 0) {
      try {
        png = await d.thumbnail(snapshot.pages[0]!, hint.width, hint.height)
      } catch {
        png = null
      }
      // Over the limit of drive-layout it is not written at all.
      if (png && png.length > MAX_THUMBNAIL_BYTES) png = null
    }
    // ponytail: with no thumbnail an update sends no `contentHints`, so Drive keeps the
    // previous thumbnail while name and properties are new; Drive cannot delete a hint.
    const metadata: Record<string, unknown> = {
      name: summary.name,
      appProperties: { ...summary.appProperties },
      ...(png && { contentHints: { thumbnail: { image: toBase64Url(png), mimeType: 'image/png' } } }),
      ...(fileId === null && { mimeType: KKJ_MIME, parents: [a.intent?.parentId] }),
    }

    if (a.headStill && !(await a.headStill())) return null
    // The intent of this upload is stored before the request goes out.
    await commit(noteId, (c) => ({
      ...c,
      pendingVerify: { parentRevisionId: parent, oursRevisionId: null, round },
      resumableSession: null,
    }))
    // The whole multipart body counts, the metadata with its thumbnail too.
    const total = bytes.length + new TextEncoder().encode(JSON.stringify(metadata)).length
    const kind = (uploadKindRule({ size: total }) as { kind: 'simple' | 'resumable' }).kind
    await log.append('uploadStarted', { noteId, kind })
    let file: DriveFile
    if (kind === 'simple') {
      file = await call(noteId, () => drive.uploadSimple({ ...(fileId !== null && { fileId }), metadata, bytes }), {
        // A create whose answer was lost may have happened: look for the file by its kkeujeokId first. An
        // update whose answer was lost may have landed: its head's md5 says so.
        beforeRetry: fileId === null ? () => adopt(noteId, sum) : () => landed(noteId, fileId, sum, a.parent),
      })
    } else {
      file = await resumable(noteId, fileId, metadata, bytes)
    }
    const head = file.headRevisionId
    if (!head) throw failure('fatal', { reason: 'noRevisionId' })
    if (file.md5Checksum !== undefined && file.md5Checksum !== sum) throw failure('fatal', { reason: 'md5Mismatch' })
    await log.append('uploadFinished', { noteId, revisionId: head })
    await commit(noteId, (c) => ({
      ...c,
      fileId: file.id,
      pendingVerify: { parentRevisionId: parent, oursRevisionId: head, round },
      resumableSession: null,
    }))
    return { fileId: file.id, ours: head, note: snapshot }
  }

  /** The earliest file with this note's kkeujeokId when its content is `sum` (it is ours), else null. */
  async function adopt(noteId: string, sum: string): Promise<DriveFile | null> {
    const found = await all(noteId, kkeujeokIdQuery(noteId))
    if (found.length === 0) return null
    if (found.length > 1) await log.append('duplicatesCleaned', { count: found.length - 1 })
    return landed(noteId, keepOf(noteId, found), sum, null)
  }

  /** The file `id` when its head holds `sum` (the lost request did happen), else null. */
  /** The file [id] when its head holds [sum] and is not [parent] (the lost request did happen). */
  async function landed(noteId: string, id: string, sum: string, parent: string | null): Promise<DriveFile | null> {
    const f = await call(noteId, () => drive.get(id, { fields: 'id,headRevisionId,md5Checksum' }))
    return f.headRevisionId != null && f.headRevisionId !== parent && f.md5Checksum === sum ? f : null
  }

  async function resumable(noteId: string, fileId: string | null, metadata: Record<string, unknown>, bytes: Uint8Array): Promise<DriveFile> {
    const gone = (e: DriveError) => e.kind === 'http' && (e.status === 404 || e.status === 410)
    const size = bytes.length
    const chunk = d.chunkSize ?? RESUMABLE_CHUNK
    for (let start = 0; start < 3; start++) {
      const uri = await call(noteId, () => drive.startResumable({ ...(fileId !== null && { fileId }), metadata, size }))
      await commit(noteId, (c) => ({ ...c, resumableSession: { uri, size } }))
      let offset = 0 // what Drive holds
      let stalled = 0
      try {
        while (stalled < 3) {
          const r: ResumableResult = await call(
            noteId,
            () => {
              const end = Math.min(offset + chunk, size)
              return drive.putResumable(uri, size, offset, bytes.subarray(offset, end))
            },
            {
              pass: gone,
              // A chunk that timed out may have arrived: ask where Drive is.
              beforeRetry: async () => {
                const q = await drive.putResumable(uri, size, 0, null)
                offset = Math.min(q.received, size)
                return q.file ? q : null
              },
            },
          )
          if (r.file) return r.file
          // 308: Drive holds `received` bytes, never trusted past that.
          if (r.received >= size) break // all sent, no file: a new session
          stalled = r.received > offset ? 0 : stalled + 1
          offset = r.received
        }
      } catch (e) {
        if (!(e instanceof DriveError) || !gone(e)) throw e
      }
      // The session is gone or went nowhere: again from byte 0.
    }
    throw failure('fatal', { reason: 'sessionLost' })
  }

  /** Step 3. Null when verified; else what the next upload round needs. */
  async function verify(
    noteId: string,
    fileId: string,
    a: { parent: string | null; ours: string; round: number; baseNote: Note | null; own: Set<string> },
  ): Promise<{ parent: string; round: number } | null> {
    const plan = await call(noteId, async () => {
      // An `invalidInput` plan is asked once more without using a backoff attempt; a
      // second one counts as a network failure.
      for (let again = 0; again < 2; again++) {
        const head = (await drive.get(fileId, { fields: 'headRevisionId' })).headRevisionId
        const revs = await drive.listRevisions(fileId)
        // Revisions of this session (not `ours` of this round, the rule drops that) are ours too, not another device's.
        const mine = revs.filter((r) => r.id === a.ours || r.id === head || !a.own.has(r.id))
        const p = verifyPlanRule({ base: a.parent, ours: a.ours, revisions: mine, head, round: a.round })
        if (!('error' in p)) return p
        // The listing may not have caught up: wait before asking again.
        const w = backoffRule({ attempt: 1, jitter: d.jitter() })
        await d.sleep('delayMs' in w ? w.delayMs : 1000, noteId)
      }
      throw new DriveError('network')
    })
    await log.append('verifyRound', { noteId, round: a.round, count: 'download' in plan ? plan.download.length : 0 })
    if (!('result' in plan)) throw failure('fatal', { reason: 'verifyExhausted', clearVerify: true })
    switch (plan.result) {
      case 'verified':
        return null
      case 'merge': {
        for (const id of plan.download) await mergeInto(noteId, a.baseNote, await download(noteId, fileId, id))
        return { parent: plan.download[plan.download.length - 1]!, round: a.round + 1 }
      }
      default:
        throw failure('fatal', { reason: 'verifyExhausted', clearVerify: true })
    }
  }

  /** Step 5: the base moves together with everything that goes with it. */
  async function finish(noteId: string, fileId: string, ours: string, uploaded: Note): Promise<void> {
    const working = await workingNote(noteId)
    let unsidecars = false
    await commit(
      noteId,
      (c) => {
        unsidecars = c.unsentSidecars.length > 0
        return {
          ...c,
          fileId,
          baseHeadRevisionId: ours,
          pendingVerify: null,
          resumableSession: null,
          createIntent: null,
          lastError: null,
        }
      },
      {
        event: 'verified',
        base: uploaded,
        unsentOf: () => !working || differs(uploaded, working) || unsidecars,
        committed: async () => void (await log.append('baseAdvanced', { noteId, revisionId: ours })),
      },
    )
    // An edit may have landed between the read above and the commit: look again, now
    // that the base is the uploaded note.
    const after = await workingNote(noteId)
    if (after && differs(uploaded, after)) await commit(noteId, (c) => c, { event: 'edit' })
  }

  // ---- resolved conflicts (Story 3.22) -------------------------------------
  const sameEntry = (a: JsonMap, b: JsonMap) => a.pageId === b.pageId && a.rev === b.rev
  const sidecarId = (noteId: string, c: JsonMap) => `sc:${noteId}:${String(c.pageId)}:${String(c.rev)}`

  /** A failure of the best-effort sidecar work: logged, never thrown; the next call tries again. */
  async function ignored(noteId: string, e: unknown): Promise<void> {
    try {
      const f = e instanceof UploadFailure ? e.f : { cls: 'fatal', reason: 'sidecarSync' }
      await log.append('error', {
        class: f.cls,
        noteId,
        ...(f.status !== undefined && { status: f.status }),
        ...(f.reason !== undefined && { reason: f.reason }),
      })
    } catch {
      // the log is not writable: nothing more to do
    }
  }

  /** Sets a local flag key on the entry of a conflict. */
  const flag = (noteId: string, c: JsonMap, key: string) =>
    store.updateSync(noteId, (cur) => ({ ...cur, conflicts: cur.conflicts.map((e) => (sameEntry(e, c) ? { ...e, [key]: true } : e)) }))

  /**
   * A conflict was settled: its entry takes `conflict` (with `resolvedAt`) and the state takes the event `resolve`, in
   * ONE `sync.json` write. The resolved note must be saved before this runs. Throws when `sync.json` cannot be
   * written or has no such unresolved conflict. Answers the record as committed.
   */
  async function resolved(noteId: string, conflict: JsonMap): Promise<SyncInfo> {
    return commit(
      noteId,
      (c) => {
        if (!c.conflicts.some((e) => sameEntry(e, conflict) && e.resolvedAt == null)) throw new NoteSaveError('no such conflict')
        return { ...c, conflicts: c.conflicts.map((e) => (sameEntry(e, conflict) && e.resolvedAt == null ? { ...conflict } : e)) }
      },
      {
        event: 'resolve',
        // Nothing unsent after the resolve (the other device's deleted page removed): saved, not pending. Decided from
        // the records of the same transaction.
        after: (n, s) => {
          const base = n.baseHeadRevisionId === null ? null : s.base
          const unsent =
            !s.working ||
            (hasUnsentRule({ base, working: s.working, pendingVerify: n.pendingVerify, unsentSidecars: n.unsentSidecars }) as { hasUnsent?: boolean }).hasUnsent !== false
          return n.state === 'pending' && !unsent && !n.conflicts.some((e) => e.resolvedAt == null) ? { ...n, state: 'synced' } : n
        },
      },
    )
  }

  /**
   * Sets `kkjResolved` on the sidecar files of resolved conflicts once the resolving upload is verified (nothing
   * unsent). A conflict is flagged only when its sidecar was found on Drive; its local record goes then. A failure
   * is logged per conflict and retried at the next call. Never throws.
   */
  async function markResolved(noteId: string): Promise<void> {
    let todo: JsonMap[]
    try {
      const s = await store.readSync(noteId)
      todo = s.info.conflicts.filter((c) => c.resolvedAt != null && c.sidecarMarked !== true)
      if (todo.length === 0 || s.hasUnsent || s.info.state === 'error') return
      if (!d.allowed() || !d.online()) return
    } catch (e) {
      return ignored(noteId, e)
    }
    for (const c of todo) {
      try {
        const at = String(c.resolvedAt)
        const files = await all(noteId, kkeujeokIdQuery(sidecarId(noteId, c)))
        for (const f of files) {
          if (f.appProperties.kkjResolved === at) continue
          await call(noteId, () => drive.update(f.id, { appProperties: { kkjResolved: at } }))
        }
        if (files.length > 0) {
          await flag(noteId, c, 'sidecarMarked')
          await store.sidecars.delete(noteId, String(c.pageId), String(c.rev))
        }
      } catch (e) {
        await ignored(noteId, e)
      }
    }
  }

  /** App start: sidecars resolved more than 30 days ago go to the Drive trash (no hard delete). Best effort, never throws. */
  async function cleanResolvedSidecars(noteIds: Iterable<string>): Promise<void> {
    const limit = new Date((d.now ?? Date.now)() - SIDECAR_KEEP_MS).toISOString()
    for (const noteId of noteIds) {
      await chained(noteId, async () => {
        let todo: JsonMap[]
        try {
          const s = await store.readSync(noteId)
          // Canonical timestamps compare as text.
          todo = s.info.conflicts.filter((c) => typeof c.resolvedAt === 'string' && c.resolvedAt <= limit && c.sidecarTrashed !== true)
          if (todo.length === 0 || !d.allowed() || !d.online()) return
        } catch (e) {
          return ignored(noteId, e)
        }
        for (const c of todo) {
          try {
            const files = await all(noteId, kkeujeokIdQuery(sidecarId(noteId, c)))
            for (const f of files) await call(noteId, () => drive.update(f.id, { trashed: true }))
            if (files.length > 0) {
              await flag(noteId, c, 'sidecarTrashed')
              await store.sidecars.delete(noteId, String(c.pageId), String(c.rev))
            }
          } catch (e) {
            await ignored(noteId, e)
          }
        }
      })
    }
  }

  // ---- restore (Story 3.25) ---------------------------------------------------
  /**
   * Restore step 2: uploads `noteId` until `verified`, also when nothing is unsent (then it only confirms that Drive's
   * head is the base). Answers the revision id that holds the state now (the `baseHeadRevisionId` after the commit),
   * or null when it could not be reached; a failure is in `sync.json` and the log like any upload error.
   */
  async function verifiedHead(noteId: string): Promise<string | null> {
    try {
      const s = await store.readSync(noteId)
      if (s.info.state === 'error') return null
      if (s.hasUnsent || s.info.pendingVerify !== null) {
        if ((await run(noteId, false)) !== 'uploaded') return null
        return (await store.readSync(noteId)).info.baseHeadRevisionId
      }
      const { baseHeadRevisionId: base, fileId } = s.info
      if (base === null || fileId === null) return null
      if (!d.allowed() || !d.online()) return null
      const f = await call(noteId, () => drive.get(fileId, { fields: 'headRevisionId,trashed' }))
      if (f.trashed) throw failure('deleted', { reason: 'trashed' })
      // Another device's newer head is not the state to pin.
      return f.headRevisionId === base ? base : null
    } catch (e) {
      if (e instanceof UploadFailure) {
        await fail(noteId, e.f)
        return null
      }
      if (e instanceof NoteSaveError) return null
      throw e
    }
  }

  /** A Drive call outside the upload failed (the pin of a restore): handled as a sync error of the note, like an upload failure. */
  async function failed(noteId: string, e: DriveError): Promise<void> {
    try {
      await fail(noteId, { cls: classifyDriveError(e), ...(e.status !== undefined && { status: e.status }), ...((e.kind === 'parse' ? 'parse' : e.reason) !== undefined && { reason: e.kind === 'parse' ? 'parse' : e.reason }) })
    } catch {
      // the log or sync.json is not writable: nothing more to do here
    }
  }

  /** Story 7.8: the person deleted the note; the library hides it and every trigger runs `trashNote` until it is done. */
  async function markTrash(noteId: string): Promise<boolean> {
    try {
      await store.updateSync(noteId, (c) => ({ ...c, extra: { ...c.extra, [PENDING_TRASH]: true } }))
      return true
    } catch (e) {
      if (e instanceof NoteSaveError) return false
      throw e
    }
  }

  /** Sends what is unsent, trashes the Drive file, removes the local note. False while it must wait; the mark stays. */
  async function trashNote(noteId: string): Promise<boolean> {
    try {
      let s = await store.readSync(noteId)
      if (s.hasUnsent || s.info.pendingVerify !== null) {
        if ((await run(noteId, false)) !== 'uploaded') return false
        s = await store.readSync(noteId)
        if (s.hasUnsent || s.info.pendingVerify !== null) return false
      }
      const { fileId } = s.info
      if (fileId !== null) {
        if (!d.allowed() || !d.online()) return false
        try {
          await call(noteId, () => drive.update(fileId, { trashed: true }), { pass: (e) => e.status === 404 })
        } catch (e) {
          if (!(e instanceof DriveError)) throw e // 404: already gone
        }
      }
      const note = await workingNote(noteId)
      return !note || (await store.removeNote(noteId, note))
    } catch (e) {
      if (e instanceof UploadFailure) {
        await fail(noteId, e.f)
        return false
      }
      if (e instanceof NoteSaveError) return false
      throw e
    }
  }

  return {
    markTrash: (noteId: string) => chained(noteId, () => markTrash(noteId)),
    trashNote: (noteId: string) => chained(noteId, () => trashNote(noteId)),
    uploadVerified: (noteId: string) => chained(noteId, () => verifiedHead(noteId)),
    reportFailure: (noteId: string, e: DriveError) => chained(noteId, () => failed(noteId, e)),
    /** A conflict was settled in the editor (chained with this note's uploads). */
    conflictResolved: (noteId: string, conflict: JsonMap) => chained(noteId, () => resolved(noteId, conflict)),
    markResolved: (noteId: string) => chained(noteId, () => markResolved(noteId)),
    cleanResolvedSidecars,
    /** Uploads `noteId` when it has unsent changes or an unfinished upload. */
    upload: (noteId: string) => chained(noteId, () => run(noteId, false)),
    /** "Start": finishes an interrupted upload (`pendingVerify` set); a note without one is left to `upload`. */
    resume: (noteId: string) => chained(noteId, () => run(noteId, true)),
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_')
}
