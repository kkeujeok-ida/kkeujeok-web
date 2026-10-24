// What this device knows about the image assets of the notes it shows (spec image.md): which have verified bytes here
// (`local`), which could not be fetched (`failed`), which Drive is known to hold (`confirmed`). It fetches the missing
// ones one hash at a time, with `sync.backoff`, and tells its listeners of every change. Port of the Android
// lib/sync/asset_sync.dart.
import { DriveError, type DriveClient, kkeujeokIdQuery } from '../drive/driveClient'
import { type AssetState, assetState, isAssetHash } from '../model/imageRules'
import type { AssetStore } from '../storage/assetStore'
import { md5Hex } from '../util/md5'
import { classifyDriveError } from './errorClass'
import { backoffRule } from './syncRules'

export type AssetSyncDeps = {
  store: AssetStore
  drive: DriveClient
  /** False while the browser knows it is offline: no request is made. */
  online: () => boolean
  /** The upload gate: root folder ready and a valid token. */
  allowed: () => boolean
  sleep: (ms: number) => Promise<void>
  jitter: () => number
}

export type AssetSync = ReturnType<typeof createAssetSync>

export function createAssetSync(d: AssetSyncDeps) {
  const local = new Set<string>()
  const failed = new Set<string>()
  const confirmed = new Set<string>()
  const busy = new Set<string>()
  const unconfirmed = new Set<string>() // Drive said no; asked again on retry
  const listeners = new Set<() => void>()
  let live = true
  const changed = () => live && listeners.forEach((f) => f())

  const find = async (hash: string) => (await d.drive.list(kkeujeokIdQuery(`asset:${hash}`), { fields: 'files(id,size,md5Checksum)' })).files

  // Has Drive this asset? Best effort: any failure leaves it unconfirmed.
  async function confirm(hash: string) {
    busy.add(hash)
    try {
      if (!d.online() || !d.allowed()) return
      const rec = await d.store.get(hash)
      const found = await find(hash)
      if (rec && found.some((f) => f.size === rec.bytes.length && f.md5Checksum === md5Hex(rec.bytes))) confirmed.add(hash)
      else unconfirmed.add(hash)
    } catch {
      // unknown stays unconfirmed
    } finally {
      busy.delete(hash)
      changed()
    }
  }

  async function fetchAsset(hash: string, ext: string) {
    busy.add(hash)
    changed()
    try {
      for (let attempt = 0; live; ) {
        try {
          if (!d.online() || !d.allowed()) throw new DriveError('network')
          const f = (await find(hash))[0]
          if (!f) throw new DriveError('network') // not up yet
          const bytes = await d.drive.downloadFile(f.id)
          // Size and SHA-256 must match; bytes that do not are dropped and fetched again.
          if ((f.size !== undefined && f.size !== bytes.length) || !(await d.store.putVerified(hash, ext, bytes))) throw new DriveError('network')
          local.add(hash)
          confirmed.add(hash)
          failed.delete(hash)
          return
        } catch (e) {
          if (!(e instanceof DriveError) || classifyDriveError(e) !== 'backoff') break
          const plan = backoffRule({ attempt: ++attempt, jitter: d.jitter() })
          if (!('retry' in plan) || plan.retry !== true) break
          await d.sleep(plan.delayMs)
        }
      }
      // Offline or not signed in is not a failure of the asset: the next ensure() fetches again.
      if (d.online() && d.allowed()) failed.add(hash)
    } finally {
      busy.delete(hash)
      changed()
    }
  }

  return {
    /** The hashes whose bytes are here and verified / whose last fetch failed / that Drive is known to hold. */
    local: () => local as ReadonlySet<string>,
    failed: () => failed as ReadonlySet<string>,
    confirmed: () => confirmed as ReadonlySet<string>,
    /** `image.assetState` of an `asset`. */
    state: (asset: unknown): AssetState => assetState(asset, local, failed),
    /** The bytes are here but Drive has not been seen to hold them (the "저장 대기" mark). */
    pending: (asset: string) => local.has(asset) && !confirmed.has(asset),
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    dispose() {
      live = false
      listeners.clear()
    },
    /** Bytes were just stored here (an insert); Drive has not seen them. */
    markLocal(hash: string) {
      unconfirmed.delete(hash)
      if (!local.has(hash)) (local.add(hash), changed())
    },
    /** The bytes of `hash` turned out to be gone from the store. */
    dropLocal(hash: string) {
      if (local.delete(hash)) changed()
    },
    /** The uploader found `hash` on Drive. */
    markConfirmed(hash: string) {
      unconfirmed.delete(hash)
      if (!confirmed.has(hash)) (confirmed.add(hash), changed())
    },
    /**
     * `assets` maps a hash to its `ext` for every image of the open note. Reads the store for the ones not yet known,
     * fetches the ones that are not here (one call per hash), and asks Drive about the ones it may not have. Never throws.
     */
    async ensure(assets: ReadonlyMap<string, string>): Promise<void> {
      for (const [h, ext] of assets) {
        if (!isAssetHash(h) || busy.has(h)) continue
        if (!local.has(h)) {
          busy.add(h) // before the await: an overlapping call skips it
          const here = (await d.store.get(h)) !== null
          busy.delete(h)
          if (here) {
            local.add(h)
            changed()
          } else if (!failed.has(h)) {
            void fetchAsset(h, ext)
            continue
          }
        }
        if (local.has(h) && !confirmed.has(h) && !unconfirmed.has(h)) void confirm(h)
      }
    },
    /** [다시 시도]: forgets the failure and fetches again. */
    retry(hash: string, ext: string) {
      if (busy.has(hash) || local.has(hash)) return
      failed.delete(hash)
      unconfirmed.delete(hash)
      void fetchAsset(hash, ext)
    },
  }
}
