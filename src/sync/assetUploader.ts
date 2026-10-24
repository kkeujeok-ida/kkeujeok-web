// Puts the image assets a note references on Drive before the note (spec image.md "Upload order", drive-layout.md
// "Idempotent creation"). Port of `_sendAssets` of kkeujeok-client/lib/sync/note_uploader.dart. An asset is found by
// `appProperties.kkeujeokId = "asset:<sha256>"`, never by name, and never deleted.
import { RESUMABLE_CHUNK, type DriveClient, type DriveFile, kkeujeokIdQuery } from '../drive/driveClient'
import type { Note } from '../model/note'
import { imageUploadPlan, isAssetHash, referencedAssets } from '../model/imageRules'
import type { AssetStore } from '../storage/assetStore'
import type { SyncDeviceStore } from '../storage/syncDevice'
import { SIMPLE_MAX } from './syncRules'
import type { CallFn } from './sidecarUploader'

export const ASSETS_KKEUJEOK_ID = 'assets'
const ASSETS_FOLDER_NAME = '.assets'
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
/** The note is looked at again this many times when it was edited while the assets went. */
const ROUNDS = 3

export type AssetUploaderDeps = {
  drive: DriveClient
  device: Pick<SyncDeviceStore, 'read'>
  assets: AssetStore
  md5: (bytes: Uint8Array) => string
  call: CallFn
  failure: (cls: string, o?: { reason?: string }) => Error
  ensureFolder: (noteId: string, kkeujeokId: string, name: string, parentId: string) => Promise<string>
  /** Drive holds this asset (checked or just uploaded). */
  onConfirmed?: (hash: string) => void
}

export function createAssetUploader(d: AssetUploaderDeps) {
  const { drive } = d

  const find = (noteId: string, hash: string) =>
    d.call(noteId, () => drive.list(kkeujeokIdQuery(`asset:${hash}`), { fields: 'files(id,size,md5Checksum)' })).then((p) => p.files)

  const same = (f: DriveFile, bytes: Uint8Array) => f.size === bytes.length && f.md5Checksum === d.md5(bytes)

  async function put(noteId: string, folder: string, hash: string, ext: string, bytes: Uint8Array): Promise<void> {
    const metadata = {
      name: `${hash}.${ext}`,
      mimeType: MIME[ext] ?? 'application/octet-stream',
      parents: [folder],
      appProperties: { kkeujeokId: `asset:${hash}` },
    }
    let file: DriveFile
    if (bytes.length + JSON.stringify(metadata).length <= SIMPLE_MAX) {
      file = await d.call(noteId, () => drive.uploadSimple({ metadata, bytes }), {
        // A create whose answer was lost may have happened: look for it first.
        beforeRetry: async () => (await find(noteId, hash))[0] ?? null,
      })
    } else {
      const uri = await d.call(noteId, () => drive.startResumable({ metadata, size: bytes.length }))
      let offset = 0
      for (let stalled = 0; ; ) {
        const from = offset
        const r = await d.call(noteId, () => drive.putResumable(uri, bytes.length, from, bytes.subarray(from, Math.min(from + RESUMABLE_CHUNK, bytes.length))))
        if (r.file) {
          file = r.file
          break
        }
        stalled = r.received > offset ? 0 : stalled + 1
        if (stalled >= 3) throw d.failure('backoff', { reason: 'assetStalled' })
        offset = r.received
      }
    }
    // Size and checksum Drive reports must be ours; a file that is not is trashed so the retry does not leave two.
    const seen = await d.call(noteId, () => drive.get(file.id, { fields: 'id,size,md5Checksum' }))
    if (!same(seen, bytes)) {
      await d.call(noteId, () => drive.update(file.id, { trashed: true }))
      throw d.failure('backoff', { reason: 'assetMismatch' })
    }
  }

  /**
   * Before a note goes up: every asset it references is on Drive, or the upload stops (throws a backoff failure; the
   * note stays unsent and the whole upload is retried later). Returns the note whose assets were checked: the one to
   * upload. `read` gives the note as it is now (an edit during the upload is looked at again).
   */
  async function send(noteId: string, read: () => Promise<Note>): Promise<Note> {
    const confirmed = new Set<string>()
    let folder: string | undefined
    for (let round = 0; round < ROUNDS; round++) {
      const note = await read()
      const referenced = referencedAssets(note)
      if (referenced.length === 0) return note
      const exts = new Map<string, string>()
      for (const p of note.pages) for (const e of p.elements as { type?: unknown; asset?: unknown; ext?: unknown }[]) if (e?.type === 'image') exts.set(String(e.asset), String(e.ext))
      const bytes = new Map<string, Uint8Array>()
      for (const h of referenced) {
        if (!isAssetHash(h)) continue
        const rec = await d.assets.get(h)
        if (rec) bytes.set(h, rec.bytes)
        if (confirmed.has(h)) continue
        const found = await find(noteId, h)
        // Bytes we hold are compared; without them any file stands.
        if (found.some((f) => !rec || same(f, rec.bytes))) {
          confirmed.add(h)
          d.onConfirmed?.(h)
        }
      }
      const plan = imageUploadPlan(referenced, confirmed, bytes.keys())
      if (plan.upload.length > 0) {
        const root = (await d.device.read()).rootFolderId
        if (root === null) throw d.failure('fatal', { reason: 'rootMissing' })
        folder ??= await d.ensureFolder(noteId, ASSETS_KKEUJEOK_ID, ASSETS_FOLDER_NAME, root)
        for (const h of plan.upload) {
          await put(noteId, folder, h, exts.get(h) ?? 'jpg', bytes.get(h)!)
          confirmed.add(h)
          d.onConfirmed?.(h)
        }
      }
      if (plan.blocked) throw d.failure('backoff', { reason: 'assetMissing' })
      if (plan.upload.length === 0) return note
      // Edited while the assets went: look at the note again.
    }
    throw d.failure('backoff', { reason: 'assetsChanging' })
  }

  return { send }
}
