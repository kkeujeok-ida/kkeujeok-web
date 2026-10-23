// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createAuth } from '../src/drive/auth'
import { I18nContext, STORAGE_KEY, createI18n } from '../src/i18n'
import { NOTE_DB_NAME, deleteNoteDatabase, openNoteDb } from '../src/storage/noteDb'
import { openNoteStore } from '../src/storage/noteStore'
import { emptySync } from '../src/storage/syncInfo'
import { createSyncDeviceStore } from '../src/storage/syncDevice'
import { maskEmail, type GateDeps } from '../src/ui/AccountGate'
import { App } from '../src/ui/App'
import { mkNote } from './uploadHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Acct = { sub: string; email: string }
const A: Acct = { sub: 'sA', email: 'alice@example.test' }
const B: Acct = { sub: 'sB', email: 'bob@example.test' }
const N1 = '01926f3a-0000-7000-8000-0000000000a1'
const N2 = '01926f3a-0000-7000-8000-0000000000a2'
const N3 = '01926f3a-0000-7000-8000-0000000000a3'
const wait = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))

let host: HTMLElement
let root: Root
let account: Acct | null
let fetchAccount: () => Promise<Acct | null>
let fetchSpy: ReturnType<typeof vi.fn>
let grant = 'tok'

beforeEach(() => {
  account = B
  grant = 'tok'
  fetchAccount = async () => account
  fetchSpy = vi.fn(() => Promise.reject(new Error('offline')))
  vi.stubGlobal('fetch', fetchSpy)
  localStorage.clear()
  localStorage.setItem(STORAGE_KEY, 'en')
  ;(globalThis as { google?: unknown }).google = {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: { callback: (r: object) => void }) => ({ requestAccessToken: () => cfg.callback({ access_token: grant }) }),
        hasGrantedAllScopes: () => true,
        revoke: (_t: string, done: (r?: object) => void) => done({ successful: true }),
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

/** Tags the browser with `who`; stores an unsent note per id in `unsent` and a synced one per id in `clean`. */
async function seed(who: Acct | null, unsent: string[], clean: string[] = []) {
  const store = openNoteStore(indexedDB, { getAccount: () => who })
  for (const id of unsent) await store.writeNote(mkNote({ noteId: id, title: `n ${id.slice(-1)}` }))
  for (const id of clean) {
    const n = mkNote({ noteId: id, title: `c ${id.slice(-1)}` })
    await store.commitSync(n, n, { ...emptySync(), fileId: 'f', baseHeadRevisionId: 'rev1', state: 'synced' })
  }
  store.close()
}

function deps(over: Partial<GateDeps> = {}) {
  const deleteData = vi.fn(() => deleteNoteDatabase())
  const saveFile = vi.fn()
  const d: GateDeps = { device: createSyncDeviceStore(openNoteDb()), store: openNoteStore(), deleteData, saveFile, ...over }
  return { d, deleteData, saveFile }
}

function render(auth: ReturnType<typeof createAuth>, d: GateDeps) {
  const i18n = createI18n({ storage: localStorage, navigatorLanguage: 'en-US' })
  act(() => root.render(createElement(I18nContext.Provider, { value: i18n }, createElement(App, { auth, gate: d }))))
}
async function mount(d: GateDeps) {
  const auth = createAuth({ clientId: 'cid', loadScript: async () => {}, fetchAccount })
  render(auth, d)
  await act(async () => void (await auth.signIn()))
  await wait()
  return auth
}
const dbExists = async () => (await indexedDB.databases()).some((x) => x.name === NOTE_DB_NAME)
const dialog = () => host.querySelector('[role="alertdialog"]')
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('.dialog button')]
const press = (i: number) =>
  act(async () => {
    buttons()[i]!.click()
    await new Promise((r) => setTimeout(r, 40))
  })
const key = (k: string, shiftKey = false) =>
  act(() => void dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true })))
const failOnce = (flag: { fail: boolean }) =>
  vi.fn(async () => {
    if (flag.fail) throw new Error('x')
    await deleteNoteDatabase()
  })

describe('maskEmail', () => {
  test('first character, sign, ellipsis', () => {
    expect(maskEmail('alice@example.test')).toBe('a@…')
    expect(maskEmail('')).toBe('')
    expect(maskEmail('@x')).toBe('')
  })
})

describe('silent re-authentication', () => {
  test('a new token for the same account keeps the app mounted and does not check again', async () => {
    await seed(B, [N1])
    const { d } = deps()
    const readState = vi.spyOn(d.device, 'readState')
    const auth = await mount(d)
    const nav = host.querySelector('nav')
    expect(nav).not.toBeNull()
    expect(readState).toHaveBeenCalledTimes(1)
    grant = 'tok2'
    await act(async () => void (await auth.reauth()))
    await wait()
    expect(auth.getState().token).toBe('tok2')
    expect(host.querySelector('nav')).toBe(nav) // same element: not unmounted
    expect(readState).toHaveBeenCalledTimes(1)
  })
})

describe('account mismatch with unsent changes', () => {
  test('dialog shows N and the masked e-mail, default focus on go back, nothing mounts or goes out', async () => {
    await seed(A, [N1, N2], [N3])
    await mount(deps().d)
    expect(dialog()!.textContent).toContain('The previous account(a@…) has 2 unsent changes.')
    expect(buttons().map((b) => b.textContent)).toEqual(['Back to previous account', 'Download as files', 'Discard 2 previous changes'])
    expect(document.activeElement).toBe(buttons()[0])
    expect(host.querySelector('nav')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('Esc does not close; Tab and Shift+Tab stay inside', async () => {
    await seed(A, [N1])
    await mount(deps().d)
    key('Escape')
    expect(dialog()).not.toBeNull()
    key('Tab', true)
    expect(document.activeElement).toBe(buttons()[2])
    key('Tab')
    expect(document.activeElement).toBe(buttons()[0])
    key('Tab')
    expect(document.activeElement).toBe(buttons()[1])
  })

  test('go back drops the token, shows sign-in and keeps the data', async () => {
    await seed(A, [N1])
    const { d, deleteData } = deps()
    const auth = await mount(d)
    await press(0)
    expect(auth.getState().token).toBeNull()
    expect(host.querySelector('h1')!.textContent).toBe('Kkeujeok')
    expect(dialog()).toBeNull()
    expect(deleteData).not.toHaveBeenCalled()
    expect(await d.store.listIds()).toEqual([N1])
  })

  test('download saves one .kkj per unsent note only and keeps the dialog', async () => {
    await seed(A, [N1, N2], [N3])
    const { d, saveFile } = deps()
    await mount(d)
    await press(1)
    const names = saveFile.mock.calls.map((c) => c[0] as string).sort()
    expect(names).toEqual([`n 1-${N1.slice(0, 8)}.kkj`, `n 2-${N2.slice(0, 8)}.kkj`])
    expect((saveFile.mock.calls[0]![1] as Uint8Array).length).toBeGreaterThan(0)
    expect(dialog()).not.toBeNull()
  })

  test('a second download press while one runs is ignored', async () => {
    await seed(A, [N1])
    const real = openNoteStore()
    const loadNote = vi.fn(async (id: string) => (await new Promise((r) => setTimeout(r, 50)), real.loadNote(id)))
    const { d, saveFile } = deps({ store: { listIds: () => real.listIds(), readSync: (id) => real.readSync(id), loadNote } })
    await mount(d)
    await act(async () => {
      buttons()[1]!.click()
      buttons()[1]!.click()
      await new Promise((r) => setTimeout(r, 150))
    })
    expect(saveFile).toHaveBeenCalledTimes(1)
  })

  test('a note that cannot be exported shows an error', async () => {
    await seed(A, [N1])
    const { d } = deps({
      saveFile: () => {
        throw new Error('no')
      },
    })
    await mount(d)
    await press(1)
    expect(dialog()!.textContent).toContain('Some notes could not be downloaded.')
  })

  test('discard is two steps: nothing is deleted at the first press, the second deletes and opens the app', async () => {
    await seed(A, [N1])
    const { d, deleteData } = deps()
    await mount(d)
    await press(2)
    expect(buttons()[2]!.textContent).toBe('Press again to discard')
    expect(document.activeElement).toBe(buttons()[0]) // never the discard button
    expect(deleteData).not.toHaveBeenCalled()
    expect(await dbExists()).toBe(true)
    await press(2)
    expect(deleteData).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()
    expect(host.querySelector('nav')).not.toBeNull()
  })

  test('a failed delete keeps the dialog with an error; pressing again retries', async () => {
    await seed(A, [N1])
    const flag = { fail: true }
    await mount(deps({ deleteData: failOnce(flag) }).d)
    await press(2)
    await press(2)
    expect(dialog()!.textContent).toContain('Could not delete')
    flag.fail = false
    await press(2)
    expect(dialog()).toBeNull()
  })

  test('a double press on discard deletes once', async () => {
    await seed(A, [N1])
    const deleteData = vi.fn(() => new Promise<void>((r) => setTimeout(r, 60)))
    const { d } = deps({ deleteData })
    await mount(d)
    await press(2)
    await act(async () => {
      buttons()[2]!.click()
      buttons()[2]!.click()
      await new Promise((r) => setTimeout(r, 100))
    })
    expect(deleteData).toHaveBeenCalledTimes(1)
  })

  test('notes that cannot be listed: warns without a number and never deletes silently', async () => {
    await seed(A, [N1])
    const { d, deleteData } = deps({
      store: { listIds: () => Promise.reject(new Error('x')), readSync: async () => Promise.reject(new Error('x')), loadNote: async () => null },
    })
    await mount(d)
    expect(dialog()!.textContent).toContain('Could not check whether the previous account(a@…) has unsent changes.')
    expect(buttons()[2]!.textContent).toBe('Discard previous changes')
    expect(deleteData).not.toHaveBeenCalled()
  })
})

describe('account mismatch without unsent changes', () => {
  test('the data is deleted without asking and the shell opens', async () => {
    await seed(A, [], [N3])
    const { d, deleteData } = deps()
    await mount(d)
    expect(deleteData).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()
    expect(host.querySelector('nav')).not.toBeNull()
  })

  test('a failed silent delete blocks with a retry that deletes', async () => {
    await seed(A, [], [N3])
    const flag = { fail: true }
    await mount(deps({ deleteData: failOnce(flag) }).d)
    expect(dialog()!.textContent).toContain('Could not delete')
    expect(host.querySelector('nav')).toBeNull()
    flag.fail = false
    await press(1)
    expect(dialog()).toBeNull()
    expect(host.querySelector('nav')).not.toBeNull()
  })
})

describe('a recheck that fails', () => {
  test('keeps the previous verdict instead of opening the app, and a retry while one runs is ignored', async () => {
    await seed(A, [], [N3])
    const flag = { fail: true }
    const { d } = deps({ deleteData: failOnce(flag) })
    await mount(d)
    expect(dialog()!.textContent).toContain('Could not delete')
    const real = d.device.readState.bind(d.device)
    const readState = vi.spyOn(d.device, 'readState').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60))
      throw new Error('x')
    })
    await act(async () => {
      buttons()[1]!.click()
      buttons()[1]!.click() // while the first recheck runs
      await new Promise((r) => setTimeout(r, 150))
    })
    expect(readState).toHaveBeenCalledTimes(1)
    expect(dialog()!.textContent).toContain('Could not delete') // not failed open
    expect(host.querySelector('nav')).toBeNull()
    readState.mockImplementation(real)
    flag.fail = false
    await press(1)
    expect(dialog()).toBeNull()
  })
})

describe('nothing to compare', () => {
  test('same account: shell opens, nothing deleted', async () => {
    await seed(A, [N1])
    account = A
    const { d, deleteData } = deps()
    await mount(d)
    expect(deleteData).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
    expect(host.querySelector('nav')).not.toBeNull()
  })

  test('untagged data: nothing deleted', async () => {
    await seed(null, [N1])
    const { d, deleteData } = deps()
    await mount(d)
    expect(deleteData).not.toHaveBeenCalled()
    expect(host.querySelector('nav')).not.toBeNull()
  })

  test('no device record at all', async () => {
    const { d, deleteData } = deps()
    await mount(d)
    expect(deleteData).not.toHaveBeenCalled()
    expect(host.querySelector('nav')).not.toBeNull()
  })

  test('unreadable device record: nothing is deleted', async () => {
    await seed(A, [N1])
    await new Promise<void>((res) => {
      const r = indexedDB.open(NOTE_DB_NAME)
      r.onsuccess = () => {
        const tx = r.result.transaction('device', 'readwrite')
        tx.objectStore('device').put('garbage', 'device')
        tx.oncomplete = () => (r.result.close(), res())
      }
    })
    const { d, deleteData } = deps()
    await mount(d)
    expect(deleteData).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
    expect(host.querySelector('nav')).not.toBeNull()
  })

  test('device record read fails: nothing is deleted', async () => {
    const { d, deleteData } = deps({ device: { readState: async () => ({ kind: 'failed' as const }) } })
    await mount(d)
    expect(deleteData).not.toHaveBeenCalled()
    expect(host.querySelector('nav')).not.toBeNull()
  })

  test('account lookup failed: unknown account, no gate', async () => {
    await seed(A, [N1])
    account = null
    const { d, deleteData } = deps()
    await mount(d)
    expect(deleteData).not.toHaveBeenCalled()
    expect(host.querySelector('nav')).not.toBeNull()
  })
})

describe('timing guards', () => {
  test('the shell does not mount while the account lookup is still running', async () => {
    await seed(A, [N1])
    let release!: (a: Acct) => void
    fetchAccount = () => new Promise((r) => (release = r))
    const auth = createAuth({ clientId: 'cid', loadScript: async () => {}, fetchAccount })
    render(auth, deps().d)
    let signing!: Promise<unknown>
    await act(async () => void (signing = auth.signIn()))
    await wait()
    expect(auth.getState().token).toBe('tok')
    expect(host.querySelector('nav')).toBeNull()
    await act(async () => {
      release(B)
      await signing
    })
    await wait()
    expect(dialog()).not.toBeNull()
    expect(host.querySelector('nav')).toBeNull()
  })

  test('signing out while the unsent notes are counted deletes nothing and shows nothing', async () => {
    let release!: (ids: string[]) => void
    const { d, deleteData } = deps({
      device: { readState: async () => ({ kind: 'ok' as const, device: { sub: A.sub, email: A.email } as never }) },
      store: { listIds: () => new Promise((r) => (release = r)), readSync: async () => ({}) as never, loadNote: async () => null },
    })
    const auth = await mount(d)
    auth.signOut()
    await wait()
    await act(async () => release([]))
    await wait()
    expect(deleteData).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
    expect(host.querySelector('nav')).toBeNull()
  })

  test('a result of an earlier sign-in is not reused for the next one', async () => {
    await seed(A, [N1])
    const { d } = deps()
    const auth = await mount(d)
    expect(dialog()).not.toBeNull()
    auth.signOut()
    account = A
    await act(async () => void (await auth.signIn()))
    await wait()
    expect(dialog()).toBeNull()
    expect(host.querySelector('nav')).not.toBeNull()
  })
})
