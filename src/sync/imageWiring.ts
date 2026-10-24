// Wires the image assets to the real Drive and IndexedDB for this page session: the byte store the uploader and the
// editors share, and the one image host (sync state, decoded pictures) of a root folder.
import type { Auth } from '../drive/auth'
import { createAuthedDrive } from '../drive/authedDrive'
import { type RootFolderStore, uploadsAllowed } from '../drive/rootFolderStore'
import { createImageHost, type ImageHost } from '../render/imageHost'
import { type AssetStore, createAssetStore } from '../storage/assetStore'
import { openNoteDb } from '../storage/noteDb'
import { createAssetSync } from './assetSync'

let store: AssetStore | null = null
/** The one image byte store of this page session. */
export const sharedAssetStore = (): AssetStore => (store ??= createAssetStore(openNoteDb()))

const hosts = new WeakMap<RootFolderStore, ImageHost>()

/** The one image host of this page session for `root`, on the real Drive. */
export function defaultImageHost(auth: Auth, root: RootFolderStore): ImageHost {
  let h = hosts.get(root)
  if (!h) {
    const assets = sharedAssetStore()
    const sync = createAssetSync({
      store: assets,
      drive: createAuthedDrive(auth),
      online: () => globalThis.navigator?.onLine !== false,
      // Same gate as the uploads: the root folder is ready and the token is valid (an expired one waits for the sign-in).
      allowed: () => uploadsAllowed(root) && !auth.getState().expired,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      jitter: Math.random,
    })
    hosts.set(root, (h = createImageHost({ store: assets, sync })))
  }
  return h
}
