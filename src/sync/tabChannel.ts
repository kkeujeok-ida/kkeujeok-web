// The BroadcastChannel the tabs of this browser talk on (receiver messages; Story 7.8: a note deleted or renamed in the library).
import type { Channel } from './noteReceiver'

const CHANNEL = 'kkeujeok-receive'

export function browserChannel(): Channel | null {
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

let shared: Channel | null | undefined
/** Tells the other tabs; nothing happens when the browser has no BroadcastChannel. */
export function postToTabs(m: unknown): void {
  try {
    ;(shared === undefined ? (shared = browserChannel()) : shared)?.post(m)
  } catch {
    // the other tabs learn it at their next read
  }
}
