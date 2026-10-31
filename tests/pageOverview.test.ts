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

function mount(current: number, onGo: (i: number) => void, conflicted: string[] = []) {
  const pages = mkNote({ title: 'x', pages: { [PA]: 'a1', [PB]: 'b1' } }).pages
  m = mountUi(createElement(PageOverview, { id: 'p', pages, current, conflicted: new Set(conflicted), side: 'right', overlay: false, onGo, onClose: () => {} }), 'ko')
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
})
