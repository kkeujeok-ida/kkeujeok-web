// One feed of "this note's sync record or copy changed", for every tab of this
// browser: the writer emits, the status store listens. Carries ids only.
const listeners = new Set<(noteId: string) => void>()

let channel: BroadcastChannel | null | undefined
function bc(): BroadcastChannel | null {
  if (channel !== undefined) return channel
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('kkeujeok-sync-signal') : null
    channel?.addEventListener('message', (e: MessageEvent) => {
      if (typeof e.data === 'string') listeners.forEach((fn) => fn(e.data as string))
    })
  } catch {
    channel = null
  }
  return channel
}

export function emitSyncChanged(noteId: string): void {
  listeners.forEach((fn) => fn(noteId))
  try {
    bc()?.postMessage(noteId)
  } catch {
    // other tabs refresh on their next trigger
  }
}

export function onSyncChanged(fn: (noteId: string) => void): () => void {
  bc() // listening starts the channel
  listeners.add(fn)
  return () => void listeners.delete(fn)
}
