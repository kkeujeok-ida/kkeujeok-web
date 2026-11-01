// @vitest-environment jsdom
// Story 7.10: search scope, no-result state, address round trip, '/' and Esc.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import { FolderView } from '../src/library/folderService'
import type { Note } from '../src/model/note'
import { createNote } from '../src/ops/ops'
import { createNewNoteDefaults } from '../src/storage/newNoteDefaults'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { openNoteStore } from '../src/storage/noteStore'
import { Library } from '../src/ui/library/Library'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mk = (noteId: string, title: string): Note => {
  const r = createNote({ title, existingTitles: [], background: 'plain', orientation: 'portrait', noteId, pageId: `${noteId}-p`, pageRev: 'r', metaRev: 'm', orderRev: 'o', now: '2026-10-10T04:20:00.000Z', editedBy: 'x' })
  if ('error' in r) throw new Error(r.error)
  return r.note
}
let host: HTMLElement
let root: Root
beforeEach(async () => {
  history.replaceState(null, '', '/')
  localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const s = openNoteStore()
  for (const [id, title] of [['n1', 'abc'], ['n2', 'xyz'], ['n3', 'AB sub']] as const) await s.writeNote(mk(id, title))
  s.close()
})
afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  await deleteNoteDatabase()
})
const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
const i18n = () => createI18n({ navigatorLanguage: 'en-US', storage: { getItem: () => null, setItem: () => {} } })
async function show(props: Record<string, unknown> = {}) {
  act(() => root.render(createElement(I18nContext.Provider, { value: i18n() }, createElement(Library, { openStore: () => openNoteStore(), defaults: createNewNoteDefaults({ getItem: () => null, setItem: () => {} }), editedBy: 'x', ...props }))))
  await settle()
  await settle()
}
const titles = () => [...host.querySelectorAll('.cover-item .cover-title')].map((e) => e.textContent)
const input = () => host.querySelector<HTMLInputElement>('input[type="search"]')!
async function type(v: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    set.call(input(), v)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('library search', () => {
  test('filters by title, no-result state hides the new-note card, clearing restores, address follows', async () => {
    await show()
    expect(titles()).toHaveLength(3)
    await type('ab')
    expect(titles().sort()).toEqual(['AB sub', 'abc'])
    expect(location.search).toBe('?q=ab')
    expect(host.querySelector('.library > span.sr-only[aria-live="polite"]')!.textContent).toBe('2 notes')
    await type('nope')
    expect(host.textContent).toContain('No notes match ‘nope’')
    expect(host.querySelector('.cover-thumb-new')).toBeNull()
    await type('')
    expect(titles()).toHaveLength(3)
    expect(location.search).toBe('')
  })
  test('the address restores query and sort; unknown sort falls back; / focuses, Esc clears', async () => {
    history.replaceState(null, '', '/?q=ab&sort=nameAsc')
    await show()
    expect(input().value).toBe('ab')
    expect(titles()).toEqual(['AB sub', 'abc'])
    expect(host.querySelector<HTMLSelectElement>('select.library-sort')!.value).toBe('nameAsc')
    act(() => input().blur())
    act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })))
    expect(document.activeElement).toBe(input())
    act(() => void input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(input().value).toBe('')
    expect(location.search).toBe('?sort=nameAsc')
  })
  test('unknown sort in the address gives the default', async () => {
    history.replaceState(null, '', '/?sort=bogus')
    await show()
    expect(host.querySelector<HTMLSelectElement>('select.library-sort')!.value).toBe('editedDesc')
  })
  test('folder scope includes subfolders while searching', async () => {
    const view = new FolderView([{ id: 'A', name: 'A', parentId: 'root' }, { id: 'B', name: 'B', parentId: 'A' }], { n1: 'A', n2: 'A', n3: 'B' })
    await show({ folders: { view: async () => view, subscribe: () => () => {}, refresh: async () => {}, takeRevived: () => 0 }, folderView: view, folderId: 'A' })
    expect(titles().sort()).toEqual(['abc', 'xyz'])
    await type('ab')
    expect(titles().sort()).toEqual(['AB sub', 'abc'])
  })
})
