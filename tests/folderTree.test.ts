// @vitest-environment jsdom
// Story 7.6: the folder tree is a real ARIA tree (roles, keyboard) and the two-step delete takes Esc back to its button.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import { FolderView, type FolderService } from '../src/library/folderService'
import { FolderTree } from '../src/ui/library/FolderTree'
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

function mount() {
  const deleteFolder = vi.fn(async () => ({}))
  const onSelect = vi.fn()
  const service = { deleteFolder } as unknown as FolderService
  const i18n = createI18n({ navigatorLanguage: 'ko-KR' })
  act(() => root.render(createElement(I18nContext.Provider, { value: i18n }, createElement(FolderTree, { view, service, current: null, onSelect }))))
  return { deleteFolder, onSelect }
}
const items = () => [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')]
const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))

describe('folder tree', () => {
  test('is a tree of treeitems with levels, one tab stop and collapsed parents', () => {
    mount()
    expect(host.querySelector('[role="tree"]')).not.toBeNull()
    expect(items().map((i) => i.querySelector('.tree-label')!.textContent)).toEqual(['모든 노트', 'A', 'C']) // B is below the closed A
    expect(items().map((i) => i.getAttribute('aria-level'))).toEqual(['1', '2', '2'])
    expect(items().filter((i) => i.tabIndex === 0)).toHaveLength(1)
    expect(items()[1]!.getAttribute('aria-expanded')).toBe('false')
    expect(items()[2]!.hasAttribute('aria-expanded')).toBe(false)
  })

  test('arrows move, open and close; Enter selects', () => {
    const { onSelect } = mount()
    key(items()[0]!, 'ArrowDown')
    expect(document.activeElement).toBe(items()[1])
    key(items()[1]!, 'ArrowRight') // opens A
    expect(items()[1]!.getAttribute('aria-expanded')).toBe('true')
    expect(items().map((i) => i.dataset.id)).toEqual(['root', 'a', 'b', 'c'])
    key(items()[1]!, 'ArrowRight') // into A
    expect(document.activeElement).toBe(items()[2])
    key(items()[2]!, 'ArrowLeft') // back to the parent
    expect(document.activeElement).toBe(items()[1])
    key(items()[1]!, 'ArrowLeft') // closes A
    expect(items()).toHaveLength(3)
    key(items()[1]!, 'End')
    expect(document.activeElement).toBe(items()[2])
    key(items()[2]!, 'Enter')
    expect(onSelect).toHaveBeenCalledWith('c')
    key(items()[2]!, 'Home')
    key(items()[0]!, 'Enter')
    expect(onSelect).toHaveBeenLastCalledWith(null)
  })

  test('delete asks in place with the note count; Esc cancels and focus stays on [삭제]; confirming deletes', () => {
    const { deleteFolder } = mount()
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="A 메뉴"]')!.click())
    const menu = host.querySelector('[role="menu"]')!
    act(() => [...menu.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '삭제')!.click())
    expect(host.querySelector('.tree-confirm')!.textContent).toContain('2') // n2 is in A, n1 in B below it
    key(host.querySelector('[role="menu"] button')!, 'Escape')
    return new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        expect(document.activeElement?.textContent).toBe('삭제')
        expect(host.querySelector('.tree-confirm')).toBeNull()
        act(() => (document.activeElement as HTMLButtonElement).click())
        act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((b) => b.textContent === '지우기')!.click())
        expect(deleteFolder).toHaveBeenCalledWith('a')
        resolve()
      }),
    )
  })

  test('the address of a folder', () => {
    expect(parseFolderRoute(folderHref('x y'))).toBe('x y')
    expect(parseFolderRoute('#/')).toBeNull()
    expect(parseFolderRoute('#/notes/abc')).toBeNull()
  })
})
