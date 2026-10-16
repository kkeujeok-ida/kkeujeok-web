import { describe, expect, test } from 'vitest'
import type { RootResult } from '../src/drive/rootFolder'
import { createRootFolderStore, uploadsAllowed } from '../src/drive/rootFolderStore'

function setup(first: RootResult[] = []) {
  const results = [...first]
  const pending: ((r: RootResult) => void)[] = []
  let calls = 0
  const next = () =>
    new Promise<RootResult>((resolve) => {
      calls++
      const r = results.shift()
      if (r) resolve(r)
      else pending.push(resolve)
    })
  let token: string | null = 't'
  const listeners = new Set<() => void>()
  let signIn: 'granted' | 'denied' = 'granted'
  const auth = {
    getState: () => ({ token }) as never,
    subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
    signIn: async () => signIn,
  }
  let t = 1_000_000
  const store = createRootFolderStore({ service: { checkRoot: next, recreate: next }, auth, now: () => t })
  const seen: string[] = []
  store.subscribe(() => seen.push(store.getState().status))
  return {
    store,
    seen,
    calls: () => calls,
    answer: (r: RootResult) => pending.shift()!(r),
    advance: (ms: number) => void (t += ms),
    signOut() {
      token = null
      listeners.forEach((f) => f())
    },
    setSignIn: (v: 'granted' | 'denied') => void (signIn = v),
  }
}
const ready: RootResult = { status: 'ready', folderId: 'r' }

describe('rootFolderStore', () => {
  test('first check shows preparing, then the result', async () => {
    const h = setup([ready])
    await h.store.check()
    expect(h.seen).toEqual(['preparing', 'ready'])
    expect(h.store.getState()).toEqual({ status: 'ready', folderId: 'r' })
    expect(uploadsAllowed(h.store)).toBe(true)
  })

  test('a re-check of a known root never flashes preparing; failed and missing block uploads', async () => {
    const h = setup([ready, { status: 'missing' }, { status: 'failed', errorClass: 'backoff' }])
    await h.store.check()
    h.seen.length = 0
    await h.store.check()
    expect(h.seen).toEqual(['missing'])
    expect(uploadsAllowed(h.store)).toBe(false)
    await h.store.reportRootGone()
    expect(h.store.getState()).toEqual({ status: 'failed', errorClass: 'backoff' })
    expect(uploadsAllowed(h.store)).toBe(false)
  })

  test('a failed root shows preparing again on retry', async () => {
    const h = setup([{ status: 'failed', errorClass: 'backoff' }, ready])
    await h.store.check()
    h.seen.length = 0
    await h.store.check()
    expect(h.seen).toEqual(['preparing', 'ready'])
  })

  test('foreground re-checks are throttled to 30 s for ready and missing only', async () => {
    const h = setup([ready, ready, { status: 'failed', errorClass: 'backoff' }, ready])
    await h.store.checkForeground()
    expect(h.calls()).toBe(1)
    h.advance(29_999)
    await h.store.checkForeground()
    expect(h.calls()).toBe(1) // skipped
    h.advance(1)
    await h.store.checkForeground()
    expect(h.calls()).toBe(2)
    await h.store.check() // -> failed
    h.advance(1)
    await h.store.checkForeground() // failed is never throttled
    expect(h.calls()).toBe(4)
  })

  test('sign-out resets to idle and drops a run in flight', async () => {
    const h = setup()
    const run = h.store.check()
    expect(h.store.getState().status).toBe('preparing')
    h.signOut()
    expect(h.store.getState().status).toBe('idle')
    h.answer(ready)
    await run
    expect(h.store.getState().status).toBe('idle')
  })

  test('[다시 로그인] checks again only when the sign-in was granted', async () => {
    const h = setup([ready])
    h.setSignIn('denied')
    await h.store.signInAgain()
    expect(h.calls()).toBe(0)
    h.setSignIn('granted')
    await h.store.signInAgain()
    expect(h.calls()).toBe(1)
  })

  test('recreate always shows preparing', async () => {
    const h = setup([ready, ready])
    await h.store.check()
    h.seen.length = 0
    await h.store.recreate()
    expect(h.seen).toEqual(['preparing', 'ready'])
  })
})
