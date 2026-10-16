import type { Auth } from '../src/drive/auth'

/** A `navigator.locks` stand-in: per-name FIFO queue with `ifAvailable` and `signal`. */
export function fakeLocks() {
  const queues = new Map<string, { held: boolean; waiting: (() => void)[] }>()
  return {
    request(name: string, opts: { ifAvailable?: boolean; signal?: AbortSignal }, cb: (lock: object | null) => unknown) {
      const q = queues.get(name) ?? { held: false, waiting: [] }
      queues.set(name, q)
      return new Promise<void>((resolve, reject) => {
        const run = async () => {
          q.held = true
          try {
            await cb({ name })
            resolve()
          } catch (e) {
            reject(e)
          } finally {
            q.held = false
            q.waiting.shift()?.()
          }
        }
        if (!q.held) return void run()
        if (opts.ifAvailable) {
          void Promise.resolve(cb(null)).then(() => resolve(), reject)
          return
        }
        const start = () => (opts.signal?.aborted ? q.waiting.shift()?.() : void run())
        q.waiting.push(start)
        opts.signal?.addEventListener('abort', () => {
          const i = q.waiting.indexOf(start)
          if (i >= 0) q.waiting.splice(i, 1)
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    },
  } as unknown as LockManager
}

// An already signed-in auth, for tests of the shell behind the sign-in gate.
const state = { token: 't', account: null, notice: null, busy: false, expired: false }
export const signedIn = {
  getState: () => state,
  subscribe: () => () => {},
  preload: () => {},
  getAccessToken: () => 't',
  signIn: async () => 'granted',
  reauth: async () => 'granted',
  markExpired: () => {},
  signOut: () => {},
  disconnect: async () => 'revoked',
} as Auth
