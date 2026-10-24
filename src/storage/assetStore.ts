// Image asset bytes of this browser (AD-10, spec image.md): `<sha256>` -> { ext, bytes } in IndexedDB. Written once
// (the same hash is not written again), kept after an upload as the cache, and checked against its SHA-256 on every read.
import { isAssetHash } from '../model/imageRules'
import { sha256Hex } from '../util/sha256'
import { type Db, ASSET_STORE, NoteSaveError } from './noteDb'

export type AssetRecord = { ext: string; bytes: Uint8Array }
export type AssetStore = ReturnType<typeof createAssetStore>

export function createAssetStore(ndb: Db) {
  const rawGet = (hash: string) => ndb.withDb((db) => db.get(ASSET_STORE, hash) as Promise<AssetRecord | undefined>)
  return {
    /** Stores `bytes` under `hash` unless they are there. Throws NoteSaveError when `bytes` are not that hash or the write fails. */
    async put(hash: string, ext: string, bytes: Uint8Array): Promise<void> {
      if (!isAssetHash(hash) || (await sha256Hex(bytes)) !== hash) throw new NoteSaveError('asset bytes do not match their hash')
      try {
        if (await ndb.withDb((db) => db.count(ASSET_STORE, hash))) return
        await ndb.withDb((db) => db.put(ASSET_STORE, { ext, bytes: new Uint8Array(bytes) } satisfies AssetRecord, hash))
      } catch (e) {
        throw e instanceof NoteSaveError ? e : new NoteSaveError('asset write failed', e)
      }
    },
    /** The verified bytes, or null when absent, unreadable or not matching (a bad record is dropped). */
    async get(hash: string): Promise<AssetRecord | null> {
      if (!isAssetHash(hash)) return null
      try {
        const r = await rawGet(hash)
        // isView, not instanceof: a record cloned by IndexedDB may come from another realm.
        if (!r || !ArrayBuffer.isView(r.bytes)) return null
        const bytes = new Uint8Array(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength)
        if ((await sha256Hex(bytes)) === hash) return { ext: r.ext, bytes }
        await ndb.withDb((db) => db.delete(ASSET_STORE, hash))
      } catch {
        // an unreadable store counts as no bytes
      }
      return null
    },
    /** Stores bytes fetched from Drive only when they hash to `hash`; false when they do not. */
    async putVerified(hash: string, ext: string, bytes: Uint8Array): Promise<boolean> {
      if ((await sha256Hex(bytes)) !== hash) return false
      await this.put(hash, ext, bytes)
      return true
    },
  }
}
