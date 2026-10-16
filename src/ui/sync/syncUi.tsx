// What the sync display shares inside the shell (Story 3.16): the status store, the
// connection, the token, and the actions behind [지금 동기화] and [다시 로그인]. Without a
// provider (older screens, tests of one screen) there is no indicator and only the
// other-tab banner.
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Auth } from '../../drive/auth'
import { connectivity, type Connectivity } from '../../drive/connectivity'
import { getOpenNote, openNoteIds } from '../../sync/openNotes'
import { displayRule, type DisplayLabel, type SyncStateName } from '../../sync/syncRules'
import { createSyncStatus, type NoteSyncView, type SyncStatus } from '../../sync/syncStatus'
import { syncLog } from '../../sync/syncLog'
import { defaultUnsentStore } from '../../sync/unsent'
import type { UploadCoordinator } from '../../sync/uploadCoordinator'
import { pickBanner, type BannerKind } from './bannerPriority'

type ReceiverLike = {
  subscribe(fn: () => void): () => void
  getState(): { receiving: ReadonlySet<string>; revived?: number }
  /** [다시 살리기] of the deleted banner. */
  revive?(noteId: string): Promise<void>
}
type AuthLike = Pick<Auth, 'getState' | 'subscribe'> & Partial<Pick<Auth, 'reauth'>>

export type SyncUi = {
  status: Pick<SyncStatus, 'getSnapshot' | 'subscribe'>
  net: Pick<Connectivity, 'getState' | 'subscribe'>
  auth: AuthLike
  receiver: ReceiverLike | undefined
  uploads: Partial<Pick<UploadCoordinator, 'syncNow'>> | undefined
  exportLog: () => Promise<{ name: string; text: string }>
  /** [다시 살리기] of the deleted banner: the file is back on Drive and the note goes up now. */
  revive: (noteId: string) => Promise<void>
  /** [다시 로그인]; one at a time. */
  reauth: () => void
  reauthBusy: boolean
}

const SyncUiContext = createContext<SyncUi | null>(null)
export const useSyncUi = () => useContext(SyncUiContext)

const EMPTY_SNAP = { version: 0, loaded: false, notes: new Map<string, NoteSyncView>() }
const NO_STATUS = { getSnapshot: () => EMPTY_SNAP, subscribe: () => () => {} }
const ONLINE = { offline: false }
const NO_NET = { getState: () => ONLINE, subscribe: () => () => {} }
const NO_RECEIVE = { version: 0, receiving: new Set<string>(), scanning: false, revived: 0 }
const NO_RECEIVER = { subscribe: () => () => {}, getState: () => NO_RECEIVE }
const NO_AUTH = { getState: () => ({ expired: false }), subscribe: () => () => {} } as unknown as AuthLike
// Test stand-ins of Auth may not have `expired`.
const expiredOf = (a: AuthLike) => (a.getState() as { expired?: boolean }).expired === true

/** True when closing the tab now would lose something: unsent changes, a stroke, or a save not on disk. Synchronous. */
export function unsentNow(status: Pick<SyncStatus, 'anyUnsent'>): boolean {
  return status.anyUnsent() || openNoteIds().some((id) => getOpenNote(id)?.unsaved?.() === true)
}

function defaultStatus(): SyncStatus {
  try {
    return createSyncStatus({ store: defaultUnsentStore() })
  } catch {
    // no storage in this browser: nothing to show
    return createSyncStatus({ store: { listIds: async () => [], readSync: () => Promise.reject(new Error('no storage')) } })
  }
}

const defaultExport = () => syncLog().exportJsonl({ appVersion: __APP_VERSION__, now: new Date() })

export function SyncUiProvider({
  auth,
  uploads,
  receiver,
  status: statusProp,
  net: netProp,
  exportLog = defaultExport,
  win: winProp,
  doc: docProp,
  children,
}: {
  auth: AuthLike
  uploads?: Partial<Pick<UploadCoordinator, 'syncNow' | 'resume'>> | undefined
  receiver?: ReceiverLike | undefined
  status?: SyncStatus
  net?: Pick<Connectivity, 'getState' | 'subscribe'>
  exportLog?: () => Promise<{ name: string; text: string }>
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>
  children?: ReactNode
}) {
  const status = useMemo(() => statusProp ?? defaultStatus(), [statusProp])
  const net = useMemo(() => netProp ?? connectivity(), [netProp])
  const alive = useRef(true)
  const flight = useRef(false)
  const [reauthBusy, setBusy] = useState(false)

  // Fresh reads at start, when the tab is visible again and when the connection is back; the unload warning.
  useEffect(() => {
    alive.current = true
    const win = winProp ?? window
    const doc = docProp ?? document
    const refresh = () => void status.refreshAll()
    const onVisible = () => doc.visibilityState === 'visible' && refresh()
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!unsentNow(status)) return
      e.preventDefault()
      e.returnValue = ''
    }
    refresh()
    doc.addEventListener('visibilitychange', onVisible)
    win.addEventListener('online', refresh)
    win.addEventListener('beforeunload', onUnload as EventListener)
    return () => {
      alive.current = false
      doc.removeEventListener('visibilitychange', onVisible)
      win.removeEventListener('online', refresh)
      win.removeEventListener('beforeunload', onUnload as EventListener)
      if (!statusProp) status.dispose()
    }
  }, [status, statusProp, winProp, docProp])

  const value = useMemo<SyncUi>(
    () => ({
      status,
      net,
      auth,
      receiver,
      uploads,
      exportLog,
      reauthBusy,
      async revive(noteId) {
        await receiver?.revive?.(noteId)
        await uploads?.syncNow?.(noteId)
      },
      reauth() {
        if (flight.current || !auth.reauth) return
        flight.current = true
        setBusy(true)
        const before = auth.getState().account?.sub ?? null
        void (async () => {
          try {
            const outcome = await auth.reauth!()
            if (outcome !== 'granted' || !alive.current) return
            // Another account is the mismatch dialog's business: nothing uploads for it.
            if ((auth.getState().account?.sub ?? null) !== before) return
            await uploads?.resume?.()
            void status.refreshAll()
          } catch {
            // the banner stays
          } finally {
            flight.current = false
            if (alive.current) setBusy(false)
          }
        })()
      },
    }),
    [status, net, auth, receiver, uploads, exportLog, reauthBusy],
  )
  return <SyncUiContext.Provider value={value}>{children}</SyncUiContext.Provider>
}

export type NoteSyncDisplay = {
  label: DisplayLabel
  /** Why a `notSaved` note is not saved, for the popover. */
  reason: 'quota' | 'reauth' | 'deleted' | 'unreadable' | 'newVersion' | 'other' | null
} | null

/** The label of one note, or null while nothing is known about it. */
export function useNoteSync(noteId: string): NoteSyncDisplay {
  const ui = useSyncUi()
  const st = ui?.status ?? NO_STATUS
  const snap = useSyncExternalStore(st.subscribe, st.getSnapshot, st.getSnapshot)
  const rx = ui?.receiver ?? NO_RECEIVER
  const receiving = useSyncExternalStore(rx.subscribe, rx.getState, rx.getState).receiving.has(noteId)
  const a = ui?.auth ?? NO_AUTH
  const expired = useSyncExternalStore(a.subscribe, () => expiredOf(a), () => false)
  if (!ui) return null
  const view = snap.notes.get(noteId)
  if (!view && !receiving && !snap.loaded) return null
  let state: SyncStateName = view?.state ?? 'synced'
  if (expired && state === 'pending') state = 'error'
  if (receiving) state = 'syncing'
  const r = displayRule({ state, cause: receiving ? 'remote' : 'upload', platform: 'web', online: true })
  const label: DisplayLabel = 'label' in r ? r.label : 'pending'
  const cls = view?.lastError?.class
  const reason =
    label !== 'notSaved'
      ? null
      : cls === 'quota'
        ? 'quota'
        : cls === 'reauth' || expired
          ? 'reauth'
          : cls === 'deleted'
            ? 'deleted'
            : cls === 'unreadable'
              ? view?.lastError?.reason === 'unsupportedVersion'
                ? 'newVersion'
                : 'unreadable'
              : 'other'
  return { label, reason }
}

/** What Drive did to a note that the screens must say (Story 3.18); null for a note that is fine. */
export type NoteIssue = { kind: 'deleted' | 'newVersion' | 'unreadable'; fileId: string | null; hasUnsent: boolean }

export function issueOf(v: NoteSyncView | undefined): NoteIssue | null {
  const e = v?.lastError
  if (!v || !e) return null
  const base = { fileId: v.fileId ?? null, hasUnsent: v.hasUnsent }
  if (e.class === 'deleted') return { kind: 'deleted', ...base }
  if (e.class === 'unreadable') return { kind: e.reason === 'unsupportedVersion' ? 'newVersion' : 'unreadable', ...base }
  return null
}

/** The issue of one note, from the sync records the status store keeps. */
export function useNoteIssue(noteId: string): NoteIssue | null {
  const st = useSyncUi()?.status ?? NO_STATUS
  const snap = useSyncExternalStore(st.subscribe, st.getSnapshot, st.getSnapshot)
  return issueOf(snap.notes.get(noteId))
}

/** The one banner to show now (the editor says whether another tab holds the note, and which note it shows). */
export function useBannerKind(otherTab: boolean, noteId?: string): BannerKind | null {
  const ui = useSyncUi()
  const st = ui?.status ?? NO_STATUS
  const snap = useSyncExternalStore(st.subscribe, st.getSnapshot, st.getSnapshot)
  const net = ui?.net ?? NO_NET
  const offline = useSyncExternalStore(net.subscribe, () => net.getState().offline, () => false)
  const a = ui?.auth ?? NO_AUTH
  const expired = useSyncExternalStore(a.subscribe, () => expiredOf(a), () => false)
  const failed = (cls: string) => [...snap.notes.values()].some((v) => v.state === 'error' && v.lastError?.class === cls)
  const issue = noteId === undefined ? null : issueOf(snap.notes.get(noteId))
  return pickBanner({
    otherTab,
    deleted: issue?.kind === 'deleted',
    newVersion: issue?.kind === 'newVersion',
    reauth: expired || failed('reauth'),
    quota: failed('quota'),
    offline,
  })
}

/** The connection is down: library cards cannot be opened (the open note keeps working). */
export function useOffline(): boolean {
  const net = useSyncUi()?.net ?? NO_NET
  return useSyncExternalStore(net.subscribe, () => net.getState().offline, () => false)
}
