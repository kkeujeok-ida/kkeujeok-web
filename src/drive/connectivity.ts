// Is the browser offline (Story 3.16)? `offline` event, or a Drive call that failed
// on the network. It ends with the `online` event or the next Drive answer.
export type Connectivity = ReturnType<typeof createConnectivity>

export function createConnectivity(
  win: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined = globalThis.window,
  nav: { onLine?: boolean } | undefined = globalThis.navigator,
) {
  let state = { offline: nav?.onLine === false }
  const listeners = new Set<() => void>()
  const set = (offline: boolean) => {
    if (state.offline === offline) return
    state = { offline }
    listeners.forEach((fn) => fn())
  }
  const onOffline = () => set(true)
  const onOnline = () => set(false)
  win?.addEventListener('offline', onOffline)
  win?.addEventListener('online', onOnline)
  return {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    /** A Drive call failed on the network. */
    networkFailed: () => set(true),
    /** A Drive call was answered, so the connection works (unless the browser says it is offline). */
    networkOk: () => set(nav?.onLine === false),
    dispose() {
      win?.removeEventListener('offline', onOffline)
      win?.removeEventListener('online', onOnline)
      listeners.clear()
    },
  }
}

let shared: Connectivity | undefined
/** The one connectivity of this page session. */
export const connectivity = (): Connectivity => (shared ??= createConnectivity())
