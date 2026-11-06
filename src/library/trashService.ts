// Story 14.3: the app trash on the web. Everything here is Drive-only: a trashed note has no
// device copy (spec `trash`), so nothing touches the note store. Mirrors kkeujeok-client
// lib/library/trash_service.dart.
import { type DriveClient, type DriveFile, DriveError, childrenQuery, kkeujeokIdQuery } from '../drive/driveClient'
import { decodeKkj } from '../model/kkjCodec'
import type { NoteReadResult } from '../model/note'
import type { SyncDeviceStore } from '../storage/syncDevice'
import type { FolderService } from './folderService'
import { trashListRule, trashPurgeRule, trashRestoreRule } from './libraryRules'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const KKJ_MIME = 'application/vnd.kkeujeok.kkj'
const FIELDS = 'id,name,mimeType,modifiedTime,appProperties'

/** One row of the trash (`trash.list`). */
export type TrashEntry = {
  isFolder: boolean
  id: string
  fileId: string
  title: string
  /** Canonical timestamp. */
  trashedAt: string
  trashedFrom: string | null
  noteCount: number
}

export type TrashOutcome = 'done' | 'already' | 'gone' | 'rootFallback' | 'failed'

const is404 = (e: unknown) => e instanceof DriveError && e.kind === 'http' && e.status === 404

export function createTrashService(deps: { drive: DriveClient; device: Pick<SyncDeviceStore, 'read'>; folders: Pick<FolderService, 'trashbinFileId' | 'trashPending'> }) {
  const { drive, device, folders } = deps

  async function all(q: string): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let token: string | undefined
    do {
      const p = await drive.list(q, { fields: `nextPageToken,files(${FIELDS})`, ...(token && { pageToken: token }) })
      out.push(...p.files)
      token = p.nextPageToken
    } while (token)
    return out
  }

  async function notesBelow(folderFile: string): Promise<number> {
    let n = 0
    for (const c of await all(childrenQuery(folderFile))) {
      if (c.mimeType === FOLDER_MIME) n += await notesBelow(c.id)
      else if (c.mimeType === KKJ_MIME) n++
    }
    return n
  }

  /** `files.get` just before a restore or purge; null = 404 (gone). */
  async function reread(fileId: string): Promise<DriveFile | null> {
    try {
      return await drive.get(fileId, { fields: 'id,parents,trashed,appProperties' })
    } catch (e) {
      if (is404(e)) return null
      throw e
    }
  }

  /** Whether the folder file lies in `.trashbin` (or cannot be followed: then it is no destination). */
  async function inTrash(fileId: string, bin: string, root: string): Promise<boolean> {
    let cur = fileId
    for (let i = 0; i < 64; i++) {
      const f = await reread(cur)
      const p = f?.parents[0]
      if (!f || f.trashed || p === undefined || p === bin) return true
      if (p === root) return false
      cur = p
    }
    return true
  }

  async function purge(e: TrashEntry): Promise<TrashOutcome> {
    const bin = await folders.trashbinFileId()
    if (!bin) return 'failed'
    const cur = await reread(e.fileId)
    if (!cur) return 'gone'
    const r = trashPurgeRule({ item: { fileId: e.fileId, parentId: cur.parents.includes(bin) ? 'trashbin' : 'other', trashed: cur.trashed } })
    if (!('request' in r)) return 'already' in r ? 'gone' : 'failed'
    await drive.update(e.fileId, { trashed: true })
    return 'done'
  }

  return {
    /** The direct children of `.trashbin`, newest delete first. Throws DriveError. */
    async list(): Promise<TrashEntry[]> {
      const bin = await folders.trashbinFileId()
      if (!bin) return []
      const files = await all(childrenQuery(bin))
      const noteCounts: Record<string, number> = {}
      for (const f of files) {
        const k = f.appProperties.kkeujeokId
        if (f.mimeType === FOLDER_MIME && k) noteCounts[k] = await notesBelow(f.id)
      }
      const byFile = new Map(files.map((f) => [f.id, f]))
      return trashListRule({ items: files, noteCounts }).entries.map((e) => {
        const n = byFile.get(e.fileId)!.name ?? ''
        return { isFolder: e.kind === 'folder', id: e.id, fileId: e.fileId, title: n.endsWith('.kkj') ? n.slice(0, -4) : n, trashedAt: e.trashedAt, trashedFrom: e.trashedFrom, noteCount: e.noteCount ?? 0 }
      })
    },

    /** Downloads a trashed note by file id for the read-only view; nothing is stored. */
    open: async (fileId: string): Promise<NoteReadResult> => decodeKkj(await drive.downloadFile(fileId)),

    /** `trash.restoreNote` / `trash.restoreFolder`. */
    async restore(e: TrashEntry): Promise<TrashOutcome> {
      const bin = await folders.trashbinFileId()
      const root = (await device.read()).rootFolderId
      if (!bin || !root) return 'failed'
      const cur = await reread(e.fileId)
      if (!cur) return 'gone'
      const from = cur.appProperties.trashedFrom
      let origin: { fileId: string; inTrash: boolean } | null = null
      if (from && from !== 'root' && from !== 'trashbin') {
        const found = (await all(kkeujeokIdQuery(from)))[0]
        if (found) origin = { fileId: found.id, inTrash: (await folders.trashPending(from)) || (await inTrash(found.id, bin, root)) }
      }
      const r = trashRestoreRule({
        item: { id: e.id, fileId: e.fileId, parentFileId: cur.parents.filter((p) => p === bin).join(','), parentId: cur.parents.includes(bin) ? 'trashbin' : 'other', trashed: cur.trashed, appProperties: cur.appProperties },
        trashbinFileId: bin,
        rootFileId: root,
        origin,
      })
      if ('gone' in r) return 'gone'
      // Another device restored it: it is back, not gone.
      if ('already' in r) return 'already'
      await drive.update(e.fileId, { addParents: r.request.addParents, removeParents: r.request.removeParents, appProperties: r.request.appProperties })
      return r.rootFallback ? 'rootFallback' : 'done'
    },

    /** `trash.purgeItem`: `trashed=true`, never `files.delete`. */
    purge,

    /** `trash.emptyTrash`: one by one, a failure does not stop the others. Returns the entries still in the trash. */
    async empty(entries: TrashEntry[]): Promise<TrashEntry[]> {
      const left: TrashEntry[] = []
      for (const e of entries) {
        try {
          if ((await purge(e)) === 'failed') left.push(e)
        } catch (err) {
          if (!(err instanceof DriveError)) throw err
          left.push(e)
        }
      }
      return left
    },
  }
}

export type TrashService = ReturnType<typeof createTrashService>
