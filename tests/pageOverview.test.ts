// @vitest-environment jsdom
// Story 6.3: the page overview panel beside the canvas (roles, current marker, click and keyboard navigation).
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { PageOverview } from '../src/ui/library/PageOverview'
import { mkNote } from './uploadHarness'
import { PA, PB } from './uploadHarness'
import { mountUi, type Mounted } from './syncUiHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
HTMLCanvasElement.prototype.getContext = (() => null) as never

let m: Mounted | undefined
afterEach(() => {
  m?.unmount()
  m = undefined
})

function mount(current: number, onGo: (i: number) => void, conflicted: string[] = [], extra: Record<string, unknown> = {}) {
  const pages = mkNote({ title: 'x', pages: { [PA]: 'a1', [PB]: 'b1' } }).pages
  m = mountUi(createElement(PageOverview, { id: 'p', pages, current, conflicted: new Set(conflicted), side: 'right', overlay: false, onGo, onClose: () => {}, ...extra }), 'ko')
  return m
}
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))

describe('page overview panel', () => {
  test('a listbox of options with the current one marked', () => {
    mount(1, () => {}, [PA])
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    const o = options()
    expect(o).toHaveLength(2)
    expect(o[1]!.getAttribute('aria-selected')).toBe('true')
    expect(o[0]!.getAttribute('aria-selected')).toBe('false')
    expect(o[1]!.getAttribute('aria-label')).toContain('현재')
    expect(o[0]!.getAttribute('aria-label')).toContain('충돌')
    expect(o[1]!.tabIndex).toBe(0)
  })

  test('a click goes to that page', () => {
    const went: number[] = []
    mount(0, (i) => went.push(i))
    act(() => options()[1]!.click())
    expect(went).toEqual([1])
  })

  test('arrow keys move focus, Enter goes', () => {
    const went: number[] = []
    mount(0, (i) => went.push(i))
    const o = options()
    o[0]!.focus()
    key(o[0]!, 'ArrowDown')
    expect(document.activeElement).toBe(o[1])
    key(o[1]!, 'Enter')
    expect(went).toEqual([1])
    key(o[1]!, 'ArrowUp')
    expect(document.activeElement).toBe(o[0])
  })

  test('[+], the menu and Delete call the page operations (Story 6.5)', () => {
    const calls: string[] = []
    mount(0, () => {}, [], { onAdd: () => calls.push('add'), onDuplicate: (id: string) => calls.push(`dup ${id}`), onDelete: (id: string) => calls.push(`del ${id}`) })
    act(() => document.querySelector<HTMLElement>('.po-header button[aria-label="페이지 추가"]')!.click())
    act(() => document.querySelectorAll<HTMLElement>('.po-more')[0]!.click())
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(document.activeElement?.textContent).toBe('복제')
    act(() => (document.activeElement as HTMLElement).click())
    expect(document.querySelector('[role="menu"]')).toBeNull()
    options()[1]!.focus()
    key(options()[1]!, 'Delete')
    expect(calls).toEqual(['add', `dup ${PA}`, `del ${PB}`])
  })

  test('Esc closes the menu and returns focus to the button; read-only disables the edits', () => {
    const calls: string[] = []
    mount(0, () => {}, [], { onAdd: () => calls.push('add'), onDelete: () => calls.push('del') })
    const more = document.querySelectorAll<HTMLElement>('.po-more')[0]!
    act(() => more.click())
    key(document.activeElement!, 'Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(more)
    m!.unmount()
    mount(0, () => {}, [], { readOnly: true, onAdd: () => calls.push('add'), onDelete: () => calls.push('del') })
    act(() => document.querySelector<HTMLElement>('.po-header button[aria-label="페이지 추가"]')!.click())
    act(() => document.querySelectorAll<HTMLElement>('.po-more')[0]!.click())
    key(options()[0]!, 'Delete')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(calls).toEqual([])
  })
})
