// Cards of notes that exist on Drive but are not downloaded yet (Story 3.14): drawn
// from the list summary (`drive.listSummary` read), key = noteId in the `remote`
// store of the note DB. A card goes away when its note is downloaded.
import { type Db, NoteSaveError, REMOTE_STORE } from './noteDb'

export type RemoteCard = {
  noteId: string
  fileId: string
  headRevisionId: string
  title: string
  folderId: string | null
  coverId: string | null
  /** Canonical timestamp. */
  modifiedAt: string
}

const str = (v: unknown) => typeof v === 'string' && v !== ''
const strOrNull = (v: unknown) => v === null || typeof v === 'string'

function toCard(noteId: string, v: unknown): RemoteCard | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (!str(o.fileId) || !str(o.headRevisionId) || typeof o.title !== 'string' || !strOrNull(o.folderId) || !strOrNull(o.coverId) || !str(o.modifiedAt)) {
    return null
  }
  return { noteId, fileId: o.fileId as string, headRevisionId: o.headRevisionId as string, title: o.title, folderId: (o.folderId as string | null) ?? null, coverId: (o.coverId as string | null) ?? null, modifiedAt: o.modifiedAt as string }
}

export type RemoteCardStore = ReturnType<typeof createRemoteCardStore>

export function createRemoteCardStore(ndb: Db) {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      throw e instanceof NoteSaveError ? e : new NoteSaveError('could not use remote cards', e)
    }
  }
  return {
    /** Every readable card; a malformed row is skipped (never deleted). Rejects when IndexedDB fails. */
    list: (): Promise<RemoteCard[]> =>
      wrap(async () => {
        const [keys, values] = await ndb.withDb((db) => {
          const tx = db.transaction(REMOTE_STORE)
          return Promise.all([tx.store.getAllKeys(), tx.store.getAll() as Promise<unknown[]>])
        })
        const out: RemoteCard[] = []
        keys.forEach((k, i) => {
          const c = typeof k === 'string' ? toCard(k, values[i]) : null
          if (c) out.push(c)
        })
        return out
      }),
    get: (noteId: string): Promise<RemoteCard | null> =>
      wrap(async () => toCard(noteId, await ndb.withDb((db) => db.get(REMOTE_STORE, noteId)))),
    put: (c: RemoteCard): Promise<void> =>
      wrap(async () => {
        const { noteId, ...rest } = c
        await ndb.withDb((db) => db.put(REMOTE_STORE, rest, noteId))
      }),
    delete: (noteId: string): Promise<void> => wrap(async () => void (await ndb.withDb((db) => db.delete(REMOTE_STORE, noteId)))),
  }
}
