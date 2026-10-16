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
import { classifyDriveError } from './errorClass'
import { hasUnsentRule } from './hasUnsent'
import type { MergeIo } from './mergeIo'
import { chained } from './noteChain'
import type { SyncLog } from './syncLog'
import { backoffRule, transition, uploadKindRule, verifyPlanRule } from './syncRules'

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
  device: Pick<SyncDeviceStore, 'read'>
  log: Pick<SyncLog, 'append'>
  merge: MergeIo
  /** The upload gate: root folder ready. */
  allowed: () => boolean
  /** False while the browser knows it is offline: no request is made. */
  online: () => boolean
  sleep: (ms: number) => Promise<void>
  /** A number in [0, 1] for `sync.backoff`. */
  jitter: () => number
  /** PNG of a page at the size the summary names; null when it cannot be drawn. */
  thumbnail?: (page: Page, width: number, height: number) => Promise<Uint8Array | null>
  md5?: (bytes: Uint8Array) => string
  /** Resumable chunk size (a multiple of 262,144); the spec value by default. */
  chunkSize?: number
}

export type NoteUploader = ReturnType<typeof createNoteUploader>

const asS = (n: Note) => ({ orderRev: n.orderRev, metaRev: n.metaRev, pages: n.pages })

export function createNoteUploader(d: UploaderDeps) {
  const { store, drive, log } = d
  const md5 = d.md5 ?? md5Hex

  // ---- state -------------------------------------------------------------
  /** True when `working` has changes `head` does not (sync.hasUnsent against that head). */
  const differs = (head: Note, working: Note) =>
    (hasUnsentRule({ base: asS(head), working: asS(working), pendingVerify: null, unsentSidecars: [] }) as { hasUnsent?: boolean })
      .hasUnsent !== false

  const workingNote = async (noteId: string) => (await store.loadNote(noteId))?.note

  /** One `sync.json` write: `edit` changes the fields, then `event` moves the state. Logs the state change. */
  async function commit(
    noteId: string,
    edit: (c: SyncInfo) => SyncInfo,
    o: { event?: string; base?: Note; unsentOf?: () => boolean; committed?: () => Promise<void> } = {},
  ): Promise<SyncInfo> {
    let from = ''
    let to = ''
    const done = await store.updateSync(
      noteId,
      (cur) => {
        let next = edit(cur)
        from = to = cur.state
        if (o.event) {
          let f: string = cur.state
          // A synced note that has edits is `pending` (readSync says so too).
          if (f === 'synced' && o.event === 'upload') f = 'pending'
          const unresolved = next.conflicts.filter((c) => c.resolvedAt == null).length
          const t = transition(f, o.event, { unresolved, unsent: o.unsentOf?.() ?? false })
          from = f
          if (t) {
            to = t
            next = { ...next, state: t }
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
        await d.sleep(plan.delayMs)
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
        return
      case 'conflict':
        throw failure('fatal', { reason: 'conflictPending', clearVerify: true })
      case 'unsupportedVersion':
        throw failure('unreadable', { reason: 'unsupportedVersion', clearVerify: true, ...(head !== undefined && { head }) })
      default:
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
          // Step 2.
          const snapshot = (await workingNote(noteId)) ?? working0
          const up = await send(noteId, { fileId, snapshot, parent, round, intent: info.createIntent })
          fileId = up.fileId
          ours = up.ours
          uploaded = up.note
        }
      }

      // Step 3.
      const id = fileId!
      const again = await verify(noteId, id, { parent, ours, round, baseNote })
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
    a: { fileId: string | null; snapshot: Note; parent: string | null; round: number; intent: JsonMap | null },
  ): Promise<{ fileId: string; ours: string; note: Note }> {
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
        // A create whose answer was lost may have happened: look for the file by its kkeujeokId first.
        ...(fileId === null && { beforeRetry: () => adopt(noteId) }),
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

  /** The earliest file with this note's kkeujeokId (with its head and md5), or null. */
  async function adopt(noteId: string): Promise<DriveFile | null> {
    const found = await all(noteId, kkeujeokIdQuery(noteId))
    if (found.length === 0) return null
    if (found.length > 1) await log.append('duplicatesCleaned', { count: found.length - 1 })
    const keep = keepOf(noteId, found)
    return call(noteId, () => drive.get(keep, { fields: 'id,headRevisionId,md5Checksum' }))
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
    a: { parent: string | null; ours: string; round: number; baseNote: Note | null },
  ): Promise<{ parent: string; round: number } | null> {
    const plan = await call(noteId, async () => {
      // An `invalidInput` plan is asked once more without using a backoff attempt; a
      // second one counts as a network failure.
      for (let again = 0; again < 2; again++) {
        const head = (await drive.get(fileId, { fields: 'headRevisionId' })).headRevisionId
        const revs = await drive.listRevisions(fileId)
        const p = verifyPlanRule({ base: a.parent, ours: a.ours, revisions: revs, head, round: a.round })
        if (!('error' in p)) return p
        // The listing may not have caught up: wait before asking again.
        const w = backoffRule({ attempt: 1, jitter: d.jitter() })
        await d.sleep('delayMs' in w ? w.delayMs : 1000)
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

  return {
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
