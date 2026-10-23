// State of the Drive root folder for the library and the upload gate (Story 3.10),
// mirroring RootFolderNotifier of kkeujeok-client/lib/ui/providers.dart.
import type { Auth } from './auth'
import { createAuthedDrive } from './authedDrive'
import { createRootFolderService, type RootFolderService, type RootResult, type RootStatus } from './rootFolder'
import { createSyncDeviceStore } from '../storage/syncDevice'
import { openNoteDb } from '../storage/noteDb'
import { openNoteStore } from '../storage/noteStore'
import { syncLog } from '../sync/syncLog'

export type RootState = { status: RootStatus; errorClass?: string; folderId?: string }

/** Foreground re-checks closer together than this are skipped. */
export const ROOT_CHECK_THROTTLE_MS = 30_000

export function createRootFolderStore(o: {
  service: Pick<RootFolderService, 'checkRoot' | 'recreate'>
  auth: Pick<Auth, 'subscribe' | 'getState' | 'signIn'>
  throttleMs?: number
  now?: () => number
}) {
  const throttleMs = o.throttleMs ?? ROOT_CHECK_THROTTLE_MS
  const now = o.now ?? Date.now
  let state: RootState = { status: 'idle' }
  let gen = 0 // a run that started before a sign-out is dropped
  let lastCheck: number | null = null
  const listeners = new Set<() => void>()
  const set = (s: RootState) => {
    state = s
    listeners.forEach((fn) => fn())
  }

  let signedIn = !!o.auth.getState().token
  const unsub = o.auth.subscribe(() => {
    const now_ = !!o.auth.getState().token
    if (signedIn && !now_) {
      gen++
      lastCheck = null
      set({ status: 'idle' })
    }
    signedIn = now_
  })

  async function run(call: () => Promise<RootResult>, show: boolean) {
    const mine = gen
    if (show) set({ status: 'preparing' })
    const r = await call()
    if (mine !== gen) return
    set({
      status: r.status,
      ...(r.errorClass !== undefined && { errorClass: r.errorClass }),
      ...(r.folderId !== undefined && { folderId: r.folderId }),
    })
  }

  const store = {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    /** First preparation, [다시 시도]: "preparing" shows only when nothing usable is known yet. */
    check(): Promise<void> {
      const s = state.status
      lastCheck = now()
      return run(() => o.service.checkRoot(), s === 'idle' || s === 'failed')
    },
    /** Skipped when the last check was less than the throttle ago and the root is known. */
    checkForeground(): Promise<void> {
      const s = state.status
      if ((s === 'ready' || s === 'missing') && lastCheck !== null && now() - lastCheck < throttleMs) {
        return Promise.resolve()
      }
      return store.check()
    },
    /** [다시 로그인]: asks for the Drive permission again, then checks once more when granted. */
    async signInAgain(): Promise<void> {
      const outcome = await o.auth.signIn().catch(() => 'network')
      if (outcome === 'granted') await store.check()
    },
    /** [새로 만들기] of the missing-root dialog. */
    recreate: (): Promise<void> => run(() => o.service.recreate(), true),
    /** For uploads (Story 3.12) that got 404 or trashed on the root: checks again before anything is shown. */
    reportRootGone: (): Promise<void> => run(() => o.service.checkRoot(), false),
    dispose: unsub,
  }
  return store
}
export type RootFolderStore = ReturnType<typeof createRootFolderStore>

/** Uploads run only while the root is ready. */
export const uploadsAllowed = (s: Pick<RootFolderStore, 'getState'>) => s.getState().status === 'ready'

const stores = new WeakMap<Auth, RootFolderStore>()
/** The one store of this page session for `auth`, wired to the real Drive, IndexedDB and log. */
export function defaultRootFolder(auth: Auth): RootFolderStore {
  let s = stores.get(auth)
  if (!s) {
    const account = () => auth.getState().account
    const service = createRootFolderService({
      client: createAuthedDrive(auth),
      open: () => {
        const ndb = openNoteDb()
        const notes = openNoteStore(undefined, { getAccount: account })
        return {
          device: createSyncDeviceStore(ndb),
          notes,
          close: () => {
            ndb.close()
            notes.close()
          },
        }
      },
      log: syncLog(),
      account,
      settleMs: 500,
    })
    s = createRootFolderStore({ service, auth })
    stores.set(auth, s)
  }
  return s
}
