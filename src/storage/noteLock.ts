// One writer per note across browser tabs (AD-10, NFR6): a Web Lock per note.
// The tab that holds it edits; the others open read-only and wait for it.

export type NoteLock = {
  /** 'held': this tab may edit. 'waiting': another tab holds it; `whenHeld` settles on a grant. */
  state: 'held' | 'waiting'
  /** Resolves when the lock is ours (never, once released while waiting). */
  whenHeld: Promise<void>
  /** Aborts a pending request or frees the lock. Safe to call again. */
  release(): Promise<void>
}

type Request = { granted: Promise<boolean>; release: () => Promise<void> }

/** One `locks.request` that keeps the lock until `release`. `granted` is false when `ifAvailable` found it taken. */
function take(locks: LockManager, name: string, opts: LockOptions): Request {
  let free!: () => void
  const hold = new Promise<void>((r) => (free = r))
  let done: Promise<unknown> = Promise.resolve()
  const granted = new Promise<boolean>((resolve, reject) => {
    done = locks.request(name, opts, (lock) => {
      resolve(lock !== null)
      return lock ? hold : undefined
    })
    done.catch(reject) // an abort or a throwing manager; a no-op once granted
  })
  return {
    granted,
    release: () => {
      free()
      return done.then(
        () => {},
        () => {},
      )
    },
  }
}

const none = (): NoteLock => ({ state: 'held', whenHeld: Promise.resolve(), release: async () => {} })

/**
 * Takes the lock of `noteId`. With no Web Locks API, or one that throws, the
 * tab is simply the writer (no protection, no banner).
 */
export async function acquireNoteLock(noteId: string, locks: LockManager | undefined = globalThis.navigator?.locks): Promise<NoteLock> {
  if (!locks) return none()
  const name = `kkeujeok-note:${noteId}`
  try {
    const first = take(locks, name, { ifAvailable: true })
    if (await first.granted) return { state: 'held', whenHeld: Promise.resolve(), release: first.release }

    // ponytail: waits in the browser's own queue; no timeout, a hung holder keeps this tab read-only.
    const ctl = new AbortController()
    const second = take(locks, name, { signal: ctl.signal })
    const lock: NoteLock = {
      state: 'waiting',
      whenHeld: new Promise<void>((resolve) => {
        second.granted.then(
          () => {
            lock.state = 'held'
            resolve()
          },
          () => {
            // Aborted by release: stay pending. Anything else: act as if there were no API.
            if (!ctl.signal.aborted) {
              lock.state = 'held'
              resolve()
            }
          },
        )
      }),
      release: () => {
        ctl.abort()
        return second.release()
      },
    }
    return lock
  } catch {
    return none()
  }
}
