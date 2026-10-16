// Wires the uploader to the real Drive, IndexedDB and log for this page session,
// and the browser events that trigger uploads (tab hidden, page hide, connection
// back, root folder ready). The React hook removes every listener on unmount.
import { useEffect } from 'react'
import type { Auth } from '../drive/auth'
import { createHttpDriveClient } from '../drive/driveClient'
import { type RootFolderStore, uploadsAllowed } from '../drive/rootFolderStore'
import { renderThumbnail } from '../drive/thumbnail'
import { newId } from '../model/ids'
import { openNoteDb } from '../storage/noteDb'
import { openNoteStore } from '../storage/noteStore'
import { createSyncDeviceStore } from '../storage/syncDevice'
import { detectEditedBy } from '../ui/library/useLibrary'
import { createMergeIo } from './mergeIo'
import { createNoteUploader } from './noteUploader'
import { getOpenNote, openNoteIds } from './openNotes'
import { syncLog } from './syncLog'
import { type UploadCoordinator, createUploadCoordinator } from './uploadCoordinator'

const coordinators = new WeakMap<RootFolderStore, UploadCoordinator>()

/** The one coordinator of this page session for `root`, wired to the real Drive, IndexedDB and log. */
export function defaultUploadCoordinator(auth: Auth, root: RootFolderStore): UploadCoordinator {
  let c = coordinators.get(root)
  if (!c) {
    const account = () => auth.getState().account
    const store = openNoteStore(undefined, { getAccount: account })
    const log = syncLog()
    const uploader = createNoteUploader({
      store,
      drive: createHttpDriveClient({ token: () => auth.getAccessToken() }),
      device: createSyncDeviceStore(openNoteDb()),
      log,
      merge: createMergeIo({ store, editedBy: detectEditedBy, now: () => new Date().toISOString(), newId }),
      allowed: () => uploadsAllowed(root),
      online: () => globalThis.navigator?.onLine !== false,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      jitter: Math.random,
      thumbnail: renderThumbnail,
    })
    c = createUploadCoordinator({
      store,
      uploader,
      log,
      allowed: () => uploadsAllowed(root),
      online: () => globalThis.navigator?.onLine !== false,
      flushOpen: async () => void (await Promise.all(openNoteIds().map((id) => getOpenNote(id)?.flush()))),
    })
    coordinators.set(root, c)
  }
  return c
}

/** Attaches the upload triggers while mounted. Nothing runs after unmount. */
export function attachUploadTriggers(
  uploads: Pick<UploadCoordinator, 'hidden' | 'unsent' | 'rootReady'>,
  root: Pick<RootFolderStore, 'getState' | 'subscribe'>,
  target: { doc: Document; win: Window } = { doc: document, win: window },
): () => void {
  let live = true
  const hide = () => {
    if (live) void uploads.hidden()
  }
  const onVisibility = () => {
    if (target.doc.visibilityState === 'hidden') hide()
  }
  const onOnline = () => {
    if (live) void uploads.unsent()
  }
  target.doc.addEventListener('visibilitychange', onVisibility)
  target.win.addEventListener('pagehide', hide)
  target.win.addEventListener('online', onOnline)

  let ready = uploadsAllowed(root)
  if (ready) void uploads.rootReady()
  const unsub = root.subscribe(() => {
    const now = uploadsAllowed(root)
    if (now && !ready && live) void uploads.rootReady()
    ready = now
  })
  return () => {
    live = false
    unsub()
    target.doc.removeEventListener('visibilitychange', onVisibility)
    target.win.removeEventListener('pagehide', hide)
    target.win.removeEventListener('online', onOnline)
  }
}

export function useUploadTriggers(
  uploads: Pick<UploadCoordinator, 'hidden' | 'unsent' | 'rootReady'> | undefined,
  root: Pick<RootFolderStore, 'getState' | 'subscribe'>,
): void {
  useEffect(() => (uploads ? attachUploadTriggers(uploads, root) : undefined), [uploads, root])
}
