// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DRIVE_SCOPE, createAuth } from '../src/drive/auth'
import { I18nContext, createI18n, resources } from '../src/i18n'
import { App } from '../src/ui/App'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cfg = { callback: (r: object) => void; error_callback: (e: { type: string }) => void }
// What the mocked popup does once requestAccessToken() is called.
let popup: (c: Cfg) => void
let initCalls = 0
const initTokenClient = vi.fn((cfg: Cfg & { scope: string }) => {
  initCalls++
  return { requestAccessToken: () => popup(cfg) }
})
let granted = true

beforeEach(() => {
  initCalls = 0
  granted = true
  ;(globalThis as { google?: unknown }).google = {
    accounts: { oauth2: { initTokenClient, hasGrantedAllScopes: () => granted } },
  }
})

let host: HTMLElement | undefined
let root: ReturnType<typeof createRoot> | undefined
afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  root = host = undefined
  history.replaceState(null, '', '/')
})

function mount(opts: { clientId?: string; loadScript?: () => Promise<void> } = {}) {
  const auth = createAuth({
    clientId: 'clientId' in opts ? opts.clientId : 'cid',
    loadScript: opts.loadScript ?? (async () => {}),
  })
  const i18n = createI18n({ navigatorLanguage: 'ko-KR' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(createElement(I18nContext.Provider, { value: i18n }, createElement(App, { auth }))),
  )
  return auth
}
const click = async (label: string) => {
  const b = [...host!.querySelectorAll('button')].find((x) => x.textContent === label)!
  await act(async () => b.click())
}
const live = () => host!.querySelector('[aria-live="polite"]')!

describe('sign-in gate', () => {
  test('first visit: sign-in screen only, with name, button, hint and privacy link', () => {
    mount()
    expect(host!.querySelector('h1')!.textContent).toBe('Kkeujeok')
    expect(host!.querySelector('nav')).toBeNull()
    expect(host!.querySelector('.library')).toBeNull()
    expect(host!.textContent).toContain('노트는 내 Google Drive의 Kkeujeok 폴더에 저장돼요')
    expect(host!.querySelector('a[href="/privacy"]')).not.toBeNull()
    expect(host!.querySelectorAll('button')).toHaveLength(1)
    expect(live().textContent).toBe('')
  })

  test('granted: shell appears, drive.file only, token in no browser storage', async () => {
    popup = (c) => c.callback({ access_token: 'secret-token-123' })
    const auth = mount()
    await click('Google로 로그인')
    expect(initTokenClient.mock.calls.at(-1)![0].scope).toBe(DRIVE_SCOPE)
    expect(host!.querySelector('nav')).not.toBeNull()
    expect(auth.getAccessToken()).toBe('secret-token-123')
    const stores = [localStorage, sessionStorage].map((s) => JSON.stringify({ ...s }))
    expect(stores.join() + document.cookie).not.toContain('secret-token-123')
  })

  test('reload (fresh module state) is signed out again', async () => {
    popup = (c) => c.callback({ access_token: 't' })
    mount()
    await click('Google로 로그인')
    act(() => root!.unmount())
    host!.remove()
    mount()
    expect(host!.querySelector('nav')).toBeNull()
    expect(host!.querySelector('h1')).not.toBeNull()
  })

  test('denied: explanation + [다시 요청], no entry, retry reopens consent', async () => {
    granted = false
    popup = (c) => c.callback({ access_token: 'x' })
    const auth = mount()
    await click('Google로 로그인')
    expect(live().textContent).toContain('Google Drive 접근이 거부됐어요.')
    expect(live().textContent).toContain('Kkeujeok이 만든 파일만 볼 수 있어요.')
    expect(host!.querySelector('nav')).toBeNull()
    expect(auth.getAccessToken()).toBeNull()
    await click('다시 요청')
    expect(initCalls).toBe(2)
    granted = true
    await click('다시 요청')
    expect(host!.querySelector('nav')).not.toBeNull()
  })

  test('popup closed: no message, stays on sign-in', async () => {
    popup = (c) => c.error_callback({ type: 'popup_closed' })
    mount()
    await click('Google로 로그인')
    expect(live().textContent).toBe('')
    expect(host!.querySelector('nav')).toBeNull()
  })

  test('script load failure: connection notice, retry loads the script again', async () => {
    popup = (c) => c.callback({ access_token: 't' })
    // Call 1 is the preload on mount, call 2 the click; both fail while offline.
    const loadScript = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    mount({ loadScript })
    await click('Google로 로그인')
    expect(live().textContent).toContain('연결을 확인하고 다시 시도해 주세요')
    expect(initCalls).toBe(0)
    await click('다시 시도')
    expect(loadScript).toHaveBeenCalledTimes(3)
    expect(host!.querySelector('nav')).not.toBeNull()
  })

  test('GIS error callback other than popup_closed is a network notice', async () => {
    popup = (c) => c.error_callback({ type: 'popup_failed_to_open' })
    mount()
    await click('Google로 로그인')
    expect(live().textContent).toContain('연결을 확인하고')
  })

  test('no client id: setup notice and GIS never called', async () => {
    const loadScript = vi.fn(async () => {})
    mount({ clientId: '', loadScript })
    await click('Google로 로그인')
    expect(live().textContent).toContain('로그인을 설정하지 않았어요')
    expect(loadScript).not.toHaveBeenCalled()
    expect(initCalls).toBe(0)
  })

  test('/privacy opens without signing in', () => {
    history.pushState(null, '', '/privacy')
    mount()
    expect(host!.querySelector('h1')!.textContent).toBe('Kkeujeok 개인정보처리방침')
  })

  test('sign-in keys exist in both languages', () => {
    const keys = Object.keys(resources.ko).filter((k) => k.startsWith('signin.'))
    expect(keys.length).toBe(8)
    expect(keys.filter((k) => !(k in resources.en))).toEqual([])
  })
})

describe('sign-in edge cases', () => {
  test('the consent screen refusal and other errors are told apart', async () => {
    popup = (c) => c.callback({ error: 'access_denied' })
    mount()
    await click('Google로 로그인')
    expect(live().textContent).toContain('접근이 거부됐어요')
    popup = (c) => c.callback({ error: 'invalid_request' })
    await click('다시 요청')
    expect(live().textContent).toContain('연결을 확인하고')
    expect(live().textContent).not.toContain('접근이 거부됐어요')
  })

  test('a grant without Drive is revoked and shown as denied', async () => {
    const revoke = vi.fn()
    ;(globalThis as { google?: { accounts: { oauth2: object } } }).google!.accounts.oauth2 = {
      initTokenClient,
      hasGrantedAllScopes: () => false,
      revoke,
    }
    popup = (c) => c.callback({ access_token: 'partial' })
    mount()
    await click('Google로 로그인')
    expect(revoke).toHaveBeenCalledWith('partial', expect.any(Function))
    expect(host!.querySelector('nav')).toBeNull()
  })

  test('a blank client id is "not set up" and never calls GIS', async () => {
    mount({ clientId: '   ' })
    await click('Google로 로그인')
    expect(initTokenClient).not.toHaveBeenCalled()
    expect(live().textContent).toContain('설정')
  })

  test('the previous notice is cleared while a new attempt runs', async () => {
    popup = (c) => c.callback({ error: 'access_denied' })
    mount()
    await click('Google로 로그인')
    expect(live().textContent).toContain('접근이 거부됐어요')
    popup = () => {} // popup stays open: the attempt is pending
    await click('다시 요청')
    expect(live().textContent).toBe('')
    const button = host!.querySelector('button')!
    expect(button.disabled).toBe(true)
  })

  test('the script is requested before the click, so the popup stays in the gesture', () => {
    const loadScript = vi.fn(async () => {})
    mount({ loadScript })
    expect(loadScript).toHaveBeenCalledTimes(1)
  })

  test('a failed script load is retried and the failed tag removed', async () => {
    const { loadGisScript } = await import('../src/drive/auth')
    const first = loadGisScript()
    const tag = document.head.querySelector('script[src*="gsi/client"]')!
    tag.dispatchEvent(new Event('error'))
    await expect(first).rejects.toThrow()
    expect(document.head.contains(tag)).toBe(false)
    const second = loadGisScript()
    const retry = document.head.querySelector('script[src*="gsi/client"]')!
    expect(retry).not.toBe(tag)
    retry.dispatchEvent(new Event('load'))
    await expect(second).resolves.toBeUndefined()
  })
})
