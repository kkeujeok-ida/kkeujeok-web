// @vitest-environment jsdom
// Story 11.8: a reload signs in again silently from a "signed in before" mark; no token is stored.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SIGNED_IN_KEY, createAuth } from '../src/drive/auth'

type Cfg = { prompt?: string; hint?: string; callback: (r: object) => void; error_callback: (e: { type: string }) => void }
let popup: (c: Cfg) => void
const initTokenClient = vi.fn((cfg: Cfg) => ({ requestAccessToken: () => popup(cfg) }))
const account = { sub: 's1', email: 'a@x.com' }
const make = () =>
  createAuth({ clientId: 'cid', loadScript: async () => {}, fetchAccount: async () => account, restoreTimeoutMs: 50 })

beforeEach(() => {
  localStorage.clear()
  initTokenClient.mockClear()
  ;(globalThis as { google?: unknown }).google = { accounts: { oauth2: { initTokenClient, hasGrantedAllScopes: () => true } } }
})
afterEach(() => localStorage.clear())

describe('login persistence', () => {
  test('sign-in stores the mark only, never the token', async () => {
    popup = (c) => c.callback({ access_token: 'secret-token-123' })
    await make().signIn()
    expect(localStorage.getItem(SIGNED_IN_KEY)).toBe(JSON.stringify(account))
    const all = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })
    expect(all).not.toContain('secret-token-123')
  })

  test('reload: silent token with prompt "" and the hint', async () => {
    localStorage.setItem(SIGNED_IN_KEY, JSON.stringify(account))
    popup = (c) => c.callback({ access_token: 't2' })
    const auth = make()
    expect(auth.getState().restoring).toBe(true)
    await auth.restore()
    const cfg = initTokenClient.mock.calls[0]![0]
    expect([cfg.prompt, cfg.hint]).toEqual(['', 'a@x.com'])
    expect(auth.getState()).toMatchObject({ token: 't2', account, expired: false, restoring: false })
  })

  test.each([
    ['popup blocked', (c: Cfg) => c.error_callback({ type: 'popup_failed_to_open' })],
    ['no answer', () => {}],
  ])('silent sign-in fails (%s): expired without token, mark kept, reauth allowed', async (_n, p) => {
    localStorage.setItem(SIGNED_IN_KEY, JSON.stringify(account))
    popup = p
    const auth = make()
    await auth.restore()
    expect(auth.getState()).toMatchObject({ token: null, account, expired: true, restoring: false })
    expect(localStorage.getItem(SIGNED_IN_KEY)).not.toBeNull()
    popup = (c) => c.callback({ access_token: 't3' })
    expect(await auth.reauth()).toBe('granted')
    expect(auth.getState()).toMatchObject({ token: 't3', expired: false })
  })

  test('no mark: nothing happens; sign-out and disconnect clear the mark', async () => {
    const auth = make()
    expect(auth.getState().restoring).toBe(false)
    await auth.restore()
    expect(initTokenClient).not.toHaveBeenCalled()

    localStorage.setItem(SIGNED_IN_KEY, '{"sub":"s1","email":""}')
    auth.signOut()
    expect(localStorage.getItem(SIGNED_IN_KEY)).toBeNull()

    popup = (c) => c.callback({ access_token: 't' })
    await auth.signIn()
    expect(localStorage.getItem(SIGNED_IN_KEY)).not.toBeNull()
    ;(globalThis as unknown as { google: { accounts: { oauth2: { revoke: unknown } } } }).google.accounts.oauth2.revoke = (_t: string, done: (r: object) => void) => done({ successful: true })
    expect(await auth.disconnect()).toBe('revoked')
    expect(localStorage.getItem(SIGNED_IN_KEY)).toBeNull()
  })
})
