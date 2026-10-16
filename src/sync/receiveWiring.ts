// Wires the receiver to the real Drive, IndexedDB and log for this page session, and
// the triggers: root ready / page load, tab visible, connection back, and the 20,000 ms
// poll while visible. Web Locks: `kkeujeok-receive` serializes the checks of all tabs,
// `kkeujeok-poll` is held by the one visible tab that polls. The hook removes every
// listener and timer on unmount.
import { useEffect } from 'react'
import type { Auth } from '../drive/auth'
import { createHttpDriveClient } from '../drive/driveClient'
import { type RootFolderStore, uploadsAllowed } from '../drive/rootFolderStore'
import { newId } from '../model/ids'
import { openNoteDb } from '../storage/noteDb'
import { openNoteStore } from '../storage/noteStore'
import { createSyncDeviceStore } from '../storage/syncDevice'
import { detectEditedBy } from '../ui/library/useLibrary'
import { createMergeIo } from './mergeIo'
import { type Channel, type NoteReceiver, createNoteReceiver } from './noteReceiver'
import { syncLog } from './syncLog'

export const POLL_MS = 20_000
/** Visibility and connection kicks closer than this to the last one are skipped. */
export const KICK_THROTTLE_MS = 5_000
export const RECEIVE_LOCK = 'kkeujeok-receive'
export const POLL_LOCK = 'kkeujeok-poll'
const CHANNEL = 'kkeujeok-receive'

function browserChannel(): Channel | null {
  try {
    if (typeof BroadcastChannel !== 'function') return null
    const bc = new BroadcastChannel(CHANNEL)
    return {
      post: (m) => bc.postMessage(m),
      subscribe(fn) {
        const on = (e: MessageEvent) => fn(e.data)
        bc.addEventListener('message', on)
        return () => bc.removeEventListener('message', on)
      },
    }
  } catch {
    return null
  }
}

const receivers = new WeakMap<RootFolderStore, NoteReceiver>()

/** The one receiver of this page session for `root`, wired to the real Drive, IndexedDB and log. */
export function defaultReceiver(auth: Auth, root: RootFolderStore): NoteReceiver {
  let r = receivers.get(root)
  if (!r) {
    const account = () => auth.getState().account
    const ndb = openNoteDb()
    const store = openNoteStore(undefined, { getAccount: account })
    r = createNoteReceiver({
      store,
      drive: createHttpDriveClient({ token: () => auth.getAccessToken() }),
      device: createSyncDeviceStore(ndb),
      remote: store.remote,
      log: syncLog(),
      merge: createMergeIo({ store, editedBy: detectEditedBy, now: () => new Date().toISOString(), newId }),
      account,
      allowed: () => uploadsAllowed(root),
      online: () => globalThis.navigator?.onLine !== false,
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      jitter: Math.random,
      channel: browserChannel(),
    })
    receivers.set(root, r)
  }
  return r
}

export type TriggerEnv = {
  doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>
  locks?: LockManager | undefined
  now?: () => number
  /** Returns the function that cancels the timer. */
  setTimer?: (fn: () => void, ms: number) => () => void
}

/** Attaches the receive triggers while mounted. Nothing runs after the returned cleanup. */
export function attachReceiveTriggers(
  receiver: Pick<NoteReceiver, 'check'>,
  root: Pick<RootFolderStore, 'getState' | 'subscribe'>,
  env: TriggerEnv = { doc: document, win: window },
): () => void {
  const locks = 'locks' in env ? env.locks : globalThis.navigator?.locks
  const now = env.now ?? Date.now
  const setTimer =
    env.setTimer ??
    ((fn, ms) => {
      const id = setTimeout(fn, ms)
      return () => clearTimeout(id)
    })
  let live = true
  let visible = env.doc.visibilityState !== 'hidden'
  let lastKick = -Infinity
  let cancelTick: (() => void) | null = null
  let cancelRetry: (() => void) | null = null
  let releaseLead: (() => void) | null = null
  let attempting = false

  /** One check under the lock of all tabs: a check another tab is running is not repeated. */
  async function check(): Promise<void> {
    if (!live) return
    try {
      if (!locks) await receiver.check()
      else {
        await locks.request(RECEIVE_LOCK, { ifAvailable: true }, async (lock) => {
          if (lock) await receiver.check()
        })
      }
    } catch {
      // the failure is in the log; the next tick tries again
    }
  }

  function startTimer() {
    cancelTick?.()
    const tick = () => {
      cancelTick = setTimer(() => {
        if (!live || !visible) return
        void check()
        tick()
      }, POLL_MS)
    }
    tick()
  }

  /** The visible tab that gets `kkeujeok-poll` polls; the others try again every period. */
  function lead() {
    if (!live || !visible || cancelTick || attempting) return
    if (!locks) return startTimer()
    attempting = true
    locks
      .request(POLL_LOCK, { ifAvailable: true }, (lock) => {
        attempting = false
        if (!lock) {
          if (live && visible) cancelRetry = setTimer(lead, POLL_MS)
          return undefined
        }
        if (!live || !visible) return undefined
        startTimer()
        return new Promise<void>((res) => (releaseLead = res)) // held until hidden or unmounted
      })
      .catch(() => {
        attempting = false
      })
  }

  function stop() {
    cancelTick?.()
    cancelTick = null
    cancelRetry?.()
    cancelRetry = null
    releaseLead?.()
    releaseLead = null
  }

  /** `force`: page load and root ready are not throttled. */
  function kick(force: boolean) {
    if (!live || !visible || !uploadsAllowed(root)) return
    const t = now()
    if (!force && t - lastKick < KICK_THROTTLE_MS) return
    lastKick = t
    void check()
    lead()
  }

  const onVisibility = () => {
    visible = env.doc.visibilityState !== 'hidden'
    if (visible) kick(false)
    else stop()
  }
  const onOnline = () => kick(false)
  env.doc.addEventListener('visibilitychange', onVisibility)
  env.win.addEventListener('online', onOnline)

  let ready = uploadsAllowed(root)
  if (ready) kick(true)
  const unsub = root.subscribe(() => {
    const now_ = uploadsAllowed(root)
    if (now_ && !ready) kick(true)
    ready = now_
  })
  return () => {
    live = false
    stop()
    unsub()
    env.doc.removeEventListener('visibilitychange', onVisibility)
    env.win.removeEventListener('online', onOnline)
  }
}

export function useReceiveTriggers(
  receiver: Pick<NoteReceiver, 'check'> | undefined,
  root: Pick<RootFolderStore, 'getState' | 'subscribe'>,
): void {
  useEffect(() => (receiver ? attachReceiveTriggers(receiver, root) : undefined), [receiver, root])
}
