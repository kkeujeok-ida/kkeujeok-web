// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createAuth } from '../src/drive/auth'
import { I18nContext, STORAGE_KEY, createI18n } from '../src/i18n'
import { createNote } from '../src/ops/ops'
import { clearSessionHistories, sessionHistory } from '../src/ops/sessionHistories'
import { NOTE_DB_NAME, deleteNoteDatabase } from '../src/storage/noteDb'
import { App } from '../src/ui/App'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root
let revokeResult: { successful?: boolean; error?: string }
const revoke = vi.fn((_t: string, done: (r?: object) => void) => done(revokeResult))
let prompts: (string | undefined)[]

beforeEach(() => {
  revokeResult = { successful: true }
  revoke.mockClear()
  prompts = []
  localStorage.clear()
  localStorage.setItem(STORAGE_KEY, 'en')
  ;(globalThis as { google?: unknown }).google = {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: { prompt?: string; callback: (r: object) => void }) => {
          prompts.push(cfg.prompt)
          return { requestAccessToken: () => cfg.callback({ access_token: 'tok' }) }
        },
        hasGrantedAllScopes: () => true,
        revoke,
      },
    },
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  await deleteNoteDatabase()
})

// Creates the note database with one record, like Epic 2 will. `yields`: the
// connection closes on versionchange, as every opener must.
function seedDb(yields = true): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(NOTE_DB_NAME, 1)
    r.onupgradeneeded = () => r.result.createObjectStore('notes').put({ a: 1 }, 'n1')
    r.onsuccess = () => {
      if (yields) r.result.onversionchange = () => r.result.close()
      resolve(r.result)
    }
    r.onerror = () => reject(r.error)
  })
}
const dbExists = async () => (await indexedDB.databases()).some((d) => d.name === NOTE_DB_NAME)

function mountApp() {
  const auth = createAuth({ clientId: 'cid', loadScript: async () => {} })
  const i18n = createI18n({ storage: localStorage, navigatorLanguage: 'ko-KR' })
  act(() => root.render(createElement(I18nContext.Provider, { value: i18n }, createElement(App, { auth }))))
  return auth
}
async function signedInApp() {
  const auth = mountApp()
  await act(async () => void (await auth.signIn()))
  return auth
}
const btn = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!
const click = (label: string) => act(async () => btn(label).click())
const dialog = () => host.querySelector('[role="dialog"]')
const dialogButtons = () => [...host.querySelectorAll<HTMLButtonElement>('.dialog button')]
// The fake IndexedDB answers on later macrotasks, so give the flow time to settle.
const confirm = () =>
  act(async () => {
    dialogButtons()[1]!.click()
    await new Promise((r) => setTimeout(r, 30))
  })
const openSettings = () => act(() => host.querySelector<HTMLButtonElement>('nav button')!.click())

describe('settings entries', () => {
  test('hidden when signed out, shown when signed in', async () => {
    const auth = mountApp()
    expect(host.textContent).not.toMatch(/Log out|Disconnect/)
    await act(async () => void (await auth.signIn()))
    openSettings()
    expect(btn('Log out')).toBeTruthy()
    expect(btn('Disconnect')).toBeTruthy()
  })
})

describe('logout', () => {
  test('deletes the note DB, keeps the language setting, shows sign-in', async () => {
    await seedDb()
    await signedInApp()
    openSettings()
    await click('Log out')
    expect(dialog()!.textContent).toContain('Logging out deletes the note copies in this browser.')
    expect(dialog()!.textContent).toContain('The note files in your Drive stay as they are.')
    await confirm()
    expect(host.querySelector('nav')).toBeNull()
    expect(host.querySelector('h1')!.textContent).toBe('Kkeujeok')
    expect(await dbExists()).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('en')
    expect(revoke).not.toHaveBeenCalled()
  })

  test('no database yet: no error, sign-in screen', async () => {
    await signedInApp()
    openSettings()
    await click('Log out')
    await confirm()
    expect(host.querySelector('nav')).toBeNull()
    expect(host.querySelector('h1')).not.toBeNull()
  })

  test('delete failure: error shown, stays in the app', async () => {
    await signedInApp()
    openSettings()
    await click('Log out')
    const spy = vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      const req = {} as IDBOpenDBRequest
      setTimeout(() => req.onerror?.(new Event('error')))
      return req
    })
    await confirm()
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))))
    spy.mockRestore()
    expect(host.querySelector('nav')).not.toBeNull()
    expect(dialog()!.textContent).toContain('Could not delete')
  })

  test('a blocked delete finishes once the other connection closes', async () => {
    const db = await seedDb(false)
    let release: (() => void) | undefined
    db.onversionchange = () => (release = () => db.close())
    const p = deleteNoteDatabase()
    let settled = false
    void p.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)
    release!()
    await p
    expect(await dbExists()).toBe(false)
  })

  test('blocked for good: rejects instead of hanging', async () => {
    const db = await seedDb(false) // never closes
    const caught = deleteNoteDatabase(indexedDB, 20).catch((e: Error) => e) as Promise<Error>
    expect((await caught).message).toBe('delete blocked')
    db.close()
  })
})

describe('disconnect', () => {
  test('revoke ok: DB deleted, sign-in shown, next sign-in asks for consent', async () => {
    await seedDb()
    const auth = await signedInApp()
    openSettings()
    await click('Disconnect')
    expect(dialog()!.textContent).toContain('The note copies on this device and your sign-in will be deleted.')
    expect(dialogButtons()[1]!.className).toContain('btn-destructive')
    await confirm()
    expect(revoke).toHaveBeenCalledWith('tok', expect.any(Function))
    expect(host.querySelector('nav')).toBeNull()
    expect(await dbExists()).toBe(false)
    await act(async () => void (await auth.signIn()))
    expect(prompts).toEqual([undefined, 'consent'])
  })

  test('revoke fails: local data kept, retry revokes again, then succeeds', async () => {
    await seedDb()
    await signedInApp()
    openSettings()
    await click('Disconnect')
    revokeResult = { error: 'network' }
    await confirm()
    expect(host.querySelector('nav')).not.toBeNull()
    expect(dialog()!.textContent).toContain('Check your connection and try again')
    expect(dialogButtons()[1]!.textContent).toBe('Try again')
    expect(await dbExists()).toBe(true)
    revokeResult = { successful: true }
    await confirm()
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(host.querySelector('nav')).toBeNull()
    expect(await dbExists()).toBe(false)
  })
})

describe('disconnect edge cases', () => {
  test('revoke ok but local delete fails: a retry does not revoke again', async () => {
    await seedDb()
    await signedInApp()
    openSettings()
    await click('Disconnect')
    const spy = vi.spyOn(indexedDB, 'deleteDatabase').mockImplementationOnce(() => {
      const req = {} as IDBOpenDBRequest
      setTimeout(() => req.onerror?.(new Event('error')))
      return req
    })
    await confirm()
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))))
    expect(dialog()!.textContent).toContain('Could not delete')
    expect(revoke).toHaveBeenCalledTimes(1)
    await confirm()
    spy.mockRestore()
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(host.querySelector('nav')).toBeNull()
    expect(await dbExists()).toBe(false)
  })

  test('Google answering "not successful" keeps local data and the session', async () => {
    await seedDb()
    await signedInApp()
    openSettings()
    await click('Disconnect')
    revokeResult = { successful: false }
    await confirm()
    expect(host.querySelector('nav')).not.toBeNull()
    expect(await dbExists()).toBe(true)
  })

  test('revoke that never answers fails after the timeout instead of hanging', async () => {
    const auth = createAuth({ clientId: 'cid', loadScript: async () => {}, revokeTimeoutMs: 20 })
    await auth.signIn()
    revoke.mockImplementationOnce(() => {}) // never calls back
    expect(await auth.disconnect()).toBe('failed')
    expect(auth.getAccessToken()).toBe('tok')
  })

  test('a GIS without revoke, or a signed-out auth, is a failure, not a success', async () => {
    const signedOut = createAuth({ clientId: 'cid', loadScript: async () => {} })
    expect(await signedOut.disconnect()).toBe('failed')
    const auth = createAuth({ clientId: 'cid', loadScript: async () => {} })
    await auth.signIn()
    const g = globalThis as { google?: { accounts: { oauth2: { revoke?: unknown } } } }
    delete g.google!.accounts.oauth2.revoke
    expect(await auth.disconnect()).toBe('failed')
  })
})

describe('dialog', () => {
  test('default focus Cancel, Tab trapped, Esc closes, focus back on the opener', async () => {
    await signedInApp()
    openSettings()
    const opener = btn('Log out')
    await click('Log out')
    const [cancel, ok] = dialogButtons() as unknown as [HTMLElement, HTMLElement]
    expect(document.activeElement).toBe(cancel)
    const key = (k: string, shiftKey = false) =>
      act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true })))
    key('Tab')
    expect(document.activeElement).toBe(ok)
    key('Tab')
    expect(document.activeElement).toBe(cancel)
    key('Tab', true)
    expect(document.activeElement).toBe(ok)
    key('Escape')
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(host.querySelector('nav')).not.toBeNull()
  })

  test('Cancel changes nothing', async () => {
    await signedInApp()
    openSettings()
    await click('Disconnect')
    await click('Cancel')
    expect(dialog()).toBeNull()
    expect(revoke).not.toHaveBeenCalled()
    expect(host.querySelector('nav')).not.toBeNull()
  })
})

describe('session undo history', () => {
  const note = () => {
    const r = createNote({
      title: 't',
      existingTitles: [],
      background: 'plain',
      orientation: 'portrait',
      noteId: 'n1',
      pageId: 'p',
      pageRev: 'r',
      metaRev: 'm',
      orderRev: 'o',
      now: '2026-10-11T00:00:00.000Z',
      editedBy: 'x',
    })
    if ('error' in r) throw new Error(r.error)
    return r.note
  }
  afterEach(() => clearSessionHistories())

  test('logout clears the histories', async () => {
    const h = sessionHistory(note())
    await signedInApp()
    openSettings()
    await click('Log out')
    await confirm()
    expect(host.querySelector('nav')).toBeNull()
    expect(sessionHistory(note())).not.toBe(h)
  })

  test('a failed delete keeps them', async () => {
    const h = sessionHistory(note())
    await signedInApp()
    openSettings()
    await click('Log out')
    const spy = vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      const req = {} as IDBOpenDBRequest
      setTimeout(() => req.onerror?.(new Event('error')))
      return req
    })
    await confirm()
    // poll for the error instead of guessing a delay
    for (let i = 0; i < 100 && !dialog()?.textContent?.includes('Could not delete'); i++) {
      await act(async () => void (await new Promise((r) => setTimeout(r, 10))))
    }
    spy.mockRestore()
    expect(dialog()!.textContent).toContain('Could not delete')
    expect(sessionHistory(note())).toBe(h)
  })

  test('disconnect clears the histories too', async () => {
    const h = sessionHistory(note())
    await signedInApp()
    openSettings()
    await click('Disconnect')
    await confirm()
    expect(revoke).toHaveBeenCalled()
    expect(host.querySelector('nav')).toBeNull()
    expect(sessionHistory(note())).not.toBe(h)
  })
})
