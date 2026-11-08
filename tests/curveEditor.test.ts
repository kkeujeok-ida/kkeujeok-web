// @vitest-environment jsdom
// Story 25.4: the shared curve editor: keyboard points, fixed point count.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, test } from 'vitest'
import { I18nContext, createI18n } from '../src/i18n'
import { CurveEditor } from '../src/ui/CurveEditor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const i18n = () => createI18n({ navigatorLanguage: 'en-US', storage: { getItem: () => null, setItem: () => {} } })

function mount(value: number[], props: object = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const calls: number[][] = []
  act(() => root.render(createElement(I18nContext.Provider, { value: i18n() }, createElement(CurveEditor, { value, onChange: (v: number[]) => calls.push(v), ...props }))))
  return { host, calls }
}
const key = (el: Element, k: string, shiftKey = false) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true })))

describe('CurveEditor', () => {
  test('arrow keys move the focused point; Shift moves 5 times as far', () => {
    const { host, calls } = mount([0.2, 0.4, 0.5, 0.8])
    const dots = host.querySelectorAll('circle[role="slider"]')
    expect(dots.length).toBe(2)
    key(dots[0]!, 'ArrowUp')
    expect(calls.at(-1)![1]).toBeCloseTo(0.41)
    key(dots[0]!, 'ArrowRight', true)
    expect(calls.at(-1)![0]).toBeCloseTo(0.25)
  })
  test('a point stays between its neighbours', () => {
    const { host, calls } = mount([0.2, 0.4, 0.21, 0.8])
    key(host.querySelectorAll('circle')[0]!, 'ArrowRight', true)
    expect(calls.at(-1)![0]).toBeLessThan(0.21)
  })
  test('fixedCount: no add/remove buttons and Delete does nothing', () => {
    const { host, calls } = mount([0.2, 0.4, 0.5, 0.8], { fixedCount: 2 })
    expect(host.querySelectorAll('button').length).toBe(0)
    key(host.querySelectorAll('circle')[0]!, 'Delete')
    expect(calls.length).toBe(0)
  })
  test('default: add and remove exist, Delete removes the point', () => {
    const { host, calls } = mount([0.2, 0.4, 0.5, 0.8], { onReset: () => {} })
    expect(host.querySelectorAll('button').length).toBe(3)
    key(host.querySelectorAll('circle')[0]!, 'Delete')
    expect(calls.at(-1)).toEqual([0.5, 0.8])
  })
})
