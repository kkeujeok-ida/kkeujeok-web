// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createAuth } from '../src/drive/auth'
import { I18nContext, STORAGE_KEY, createI18n } from '../src/i18n'
import { NOTE_DB_NAME, deleteNoteDatabase } from '../src/storage/noteDb'
import { openNoteStore } from '../src/storage/noteStore'
import { emptySync } from '../src/storage/syncInfo'
import { countUnsent } from '../src/sync/unsent'
import { App } from '../src/ui/App'
import { mkNote } from './uploadHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const N1 = '01926f3a-0000-7000-8000-0000000000a1'
const N2 = '01926f3a-0000-7000-8000-0000000000a2'
const N3 = '01926f3a-0000-7000-8000-0000000000a3'

let host: HTMLElement
let root: Root
const revoke = vi.fn((_t: string, done: (r?: object) => void) => done({ successful: true }))

beforeEach(() => {
  revoke.mockClear()
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
  localStorage.clear()
  localStorage.setItem(STORAGE_KEY, 'en')
  ;(globalThis as { google?: unknown }).google = {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: { callback: (r: object) => void }) => ({ requestAccessToken: () => cfg.callback({ access_token: 'tok' }) }),
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
  vi.unstubAllGlobals()
  await deleteNoteDatabase()
})

async function seed(unsent: string[], clean: string[] = []) {
  const store = openNoteStore()
  for (const id of unsent) await store.writeNote(mkNote({ noteId: id }))
  for (const id of clean) {
    const n = mkNote({ noteId: id })
    await store.commitSync(n, n, { ...emptySync(), fileId: 'f', baseHeadRevisionId: 'rev1', state: 'synced' })
  }
  store.close()
}
const dbExists = async () => (await indexedDB.databases()).some((x) => x.name === NOTE_DB_NAME)

async function mount(unsentIds?: () => Promise<string[] | null>) {
  const auth = createAuth({ clientId: 'cid', loadScript: async () => {} })
  const i18n = createI18n({ storage: localStorage, navigatorLanguage: 'en-US' })
  act(() =>
    root.render(createElement(I18nContext.Provider, { value: i18n }, createElement(App, { auth, ...(unsentIds && { unsentIds }) }))),
  )
  await act(async () => void (await auth.signIn()))
  act(() => host.querySelector<HTMLButtonElement>('nav button')!.click())
  return auth
}
const btn = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!
const dialog = () => host.querySelector('[role="dialog"]')
const dialogButtons = () => [...host.querySelectorAll<HTMLButtonElement>('.dialog button')]
const click = (el: HTMLElement) =>
  act(async () => {
    el.click()
    await new Promise((r) => setTimeout(r, 40))
  })
const esc = () => act(() => void dialog()!.parentElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

describe('countUnsent', () => {
  test('counts never-uploaded and unreadable notes, not synced ones', async () => {
    await seed([N1, N2], [N3])
    const store = openNoteStore()
    expect((await countUnsent(store, async () => {}))!.sort()).toEqual([N1, N2])
    await new Promise<void>((res) => {
      const r = indexedDB.open(NOTE_DB_NAME)
      r.onsuccess = () => {
        const tx = r.result.transaction('notes', 'readwrite')
        tx.objectStore('notes').put({ a: 1 }, 'bad')
        tx.oncomplete = () => (r.result.close(), res())
      }
    })
    expect((await countUnsent(store, async () => {}))!.sort()).toEqual([N1, N2, 'bad'])
    store.close()
  })

  test('null when the notes cannot be listed; the flush runs first', async () => {
    const order: string[] = []
    const r = await countUnsent(
      { listIds: async () => (order.push('list'), Promise.reject(new Error('x'))), readSync: async () => ({}) as never },
      async () => void order.push('flush'),
    )
    expect(r).toBeNull()
    expect(order).toEqual(['flush', 'list'])
  })
})

describe('logout with unsent changes', () => {
  test('warning with N, focus on Cancel, two steps, nothing deleted before the second press', async () => {
    await seed([N1, N2], [N3])
    const auth = await mount()
    await click(btn('Log out'))
    expect(dialog()!.textContent).toContain('2 unsent changes. Logging out discards them.')
    expect(dialogButtons().map((b) => b.textContent)).toEqual(['Cancel', 'Discard and log out'])
    expect(dialogButtons()[1]!.className).toContain('btn-destructive')
    expect(document.activeElement).toBe(dialogButtons()[0])
    await click(dialogButtons()[1]!)
    expect(dialogButtons()[1]!.textContent).toBe('Press again to discard')
    expect(await dbExists()).toBe(true)
    expect(auth.getState().token).toBe('tok')
    await click(dialogButtons()[1]!)
    expect(await dbExists()).toBe(false)
    expect(auth.getState().token).toBeNull()
  })

  test('Esc cancels and keeps everything', async () => {
    await seed([N1])
    const auth = await mount()
    await click(btn('Log out'))
    esc()
    expect(dialog()).toBeNull()
    expect(await dbExists()).toBe(true)
    expect(auth.getState().token).toBe('tok')
  })

  test('Tab stays inside the warning', async () => {
    await seed([N1])
    await mount()
    await click(btn('Log out'))
    dialog()!.parentElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(dialogButtons()[1])
    dialog()!.parentElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(dialogButtons()[0])
  })

  test('nothing unsent: the Story 1.12 confirmation, one step', async () => {
    await seed([], [N3])
    const auth = await mount()
    await click(btn('Log out'))
    expect(dialog()!.textContent).toContain('Logging out deletes the note copies in this browser.')
    await click(dialogButtons()[1]!)
    expect(auth.getState().token).toBeNull()
    expect(await dbExists()).toBe(false)
  })

  test('count unknown: warns without a number', async () => {
    await mount(async () => null)
    await click(btn('Log out'))
    expect(dialog()!.textContent).toContain('Could not check for unsent changes.')
    expect(dialogButtons()[1]!.textContent).toBe('Discard and log out')
  })

  test('a second press while counting is ignored', async () => {
    let release!: (ids: string[]) => void
    const unsentIds = vi.fn(() => new Promise<string[]>((r) => (release = r)))
    await mount(unsentIds)
    act(() => {
      btn('Log out').click()
      btn('Disconnect').click()
    })
    expect(unsentIds).toHaveBeenCalledTimes(1)
    await act(async () => release([N1]))
    expect(dialog()!.textContent).toContain('Logging out discards them.')
  })

  test('closing Settings while counting shows no dialog afterwards', async () => {
    let release!: (ids: string[]) => void
    await mount(() => new Promise<string[]>((r) => (release = r)))
    act(() => btn('Log out').click())
    act(() => btn('Close').click())
    await act(async () => release([N1]))
    expect(dialog()).toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('nav button')!.click())
    expect(dialog()).toBeNull()
  })
})

describe('disconnect with unsent changes', () => {
  test('only the two-step discard-and-disconnect; Google is revoked only at the second press', async () => {
    await seed([N1])
    const auth = await mount()
    await click(btn('Disconnect'))
    expect(dialog()!.textContent).toContain('1 unsent changes. Disconnecting discards them.')
    expect(dialog()!.textContent).toContain('The note files in your Drive stay as they are.')
    expect(dialogButtons().map((b) => b.textContent)).toEqual(['Cancel', 'Discard and disconnect'])
    expect(document.activeElement).toBe(dialogButtons()[0])
    await click(dialogButtons()[1]!)
    expect(revoke).not.toHaveBeenCalled()
    expect(await dbExists()).toBe(true)
    await click(dialogButtons()[1]!)
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(await dbExists()).toBe(false)
    expect(auth.getState().token).toBeNull()
  })
})
