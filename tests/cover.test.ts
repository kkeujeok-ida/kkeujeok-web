// @vitest-environment jsdom
// Story 7.4: setCover rule, the cover radios, and cards with a known / unknown coverId.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import { librarySetCover } from '../src/library/libraryRules'
import type { Note } from '../src/model/note'
import { createNote } from '../src/ops/ops'
import { createNewNoteDefaults } from '../src/storage/newNoteDefaults'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { openNoteStore } from '../src/storage/noteStore'
import { CoverRadios } from '../src/ui/library/CoverArt'
import { Library } from '../src/ui/library/Library'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mk = (noteId: string, coverId?: string): Note => {
  const r = createNote({ title: noteId, existingTitles: [], background: 'plain', orientation: 'portrait', noteId, pageId: `${noteId}-p`, pageRev: 'r', metaRev: 'm', orderRev: 'o', now: '2026-10-10T04:20:00.000Z', editedBy: 'x', ...(coverId && { coverId }) })
  if ('error' in r) throw new Error(r.error)
  return r.note
}
const ctx = { rev: 'new', lastSeenRemoteSeq: 0 }

describe('librarySetCover', () => {
  test('set, same value, remove, unknown id, invalid', () => {
    const n = mk('a')
    const set = librarySetCover({ note: n, op: { coverId: 'sage' }, ctx }) as { note: Note; inverse: unknown }
    expect(set.note.meta.coverId).toBe('sage')
    expect(set.note.metaRev).toBe('new')
    expect(set.note.metaSeq).toBe(2)
    expect(set.inverse).toEqual({ op: 'setCover', coverId: null })
    expect(librarySetCover({ note: set.note, op: { coverId: 'sage' }, ctx })).toEqual({ note: set.note, inverse: null })
    const off = librarySetCover({ note: set.note, op: { coverId: null }, ctx }) as { note: Note }
    expect('coverId' in off.note.meta).toBe(false)
    const future = mk('b', 'future')
    expect((librarySetCover({ note: future, op: { coverId: 'sage' }, ctx }) as { inverse: unknown }).inverse).toEqual({ op: 'setCover', coverId: 'future' })
    expect(librarySetCover({ note: n, op: { coverId: '' }, ctx })).toEqual({ error: 'invalidCoverId' })
    expect(librarySetCover({ note: n, op: { coverId: 'x'.repeat(117) }, ctx })).toEqual({ error: 'invalidCoverId' })
  })
})

let host: HTMLElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  await deleteNoteDatabase()
})
const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
const i18n = () => createI18n({ navigatorLanguage: 'en-US', storage: { getItem: () => null, setItem: () => {} } })

describe('cover UI', () => {
  test('radios: none + index covers, accessible name = cover name, checked state', () => {
    act(() => root.render(createElement(I18nContext.Provider, { value: i18n() }, createElement(CoverRadios, { name: 'c', value: 'sage', onChange: () => {} }))))
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    expect(radios.map((r) => r.closest('label')!.textContent)).toEqual(['No cover', 'Linen', 'Midnight', 'Sage'])
    expect(radios.map((r) => r.checked)).toEqual([false, false, false, true])
  })

  test('card: known id draws the cover picture, unknown id keeps the thumbnail and the note keeps its coverId', async () => {
    const s = openNoteStore()
    await s.writeNote(mk('known', 'sage'))
    await s.writeNote(mk('unknown', 'future'))
    s.close()
    const openStore = () => openNoteStore()
    act(() => root.render(createElement(I18nContext.Provider, { value: i18n() }, createElement(Library, { openStore, defaults: createNewNoteDefaults({ getItem: () => null, setItem: () => {} }), editedBy: 'x' }))))
    await settle()
    await settle()
    const card = (id: string) => [...host.querySelectorAll('.cover-item')].find((li) => li.querySelector('a')?.getAttribute('href')?.includes(id))!
    expect(card('known').querySelector('img.cover-art')).not.toBeNull()
    expect(card('unknown').querySelector('img.cover-art')).toBeNull()
    expect(card('unknown').querySelector('canvas')).not.toBeNull()
    const s2 = openNoteStore()
    expect(((await s2.loadNote('unknown')) as { note: Note }).note.meta.coverId).toBe('future')
    s2.close()
  })
})
