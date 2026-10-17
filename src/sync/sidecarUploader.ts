// Uploads the conflict sidecars of a note (spec sync.md "Upload" step 0, drive-layout.md "Layout",
// "Sidecar properties" and "Idempotent creation"). Every item is found by `appProperties.kkeujeokId`,
// never by name. A local sidecar record is removed only after the file on Drive is confirmed.
import { DriveError, type DriveClient, type DriveFile, childrenQuery, kkeujeokIdQuery } from '../drive/driveClient'
import { driveDuplicatesRule } from '../drive/duplicates'
import type { NoteStore } from '../storage/noteStore'
import type { SyncDeviceStore } from '../storage/syncDevice'
import type { SyncLog } from './syncLog'

export const CONFLICTS_KKEUJEOK_ID = 'conflicts'
export const CONFLICTS_FOLDER_NAME = '.conflicts'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const LAST_RESORT_TIME = '9999-12-31T23:59:59.999Z'
const MAX_LIST_PAGES = 10

/** The uploader's retry wrapper and failure maker, injected so one set of retry rules exists. */
export type CallFn = <T>(noteId: string, fn: () => Promise<T>, o?: { pass?: (e: DriveError) => boolean; beforeRetry?: () => Promise<T | null> }) => Promise<T>

export type SidecarUploaderDeps = {
  drive: DriveClient
  device: Pick<SyncDeviceStore, 'read' | 'update'>
  store: Pick<NoteStore, 'readSync' | 'sidecars' | 'sidecarSent'>
  log: Pick<SyncLog, 'append'>
  md5: (bytes: Uint8Array) => string
  call: CallFn
  /** Makes the error the uploader turns into a `failed` event. */
  failure: (cls: string, o?: { reason?: string }) => Error
}

export function createSidecarUploader(d: SidecarUploaderDeps) {
  const { drive, log } = d

  async function listAll(noteId: string, q: string): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let token: string | undefined
    for (let i = 0; i < MAX_LIST_PAGES; i++) {
      const t = token
      const p = await d.call(noteId, () => drive.list(q, t ? { pageToken: t } : {}))
      out.push(...p.files)
      token = p.nextPageToken
      if (!token) break
    }
    return out
  }

  const intent = (id: string, kind: string, parentId: string) =>
    d.device.update((dev) => ({ ...dev, createIntents: [...dev.createIntents.filter((i) => i.kkeujeokId !== id), { kkeujeokId: id, kind, parentId }] }))
  const clearIntent = (id: string) => d.device.update((dev) => ({ ...dev, createIntents: dev.createIntents.filter((i) => i.kkeujeokId !== id) }))

  /** The kept file of several with one `kkeujeokId` (drive.duplicates); `others` are returned for cleanup. */
  function pick(id: string, found: DriveFile[]): { keep: string; others: string[] } {
    const r = driveDuplicatesRule({ kkeujeokId: id, items: found.map((f) => ({ id: f.id, createdTime: f.createdTime ?? LAST_RESORT_TIME })) })
    if ('error' in r || r.keep === null) throw d.failure('fatal', { reason: 'noItems' })
    return { keep: r.keep, others: r.merge }
  }

  /** Duplicate folders: children move into the kept one, the duplicate is trashed last. */
  async function cleanFolders(noteId: string, keep: string, others: string[]): Promise<void> {
    for (const dup of others) {
      for (const c of await listAll(noteId, childrenQuery(dup))) {
        await d.call(noteId, () => drive.update(c.id, { addParents: keep, removeParents: dup }))
      }
      await d.call(noteId, () => drive.update(dup, { trashed: true }))
    }
    if (others.length > 0) await log.append('duplicatesCleaned', { count: others.length })
  }

  /** One folder by idempotent creation. */
  async function ensureFolder(noteId: string, kkeujeokId: string, name: string, parentId: string): Promise<string> {
    await intent(kkeujeokId, 'folder', parentId)
    const q = kkeujeokIdQuery(kkeujeokId)
    let found = await listAll(noteId, q)
    let id: string | undefined
    if (found.length === 0) {
      const created = await d.call(noteId, () =>
        drive.create({ name, mimeType: FOLDER_MIME, parents: [parentId], appProperties: { kkeujeokId } }),
      )
      found = await listAll(noteId, q)
      if (found.length === 0) id = created.id // the listing lags behind the create
    }
    if (id === undefined) {
      const { keep, others } = pick(kkeujeokId, found)
      await cleanFolders(noteId, keep, others)
      id = keep
    }
    await clearIntent(kkeujeokId)
    return id
  }

  /** `.conflicts`: the cached id when it is alive, else found or created. */
  async function conflictsFolder(noteId: string): Promise<string> {
    const dev = await d.device.read()
    const root = dev.rootFolderId
    if (root === null) throw d.failure('fatal', { reason: 'rootMissing' })
    if (dev.conflictsFolderId !== null) {
      const cached = dev.conflictsFolderId
      const alive = await d
        .call(noteId, () => drive.get(cached, { fields: 'id,trashed' }), { pass: (e) => e.kind === 'http' && e.status === 404 })
        .then((f) => !f.trashed)
        .catch((e: unknown) => {
          if (e instanceof DriveError && e.kind === 'http' && e.status === 404) return false // 404: the folder is gone
          throw e
        })
      if (alive) return cached
    }
    const id = await ensureFolder(noteId, CONFLICTS_KKEUJEOK_ID, CONFLICTS_FOLDER_NAME, root)
    await d.device.update((x) => ({ ...x, conflictsFolderId: id }))
    return id
  }

  /** Uploads every sidecar of `unsentSidecars`, one after the other; throws on the first failure. */
  async function upload(noteId: string): Promise<void> {
    let folder: string | null = null
    for (;;) {
      const info = (await d.store.readSync(noteId)).info
      const next = info.unsentSidecars[0]
      if (!next) return
      const pageId = String(next.pageId)
      const rev = String(next.rev)
      const rec = await d.store.sidecars.get(noteId, pageId, rev)
      if (!rec) {
        // Nothing to send: the entry would block the note for ever.
        await log.append('error', { class: 'fatal', noteId, reason: 'sidecarMissing' })
        await d.store.sidecarSent(noteId, pageId, rev)
        continue
      }
      folder ??= await ensureFolder(noteId, `cf:${noteId}`, noteId, await conflictsFolder(noteId))
      const kid = `sc:${noteId}:${pageId}:${rev}`
      await intent(kid, 'sidecar', folder)
      const q = kkeujeokIdQuery(kid)
      let found = await listAll(noteId, q)
      if (found.length === 0) {
        const entry = info.conflicts.find((c) => c.pageId === pageId && c.rev === rev)
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            noteId: rec.noteId, pageId: rec.pageId, rev: rec.rev, seq: rec.seq,
            editedAt: rec.editedAt, editedBy: rec.editedBy, kind: rec.kind, page: rec.page,
          }),
        )
        const sum = d.md5(bytes)
        const metadata = {
          name: `${pageId}-${rev}.json`,
          mimeType: 'application/json',
          parents: [folder],
          appProperties: {
            kkeujeokId: kid,
            kkjEdited: rec.editedAt,
            kkjIndex: String(typeof entry?.originalIndex === 'number' ? entry.originalIndex : 0),
            ...(typeof entry?.resolvedAt === 'string' && { kkjResolved: entry.resolvedAt }),
          },
        }
        const file = await d.call(noteId, () => drive.uploadSimple({ metadata, bytes }), {
          // A create whose answer was lost may have happened: look for it first.
          beforeRetry: async () => {
            const again = await listAll(noteId, q)
            return again.length === 0 ? null : again[0]!
          },
        })
        if (file.md5Checksum !== undefined && file.md5Checksum !== sum) throw d.failure('fatal', { reason: 'md5Mismatch' })
        found = await listAll(noteId, q)
        if (found.length === 0) found = [file] // the listing lags behind the create
      }
      if (found.length > 1) {
        const { others } = pick(kid, found)
        for (const o of others) await d.call(noteId, () => drive.update(o, { trashed: true }))
        await log.append('duplicatesCleaned', { count: others.length })
      }
      // Confirmed: the file exists. Only now does the device let go of it.
      await d.store.sidecarSent(noteId, pageId, rev)
      await clearIntent(kid)
    }
  }

  return { upload }
}
