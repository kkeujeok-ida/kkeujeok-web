// Banner priority, the connection, the token flag and the Drive outcomes that feed them (Story 3.16).
import { describe, expect, test, vi } from 'vitest'
import { createAuthedDrive } from '../src/drive/authedDrive'
import { createAuth } from '../src/drive/auth'
import { createConnectivity } from '../src/drive/connectivity'
import { type DriveOutcome, createHttpDriveClient } from '../src/drive/driveClient'
import { BANNER_ORDER, pickBanner } from '../src/ui/sync/bannerPriority'

describe('pickBanner', () => {
  test('the order is the UX rule', () => {
    expect([...BANNER_ORDER]).toEqual(['conflictReadOnly', 'otherTab', 'deleted', 'newVersion', 'reauth', 'quota', 'offline'])
  })
  test('with everything on, one at a time; as each ends the next shows', () => {
    const on = { conflictReadOnly: true, otherTab: true, deleted: true, newVersion: true, reauth: true, quota: true, offline: true }
    const seen: unknown[] = []
    for (const k of BANNER_ORDER) {
      seen.push(pickBanner(on))
      on[k] = false
    }
    seen.push(pickBanner(on))
    expect(seen).toEqual(['conflictReadOnly', 'otherTab', 'deleted', 'newVersion', 'reauth', 'quota', 'offline', null])
  })
  test('lower states show alone, and nothing or bad input is no banner', () => {
    expect(pickBanner({ offline: true })).toBe('offline')
    expect(pickBanner({ quota: true, offline: true })).toBe('quota')
    expect(pickBanner({ otherTab: false })).toBeNull()
    expect(pickBanner(null)).toBeNull()
    expect(pickBanner({ offline: 'yes' } as never)).toBeNull()
  })
})

describe('connectivity', () => {
  function env(onLine = true) {
    const handlers: Record<string, () => void> = {}
    const win = {
      addEventListener: (t: string, fn: () => void) => void (handlers[t] = fn),
      removeEventListener: (t: string) => void delete handlers[t],
    }
    return { handlers, win: win as never, nav: { onLine } }
  }
  test('the offline and online events', () => {
    const e = env()
    const c = createConnectivity(e.win, e.nav)
    const heard = vi.fn()
    c.subscribe(heard)
    expect(c.getState().offline).toBe(false)
    e.handlers.offline!()
    expect(c.getState().offline).toBe(true)
    e.handlers.online!()
    expect(c.getState().offline).toBe(false)
    expect(heard).toHaveBeenCalledTimes(2)
  })
  test('starts offline when the browser says so', () => {
    const e = env(false)
    expect(createConnectivity(e.win, e.nav).getState().offline).toBe(true)
  })
  test('a network failure is offline until an online event or an answer', () => {
    const e = env()
    const c = createConnectivity(e.win, e.nav)
    c.networkFailed()
    expect(c.getState().offline).toBe(true)
    c.networkOk()
    expect(c.getState().offline).toBe(false)
    c.networkFailed()
    e.handlers.online!()
    expect(c.getState().offline).toBe(false)
  })
  test('an answer does not clear what the browser itself reports', () => {
    const e = env(false)
    const c = createConnectivity(e.win, e.nav)
    c.networkOk()
    expect(c.getState().offline).toBe(true)
  })
  test('dispose removes the listeners', () => {
    const e = env()
    createConnectivity(e.win, e.nav).dispose()
    expect(Object.keys(e.handlers)).toEqual([])
  })
})

describe('Drive outcomes', () => {
  const run = async (answer: () => Response | Promise<Response>, token: string | null = 'tok') => {
    const out: DriveOutcome[] = []
    const c = createHttpDriveClient({
      fetch: (async () => answer()) as unknown as typeof fetch,
      token: () => token,
      baseUrl: 'https://drive.test/v3',
      onOutcome: (o) => void out.push(o),
    })
    await c.get('f', { fields: 'id' }).catch(() => {})
    return out
  }
  test('an answer is ok, a thrown fetch is network, a 401 names the token it carried', async () => {
    expect(await run(() => new Response('{"id":"f"}', { status: 200 }))).toEqual([{ kind: 'ok' }])
    expect(await run(() => new Response('{}', { status: 404 }))).toEqual([{ kind: 'ok' }])
    expect(await run(() => Promise.reject(new TypeError('fetch failed')))).toEqual([{ kind: 'network' }])
    expect(await run(() => new Response('{}', { status: 401 }))).toEqual([{ kind: 'unauthorized', token: 'tok' }])
    expect(await run(() => new Response('{}', { status: 200 }), null)).toEqual([{ kind: 'unauthorized', token: null }])
  })
  test('the authed client expires the token on 401 and tells the connection', async () => {
    const markExpired = vi.fn()
    const net = { networkFailed: vi.fn(), networkOk: vi.fn() }
    const answers = [new Response('{}', { status: 401 }), new Response('{"id":"f"}', { status: 200 })]
    vi.stubGlobal('fetch', async () => answers.shift()!)
    try {
      const c = createAuthedDrive({ getAccessToken: () => 'tok', markExpired }, net)
      await c.get('f', { fields: 'id' }).catch(() => {})
      expect(markExpired).toHaveBeenCalledWith('tok')
      await c.get('f', { fields: 'id' })
      expect(net.networkOk).toHaveBeenCalled()
      vi.stubGlobal('fetch', async () => Promise.reject(new TypeError('x')))
      await c.get('f', { fields: 'id' }).catch(() => {})
      expect(net.networkFailed).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('auth: expired and reauth', () => {
  type Cfg = { callback: (r: object) => void; error_callback: (e: { type: string }) => void; hint?: string }
  const grant = (token: string) => (c: Cfg) => c.callback({ access_token: token })

  function setup(first = grant('t1')) {
    const cfgs: Cfg[] = []
    const popup = { next: first }
    ;(globalThis as { google?: unknown }).google = {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: Cfg) => (cfgs.push(cfg), { requestAccessToken: () => popup.next(cfg) }),
          hasGrantedAllScopes: () => true,
        },
      },
    }
    const who = { account: { sub: 's1', email: 'a@x.com' } as { sub: string; email: string } | null }
    const auth = createAuth({ clientId: 'cid', loadScript: async () => {}, fetchAccount: async () => who.account })
    return { auth, cfgs, popup, who }
  }

  test('only a 401 for the token in use expires it', async () => {
    const { auth } = setup()
    await auth.signIn()
    auth.markExpired('older')
    auth.markExpired(null)
    expect(auth.getState().expired).toBe(false)
    auth.markExpired('t1')
    expect(auth.getState().expired).toBe(true)
  })

  test('a granted re-request clears it, never sets busy (the shell stays) and asks with the e-mail as hint', async () => {
    const { auth, cfgs, popup } = setup()
    await auth.signIn()
    auth.markExpired('t1')
    const busy: boolean[] = []
    auth.subscribe(() => busy.push(auth.getState().busy))
    popup.next = grant('t2')
    expect(await auth.reauth()).toBe('granted')
    expect(auth.getState()).toMatchObject({ token: 't2', expired: false, busy: false })
    expect(busy).not.toContain(true)
    expect(cfgs.at(-1)!.hint).toBe('a@x.com')
  })

  test('a closed popup leaves the token and the flag', async () => {
    const { auth, popup } = setup()
    await auth.signIn()
    auth.markExpired('t1')
    popup.next = (c) => c.error_callback({ type: 'popup_closed' })
    expect(await auth.reauth()).toBe('cancelled')
    expect(auth.getState()).toMatchObject({ token: 't1', expired: true })
  })

  test('a denied request leaves the token and the flag', async () => {
    const { auth, popup } = setup()
    await auth.signIn()
    auth.markExpired('t1')
    popup.next = (c) => c.callback({ error: 'access_denied' })
    expect(await auth.reauth()).toBe('denied')
    expect(auth.getState()).toMatchObject({ token: 't1', expired: true })
  })

  test('single-flight: a second press while the popup is open opens no other', async () => {
    const { auth, cfgs, popup } = setup()
    await auth.signIn()
    let finish: () => void = () => {}
    popup.next = (c) => void (finish = () => grant('t2')(c))
    const before = cfgs.length
    const a = auth.reauth()
    await new Promise((r) => setTimeout(r, 0))
    expect(await auth.reauth()).toBe('cancelled')
    finish()
    expect(await a).toBe('granted')
    expect(cfgs.length - before).toBe(1)
  })

  test('without a token there is nothing to re-request', async () => {
    const { auth, cfgs } = setup()
    expect(await auth.reauth()).toBe('cancelled')
    expect(cfgs).toHaveLength(0)
  })

  test('another account shows in the state; a failed lookup keeps the known account', async () => {
    const { auth, who, popup } = setup()
    await auth.signIn()
    expect(auth.getState().account?.sub).toBe('s1')
    popup.next = grant('t2')
    who.account = { sub: 's2', email: 'b@x.com' }
    await auth.reauth()
    expect(auth.getState().account?.sub).toBe('s2')
    who.account = null
    popup.next = grant('t3')
    await auth.reauth()
    expect(auth.getState().account?.sub).toBe('s2')
  })

  test('sign-out clears the flag', async () => {
    const { auth } = setup()
    await auth.signIn()
    auth.markExpired('t1')
    auth.signOut()
    expect(auth.getState().expired).toBe(false)
  })
})
