// @vitest-environment jsdom
// Library: grid, fab menu, new-note sheet, editor entry point (story 2.9).
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import type { Note } from '../src/model/note'
import { createNote } from '../src/ops/ops'
import { createNewNoteDefaults, NEW_NOTE_DEFAULTS_KEY } from '../src/storage/newNoteDefaults'
import { NOTE_DB_NAME, deleteNoteDatabase } from '../src/storage/noteDb'
import { type NoteStore, openNoteStore } from '../src/storage/noteStore'
import { App } from '../src/ui/App'
import { Library } from '../src/ui/library/Library'
import { NoteEditorStub, parseNoteRoute } from '../src/ui/library/NoteEditorStub'
import { detectEditedBy, latestEditedMs, sortItems, toItem } from '../src/ui/library/useLibrary'
import { signedIn } from './helpers'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root
let stores: NoteStore[] = []

const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
const flush = async () => {
  await settle()
  await settle()
}

function i18nFor(lang: string) {
  return createI18n({ navigatorLanguage: lang, storage: { getItem: () => null, setItem: () => {} } })
}

type Opts = Parameters<typeof openNoteStore>[1]
const makeOpen = (opts: Opts = {}) => () => {
  const s = openNoteStore(undefined, opts)
  stores.push(s)
  return s
}
const memStorage = () => {
  const m = new Map<string, string>()
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

async function mountLibrary(o: { lang?: string; afterPut?: NonNullable<Opts>['afterPut']; storage?: ReturnType<typeof memStorage> } = {}) {
  const storage = o.storage ?? memStorage()
  const defaults = createNewNoteDefaults(storage)
  const openStore = makeOpen({ afterPut: o.afterPut })
  act(() =>
    root.render(
      createElement(
        I18nContext.Provider,
        { value: i18nFor(o.lang ?? 'ko-KR') },
        createElement(Library, { openStore, defaults, editedBy: 'Chrome, Windows' }),
      ),
    ),
  )
  await flush()
  return { storage, defaults }
}

const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)
const qa = <T extends Element = HTMLElement>(sel: string) => [...host.querySelectorAll<T>(sel)]
const dialog = () => q('[role="dialog"]')
const fabButton = () => q<HTMLButtonElement>('.fab-button')!
const click = (el: Element) => act(() => (el as HTMLElement).click())
const key = (el: Element | Document, k: string, init: KeyboardEventInit = {}) =>
  act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })))
const typeInto = (el: HTMLInputElement, v: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
const buttonByText = (text: string) => qa<HTMLButtonElement>('button').find((b) => b.textContent === text)!
const titleInput = () => q<HTMLInputElement>('input[type="text"]')!

async function openSheetViaFab() {
  click(fabButton())
  click(q('[role="menuitem"]')!)
}

const mk = (noteId: string, title: string, editedAt: unknown, pageCount = 1): Note => {
  const r = createNote({
    title,
    existingTitles: [],
    background: 'plain',
    orientation: 'portrait',
    noteId,
    pageId: `${noteId}-p`,
    pageRev: 'r',
    metaRev: 'm',
    orderRev: 'o',
    now: '2026-10-10T04:20:00.000Z',
    editedBy: 'Chrome, Windows',
  })
  if ('error' in r) throw new Error(r.error)
  const note = r.note
  note.pages[0]!.editedAt = editedAt as string
  for (let i = 1; i < pageCount; i++) note.pages.push({ ...note.pages[0]!, id: `${noteId}-p${i}` })
  return note
}
async function seed(notes: Note[]) {
  const s = openNoteStore()
  for (const n of notes) await s.writeNote(n)
  s.close()
}
function putRaw(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(NOTE_DB_NAME, 1)
    r.onupgradeneeded = () => r.result.createObjectStore('notes')
    r.onsuccess = () => {
      const db = r.result
      const tx = db.transaction('notes', 'readwrite')
      tx.objectStore('notes').put(value, key)
      tx.oncomplete = () => (db.close(), resolve())
      tx.onerror = () => reject(tx.error)
    }
  })
}
async function allNotes() {
  const s = openNoteStore()
  const list = await s.listNotes()
  s.close()
  return list
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  location.hash = ''
})
afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  for (const s of stores) s.close()
  stores = []
  await deleteNoteDatabase()
})

describe('empty library', () => {
  test('one [new note] card and the fab; no header button; plain/portrait preselected', async () => {
    await mountLibrary()
    expect(qa('.cover-card')).toHaveLength(1)
    expect(q('.cover-card')!.textContent).toBe('새 노트')
    expect(fabButton().getAttribute('aria-label')).toBe('노트 추가')
    expect(q('header')).toBeNull()
    expect(qa('button').filter((b) => b.textContent === '새 노트')).toHaveLength(1) // the card only

    click(q('.cover-card')!)
    expect(dialog()).not.toBeNull()
    expect(document.activeElement).toBe(titleInput())
    expect(qa<HTMLInputElement>('input[type="radio"]').filter((r) => r.checked).map((r) => r.value)).toEqual([
      'plain',
      'portrait',
    ])
  })
})

describe('fab', () => {
  test('opens only [new note], + becomes x, veil shown; x, outside and Esc collapse; Esc focuses +', async () => {
    await mountLibrary()
    click(fabButton())
    expect(qa('[role="menuitem"]').map((m) => m.textContent)).toEqual(['새 노트'])
    expect(q('[role="menu"]')).not.toBeNull()
    expect(q('.fab-veil')).not.toBeNull()
    expect(fabButton().getAttribute('aria-expanded')).toBe('true')
    expect(fabButton().getAttribute('aria-label')).toBe('메뉴 닫기')
    expect(document.activeElement).toBe(q('[role="menuitem"]'))

    click(fabButton()) // x
    expect(q('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(fabButton())

    click(fabButton())
    click(q('.fab-veil')!) // outside
    expect(q('[role="menu"]')).toBeNull()
    expect(q('.fab-veil')).toBeNull()

    click(fabButton())
    key(document.activeElement!, 'Escape')
    expect(q('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(fabButton())
  })

  test('arrow keys stay on the single item; menu item opens the sheet', async () => {
    await mountLibrary()
    click(fabButton())
    key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(q('[role="menuitem"]'))
    key(document.activeElement!, 'ArrowUp')
    expect(document.activeElement).toBe(q('[role="menuitem"]'))
    click(q('[role="menuitem"]')!)
    expect(dialog()).not.toBeNull()
    expect(q('[role="menu"]')).toBeNull()
  })

  test('activating + or the card while the sheet is open makes no second sheet', async () => {
    await mountLibrary()
    await openSheetViaFab()
    click(fabButton())
    click(q('[role="menuitem"]')!)
    click(q('.cover-card')!)
    expect(qa('[role="dialog"]')).toHaveLength(1)
  })
})

describe('creating', () => {
  test('blank title becomes the next free "이름 없는 노트 N"; stored with the chosen page; defaults updated; entry opens', async () => {
    await seed([mk('aaa', '이름 없는 노트 1', '2026-10-01T00:00:00.000Z')])
    const { storage } = await mountLibrary()
    await openSheetViaFab()
    typeInto(titleInput(), '  ')
    click(q('input[value="grid"]')!)
    click(q('input[value="landscape"]')!)
    click(buttonByText('만들기'))
    await flush()

    const notes = await allNotes()
    const created = notes.find((n) => n.noteId !== 'aaa')!.result.note!
    expect(created.meta.title).toBe('이름 없는 노트 2')
    expect(created.pages).toHaveLength(1)
    expect(created.pages[0]).toMatchObject({ background: 'grid', width: 842, height: 595, editedBy: 'Chrome, Windows' })
    expect(location.hash).toBe(`#/notes/${created.noteId}`)
    expect(JSON.parse(storage.m.get(NEW_NOTE_DEFAULTS_KEY)!)).toEqual({ background: 'grid', orientation: 'landscape' })
    expect(dialog()).toBeNull()
  })

  test('Enter in the title creates the note', async () => {
    await mountLibrary()
    await openSheetViaFab()
    typeInto(titleInput(), '수학')
    key(titleInput(), 'Enter')
    await flush()
    expect((await allNotes()).map((n) => n.result.note!.meta.title)).toEqual(['수학'])
  })

  test('defaults of the last created note preselect the next sheet', async () => {
    const storage = memStorage()
    storage.m.set(NEW_NOTE_DEFAULTS_KEY, JSON.stringify({ background: 'dot', orientation: 'landscape' }))
    await mountLibrary({ storage })
    click(q('.cover-card')!)
    expect(qa<HTMLInputElement>('input[type="radio"]').filter((r) => r.checked).map((r) => r.value)).toEqual([
      'dot',
      'landscape',
    ])
  })

  test('title input stops at 100 code points', async () => {
    await mountLibrary()
    click(q('.cover-card')!)
    typeInto(titleInput(), '😀'.repeat(120))
    expect([...titleInput().value]).toHaveLength(100)
  })

  test('two quick activations of [create] save one note', async () => {
    await mountLibrary()
    await openSheetViaFab()
    typeInto(titleInput(), 'x')
    const create = buttonByText('만들기')
    act(() => {
      create.click()
      create.click()
      key(titleInput(), 'Enter')
    })
    await flush()
    expect(await allNotes()).toHaveLength(1)
  })
})

describe('save failure', () => {
  test('sheet stays with an inline message; list and defaults unchanged; retry works', async () => {
    let fail = true
    const storage = memStorage()
    await mountLibrary({
      storage,
      afterPut: () => {
        if (fail) throw new Error('quota')
      },
    })
    await openSheetViaFab()
    typeInto(titleInput(), 'a')
    click(q('input[value="lined"]')!)
    click(buttonByText('만들기'))
    await flush()

    expect(dialog()).not.toBeNull()
    expect(q('[aria-live="polite"]')!.textContent).toBe('이 브라우저에 저장하지 못했어요.')
    expect(await allNotes()).toHaveLength(0)
    expect(storage.m.has(NEW_NOTE_DEFAULTS_KEY)).toBe(false)
    expect(location.hash).toBe('')
    expect(qa('.cover-card').filter((c) => c.tagName === 'A')).toHaveLength(0)

    fail = false
    click(buttonByText('만들기'))
    await flush()
    expect(await allNotes()).toHaveLength(1)
    expect(location.hash).toMatch(/^#\/notes\//)
  })

  test('English message', async () => {
    await mountLibrary({
      lang: 'en-US',
      afterPut: () => {
        throw new Error('quota')
      },
    })
    click(q('.cover-card')!)
    click(buttonByText('Create'))
    await flush()
    expect(q('[aria-live="polite"]')!.textContent).toBe('Could not save to this browser.')
  })

  test('the value created this session wins even when localStorage cannot be written', () => {
    const d = createNewNoteDefaults({
      getItem: () => JSON.stringify({ background: 'dot', orientation: 'portrait' }),
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(d.read()).toEqual({ background: 'dot', orientation: 'portrait' })
    d.write({ background: 'lined', orientation: 'landscape' })
    expect(d.read()).toEqual({ background: 'lined', orientation: 'landscape' })
    // unreadable storage and bad values fall back
    expect(createNewNoteDefaults({ getItem: () => { throw new Error('x') }, setItem: () => {} }).read()).toEqual({
      background: 'plain',
      orientation: 'portrait',
    })
    expect(createNewNoteDefaults({ getItem: () => '{"background":"x","orientation":5}', setItem: () => {} }).read()).toEqual({
      background: 'plain',
      orientation: 'portrait',
    })
  })

  test('while saving, Esc, [cancel] and outside press do not close; focus stays inside', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    await mountLibrary({ afterPut: () => gate })
    await openSheetViaFab()
    click(buttonByText('만들기'))
    await settle()
    const create = buttonByText('만들기')
    expect(create.getAttribute('aria-disabled')).toBe('true')
    key(document.activeElement!, 'Escape')
    click(buttonByText('취소'))
    act(() => void q('.dialog-scrim')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(dialog()).not.toBeNull()
    expect(dialog()!.contains(document.activeElement)).toBe(true)
    release()
    await flush()
    expect(dialog()).toBeNull()
    expect(await allNotes()).toHaveLength(1)
  })
})

describe('sheet keyboard', () => {
  test('Tab wraps inside the sheet; Esc closes and returns focus to the opener; radios are native groups', async () => {
    await mountLibrary()
    const card = q<HTMLButtonElement>('.cover-card')!
    card.focus()
    click(card)
    const create = buttonByText('만들기')
    create.focus()
    key(create, 'Tab')
    expect(document.activeElement).toBe(titleInput())
    key(titleInput(), 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(create)

    const groups = new Set(qa<HTMLInputElement>('input[type="radio"]').map((r) => r.name))
    expect(groups.size).toBe(2)
    expect(qa('fieldset')).toHaveLength(2)

    key(document.activeElement!, 'Escape')
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(card)
  })

  test('Esc after opening from the fab returns focus to +', async () => {
    await mountLibrary()
    await openSheetViaFab()
    key(document.activeElement!, 'Escape')
    expect(document.activeElement).toBe(fabButton())
  })
})

describe('list', () => {
  test('newest first; cards are one link named by title and described by the date; unreadable is not a link', async () => {
    await seed([
      mk('a', '오래된 노트', '2026-01-02T00:00:00.000Z'),
      mk('b', '최근 노트', '2026-10-05T00:00:00.000Z'),
      mk('c', '날짜 이상', 'not-a-date'),
    ])
    await putRaw('bad', new Uint8Array([1, 2, 3]))
    await mountLibrary({ lang: 'en-US' })

    const cards = qa('.cover-grid > li > *')
    expect(cards.map((c) => c.querySelector('.cover-title')!.textContent)).toEqual([
      '최근 노트',
      '오래된 노트',
      '날짜 이상',
      'Cannot open',
    ])
    const links = qa<HTMLAnchorElement>('a.cover-card')
    expect(links).toHaveLength(3)
    expect(links[0]!.getAttribute('href')).toBe('#/notes/b')
    expect(document.getElementById(links[0]!.getAttribute('aria-labelledby')!)!.textContent).toBe('최근 노트')
    expect(document.getElementById(links[0]!.getAttribute('aria-describedby')!)!.textContent).toBe(
      new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date('2026-10-05T00:00:00.000Z')),
    )
    expect(links[2]!.hasAttribute('aria-describedby')).toBe(false) // no valid date
    expect(links[2]!.querySelector('.cover-date')).toBeNull()
    expect(cards[3]!.tagName).not.toBe('A')
    expect(cards[3]!.querySelector('a, button')).toBeNull()
    // no new-note card once there are notes
    expect(qa('.cover-card').filter((c) => c.tagName === 'BUTTON')).toHaveLength(0)
  })

  test('load failure shows a card with [retry] that reads the list again', async () => {
    await seed([mk('a', '노트', '2026-01-02T00:00:00.000Z')])
    let failNext = true
    const openStore = () => {
      const s = openNoteStore()
      stores.push(s)
      return {
        ...s,
        listNotes: () => (failNext ? Promise.reject(new Error('boom')) : s.listNotes()),
      } as NoteStore
    }
    act(() =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: i18nFor('ko-KR') },
          createElement(Library, { openStore, defaults: createNewNoteDefaults(memStorage()) }),
        ),
      ),
    )
    await flush()
    expect(q('[role="alert"]')!.textContent).toContain('목록을 불러오지 못했어요')
    expect(qa('.cover-card')).toHaveLength(0)
    failNext = false
    click(buttonByText('다시 시도'))
    await flush()
    expect(q('[role="alert"]')).toBeNull()
    expect(qa('a.cover-card')).toHaveLength(1)
  })

  test('the connection is closed when the library goes away', async () => {
    await mountLibrary()
    act(() => root.render(createElement('div')))
    await flush()
    await expect(deleteNoteDatabase(undefined, 300)).resolves.toBeUndefined()
  })
})

describe('sorting and dates', () => {
  test('latest page date wins; ties by noteId descending; undated then unreadable last; bad values never throw', () => {
    const items = [
      { noteId: 'u', title: null, editedMs: null },
      { noteId: 'n', title: 'n', editedMs: null },
      { noteId: 'a', title: 'a', editedMs: 100 },
      { noteId: 'b', title: 'b', editedMs: 100 },
      { noteId: 'c', title: 'c', editedMs: 200 },
    ]
    expect(sortItems(items).map((i) => i.noteId)).toEqual(['c', 'b', 'a', 'n', 'u'])

    const note = mk('x', 'x', '2026-01-01T00:00:00.000Z', 3)
    note.pages[1]!.editedAt = '2026-05-01T00:00:00.000Z'
    note.pages[2]!.editedAt = 'garbage'
    expect(latestEditedMs(note)).toBe(Date.parse('2026-05-01T00:00:00.000Z'))
    note.pages[0]!.editedAt = {} as unknown as string
    note.pages[1]!.editedAt = null as unknown as string
    expect(latestEditedMs(note)).toBeNull()
    expect(toItem({ noteId: 'x', result: { result: 'ok', writable: true, note } }).editedMs).toBeNull()
    expect(toItem({ noteId: 'y', result: { result: 'unsupportedVersion', writable: false } }).title).toBeNull()
  })

  test('editedBy is "<browser>, <OS>", or "Browser" when unknown', () => {
    expect(
      detectEditedBy({
        userAgent: '',
        userAgentData: { brands: [{ brand: 'Not.A/Brand' }, { brand: 'Chromium' }, { brand: 'Google Chrome' }], platform: 'Windows' },
      }),
    ).toBe('Google Chrome, Windows')
    expect(detectEditedBy({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Firefox/130.0' })).toBe('Firefox, macOS')
    expect(detectEditedBy({ userAgent: '' })).toBe('Browser')
    expect(detectEditedBy(undefined)).toBe('Browser')
  })
})

describe('editor entry point', () => {
  test('route parsing', () => {
    expect(parseNoteRoute('#/notes/abc')).toBe('abc')
    expect(parseNoteRoute('#/notes/a%2Fb')).toBe('a/b')
    expect(parseNoteRoute('#/notes/')).toBeNull()
    expect(parseNoteRoute('#/notes/%E0')).toBeNull()
    expect(parseNoteRoute('')).toBeNull()
  })

  test('app: create opens the stub with the title; back returns to the library with the note listed', async () => {
    act(() => root.render(createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(App, { auth: signedIn }))))
    await flush()
    click(q('.cover-card')!)
    typeInto(titleInput(), '내 노트')
    click(buttonByText('만들기'))
    await flush()
    await flush()
    expect(location.hash).toMatch(/^#\/notes\//)
    expect(q('.library')).toBeNull()
    expect(q('.editor-title')!.textContent).toBe('내 노트')
    expect(document.activeElement).toBe(q('.editor-back'))

    click(q('.editor-back')!)
    await flush()
    await flush()
    expect(q('.editor')).toBeNull()
    expect(qa('a.cover-card').map((a) => a.textContent)).toEqual([expect.stringContaining('내 노트')])
  })

  test('a missing or unreadable note sends the user back to the library', async () => {
    await putRaw('bad', new Uint8Array([9]))
    location.hash = '#/notes/bad'
    act(() => root.render(createElement(I18nContext.Provider, { value: i18nFor('ko-KR') }, createElement(App, { auth: signedIn }))))
    await flush()
    await flush()
    expect(q('.editor-corner')).toBeNull()
    expect(q('.library')).not.toBeNull()

    location.hash = '#/notes/nope'
    await flush()
    await flush()
    expect(q('.library')).not.toBeNull()
  })

  test('stub component on its own shows nothing for a missing note', async () => {
    location.hash = '#/notes/zzz'
    act(() => root.render(createElement(NoteEditorStub, { noteId: 'zzz', openStore: makeOpen() })))
    await flush()
    expect(q('.editor-corner')).toBeNull()
  })
})

describe('review fixes', () => {
  const hanging = () => new Promise<never>(() => {})

  function mountWith(openStore: () => NoteStore) {
    act(() =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: i18nFor('ko-KR') },
          createElement(Library, { openStore, defaults: createNewNoteDefaults(memStorage()), editedBy: 'Chrome, Windows' }),
        ),
      ),
    )
  }
  const withList = (listNotes: () => ReturnType<NoteStore['listNotes']>, closed?: { n: number }) => () => {
    const s = openNoteStore()
    stores.push(s)
    return {
      ...s,
      listNotes,
      close: () => {
        if (closed) closed.n++
        s.close()
      },
    } as NoteStore
  }

  test('nothing creates while the list is loading or failed', async () => {
    mountWith(withList(hanging))
    await flush()
    expect(q('.fab-button')).toBeNull()
    expect(q('.cover-card')).toBeNull()
    expect(q('[role="status"]')!.textContent).toBe('불러오는 중')
    expect(q('section')!.getAttribute('aria-busy')).toBe('true')

    act(() => root.render(createElement('div')))
    mountWith(withList(() => Promise.reject(new Error('boom'))))
    await flush()
    expect(q('.fab-button')).toBeNull()
    expect(q('.cover-card')).toBeNull()
    expect(q('[role="alert"]')).not.toBeNull()
  })

  test('a stale load is dropped and keeps the created note; a failed reload shows the notice and keeps the list', async () => {
    const { useLibrary } = await import('../src/ui/library/useLibrary')
    let api!: ReturnType<typeof useLibrary>
    let release!: () => void
    let calls = 0
    const real = openNoteStore()
    stores.push(real)
    const openStore = () =>
      ({
        ...real,
        listNotes: async () => {
          calls++
          if (calls === 1) return real.listNotes()
          if (calls === 2) await new Promise<void>((r) => (release = r))
          else throw new Error('boom')
          return []
        },
      }) as NoteStore
    const defaults = createNewNoteDefaults(memStorage())
    const Harness = () => {
      api = useLibrary(openStore, defaults, 'Chrome, Windows')
      return null
    }
    act(() => root.render(createElement(Harness)))
    await flush()
    expect(api.status).toBe('ready')

    act(() => void api.reload()) // stale: still pending
    await act(async () => void (await api.create({ title: 'n', background: 'plain', orientation: 'portrait' })))
    release()
    await flush()
    expect(api.items.map((i) => i.title)).toEqual(['n'])
    expect(api.status).toBe('ready')

    await act(async () => void (await api.reload())) // fails
    expect(api.failed).toBe(true)
    expect(api.status).toBe('ready')
    expect(api.items).toHaveLength(1)
  })

  test('IME: Enter and Esc while composing do nothing; the title is cut at compositionend', async () => {
    await mountLibrary()
    click(q('.cover-card')!)
    typeInto(titleInput(), 'abc')
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      key(titleInput(), 'Enter', init)
      key(titleInput(), 'Escape', init)
    }
    await flush()
    expect(dialog()).not.toBeNull()
    expect(await allNotes()).toHaveLength(0)

    act(() => void titleInput().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    typeInto(titleInput(), '가'.repeat(120))
    expect([...titleInput().value]).toHaveLength(120)
    act(() => void titleInput().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    expect([...titleInput().value]).toHaveLength(100)
  })

  test('Tab recaptures focus that fell outside the sheet; editing clears the failure message', async () => {
    await mountLibrary({
      afterPut: () => {
        throw new Error('quota')
      },
    })
    click(q('.cover-card')!)
    ;(document.activeElement as HTMLElement).blur()
    key(document.body, 'Tab')
    expect(document.activeElement).toBe(titleInput())

    click(buttonByText('만들기'))
    await flush()
    expect(q('[aria-live="polite"]')!.textContent).not.toBe('')
    typeInto(titleInput(), 'x')
    expect(q('[aria-live="polite"]')!.textContent).toBe('')
  })

  test('radios are disabled while saving', async () => {
    let release!: () => void
    await mountLibrary({ afterPut: () => new Promise<void>((r) => (release = r)) })
    click(q('.cover-card')!)
    click(buttonByText('만들기'))
    await settle()
    expect(qa<HTMLInputElement>('input[type="radio"]').every((r) => r.disabled)).toBe(true)
    release()
    await flush()
  })

  test('focus goes to the fab when the opener card is gone', async () => {
    await mountLibrary()
    const card = q('.cover-card')!
    click(card)
    card.remove()
    key(document.activeElement!, 'Escape')
    expect(document.activeElement).toBe(fabButton())
  })

  test('connections are closed when Library unmounts and after the stub loads', async () => {
    const closed = { n: 0 }
    mountWith(withList(() => Promise.resolve([]), closed))
    await flush()
    expect(closed.n).toBe(0)
    act(() => root.render(createElement('div')))
    expect(closed.n).toBe(1)

    const stubClosed = { n: 0 }
    const open = withList(() => Promise.resolve([]), stubClosed)
    act(() => root.render(createElement(NoteEditorStub, { noteId: 'nope', openStore: open })))
    await flush()
    expect(stubClosed.n).toBe(1)
  })
})
