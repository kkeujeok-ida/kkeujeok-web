// @vitest-environment jsdom
// Story 14.3: the trash screen: empty text, Delete asks a two-step purge confirm, [복구] restores.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import type { TrashEntry, TrashService } from '../src/library/trashService'
import { Trash } from '../src/ui/Trash'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const entry: TrashEntry = { isFolder: false, id: 'n1', fileId: 'f1', title: '수학', trashedAt: '2026-11-02T00:00:00.000Z', trashedFrom: null, noteCount: 0 }
async function mount(list: TrashEntry[]) {
  const service = { list: vi.fn(async () => list), purge: vi.fn(async () => 'done'), restore: vi.fn(async () => 'done'), empty: vi.fn(), open: vi.fn() } as unknown as TrashService
  const i18n = createI18n({ navigatorLanguage: 'ko-KR', storage: { getItem: () => null, setItem: () => {} }, applyLang: () => {} })
  await act(async () => root.render(createElement(I18nContext.Provider, { value: i18n }, createElement(Trash, { service }))))
  return service
}
const btn = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!

test('an empty trash says so', async () => {
  await mount([])
  expect(host.textContent).toContain('휴지통이 비어 있어요.')
})

test('Delete on a row asks to confirm; only the second press purges', async () => {
  const service = await mount([entry])
  const li = host.querySelector('li')!
  await act(async () => void li.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })))
  expect(service.purge).not.toHaveBeenCalled()
  await act(async () => btn('한 번 더 누르면 영구 삭제돼요').click())
  expect(service.purge).toHaveBeenCalledWith(entry)
})

test('[복구] restores the item', async () => {
  const service = await mount([entry])
  await act(async () => btn('복구').click())
  expect(service.restore).toHaveBeenCalledWith(entry)
})
