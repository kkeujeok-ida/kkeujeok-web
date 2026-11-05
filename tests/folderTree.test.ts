// @vitest-environment jsdom
// Story 7.6: the folder tree is a real ARIA tree (roles, keyboard) and the two-step delete takes Esc back to its button.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import { FolderView, type FolderService } from '../src/library/folderService'
import { FolderTree, NOTE_DRAG } from '../src/ui/library/FolderTree'
import { parseFolderRoute, folderHref } from '../src/ui/library/useFolders'

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

const view = new FolderView(
  [
    { id: 'a', name: 'A', parentId: 'root' },
    { id: 'b', name: 'B', parentId: 'a' },
    { id: 'c', name: 'C', parentId: 'root' },
  ],
  { n1: 'b', n2: 'a' },
)

function mount(openHome = true) {
  const deleteFolder = vi.fn(async () => ({}))
  const onSelect = vi.fn()
  const service = { deleteFolder } as unknown as FolderService
  const i18n = createI18n({ navigatorLanguage: 'ko-KR' })
  act(() => root.render(createElement(I18nContext.Provider, { value: i18n }, createElement(FolderTree, { view, service, current: 'all', onSelect }))))
  if (openHome) act(() => void host.querySelector<HTMLElement>('[data-id="root"] .tree-toggle')!.click()) // Home starts closed
  return { deleteFolder, onSelect }
}
const items = () => [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')]
const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))

describe('folder tree', () => {
  test('Home starts closed: only the two top rows show, its toggle opens the folders', () => {
    mount(false)
    expect(items().map((i) => i.querySelector('.tree-label')!.textContent)).toEqual(['모든 노트', '홈'])
    expect(items()[1]!.getAttribute('aria-expanded')).toBe('false')
    act(() => void host.querySelector<HTMLElement>('[data-id="root"] .tree-toggle')!.click())
    expect(items().map((i) => i.querySelector('.tree-label')!.textContent)).toEqual(['모든 노트', '홈', 'A', 'C'])
  })

  test('is a tree of treeitems with levels, one tab stop and collapsed parents', () => {
    mount()
    expect(host.querySelector('[role="tree"]')).not.toBeNull()
    expect(items().map((i) => i.querySelector('.tree-label')!.textContent)).toEqual(['모든 노트', '홈', 'A', 'C']) // folders start closed: B is below A
    expect(items().map((i) => i.getAttribute('aria-level'))).toEqual(['1', '1', '2', '2'])
    expect(host.querySelector('.tree-menu-button')).toBeNull() // no ⋯ button (Story 18.5)
    expect(items().filter((i) => i.tabIndex === 0)).toHaveLength(1)
    expect(items()[2]!.getAttribute('aria-expanded')).toBe('false')
    expect(items()[3]!.hasAttribute('aria-expanded')).toBe(false)
  })

  test('arrows move, open and close; Enter selects; F2 and Delete do nothing', () => {
    const { onSelect, deleteFolder } = mount()
    key(items()[0]!, 'ArrowDown')
    key(items()[1]!, 'ArrowDown')
    expect(document.activeElement).toBe(items()[2])
    key(items()[2]!, 'ArrowRight') // opens A
    expect(items()[2]!.getAttribute('aria-expanded')).toBe('true')
    expect(items().map((i) => i.dataset.id)).toEqual(['all', 'root', 'a', 'b', 'c'])
    key(items()[2]!, 'ArrowRight') // into A
    expect(document.activeElement).toBe(items()[3])
    key(items()[3]!, 'ArrowLeft') // back to the parent
    expect(document.activeElement).toBe(items()[2])
    key(items()[2]!, 'ArrowLeft') // closes A
    expect(items()).toHaveLength(4)
    key(items()[2]!, 'End')
    expect(document.activeElement).toBe(items()[3])
    key(items()[3]!, 'Enter')
    expect(onSelect).toHaveBeenCalledWith('c')
    key(items()[3]!, 'F2')
    key(items()[3]!, 'Delete')
    expect(host.querySelector('[role="menu"], [role="dialog"]')).toBeNull()
    expect(deleteFolder).not.toHaveBeenCalled()
    key(items()[3]!, 'Home')
    key(items()[0]!, 'Enter')
    expect(onSelect).toHaveBeenLastCalledWith('all')
    key(items()[0]!, 'ArrowDown')
    key(items()[1]!, 'Enter')
    expect(onSelect).toHaveBeenLastCalledWith('root')
  })

  test('right-click or Shift+F10 opens [이름 변경][이동][삭제]; delete asks in a centered dialog with the note count; confirming deletes', () => {
    const { deleteFolder } = mount()
    act(() => void items()[2]!.querySelector('.tree-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    const menu = host.querySelector('[role="menu"]')!
    expect([...menu.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['이름 변경', '이동', '삭제'])
    key(menu.querySelector('button')!, 'Escape')
    expect(host.querySelector('[role="menu"]')).toBeNull()
    act(() => void items()[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })))
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((b) => b.textContent === '삭제')!.click())
    const dialog = host.querySelector('.dialog-scrim [role="dialog"]')!
    expect(dialog.textContent).toContain('2') // n2 is in A, n1 in B below it
    key(dialog.querySelector('button')!, 'Escape')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    act(() => void items()[2]!.querySelector('.tree-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((b) => b.textContent === '삭제')!.click())
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === '지우기')!.click())
    expect(deleteFolder).toHaveBeenCalledWith('a')
  })

  test('the address of a folder', () => {
    expect(parseFolderRoute(folderHref('x y'))).toBe('x y')
    expect(parseFolderRoute('#/')).toBeNull()
    expect(parseFolderRoute('#/notes/abc')).toBeNull()
  })

  test('a note card dropped on a folder moves the note there, with an undo snackbar (Story 7.8)', async () => {
    const moveNote = vi.fn(async () => ({ inverse: { op: 'moveNote', noteId: 'n1', targetParentId: 'root' } }))
    const i18n = createI18n({ navigatorLanguage: 'ko-KR' })
    const service = { moveNote } as unknown as FolderService
    act(() => root.render(createElement(I18nContext.Provider, { value: i18n }, createElement(FolderTree, { view, service, current: 'all', onSelect: vi.fn() }))))
    act(() => void host.querySelector<HTMLElement>('[data-id="root"] .tree-toggle')!.click())
    const row = host.querySelectorAll<HTMLElement>('.tree-row')[3]! // C
    const data = { types: [NOTE_DRAG], getData: () => JSON.stringify({ noteId: 'n1', title: '내 노트' }) }
    const ev = (type: string) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer: data })
    const over = ev('dragover')
    act(() => void row.dispatchEvent(over))
    expect(over.defaultPrevented).toBe(true)
    await act(async () => void row.dispatchEvent(ev('drop')))
    expect(moveNote).toHaveBeenCalledWith('n1', 'c')
    expect(host.querySelector('.snackbar')!.textContent).toContain('"C" 폴더로 옮겼어요')
  })
})
