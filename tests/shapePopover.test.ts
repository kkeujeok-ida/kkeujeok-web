// @vitest-environment jsdom
// The shape kind popover (Story 26.15): three icon radios, arrows move focus, Enter chooses, Esc closes.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { ShapePopover } from '../src/ui/library/ShapePopover'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('three named radios; arrow + Enter choose; Esc closes', () => {
  const onChange = vi.fn()
  const onClose = vi.fn()
  const host = document.body.appendChild(document.createElement('div'))
  act(() => createRoot(host).render(createElement(ShapePopover, { kind: 'rect', anchor: null, tool: 'x', onChange, onClose })))
  const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  expect(radios.map((r) => r.dataset.shapeKind)).toEqual(['triangle', 'rect', 'circle'])
  expect(radios.every((r) => r.getAttribute('aria-label'))).toBe(true)
  expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
  expect(document.activeElement).toBe(radios[1])
  const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
  key(radios[1]!, 'ArrowRight')
  expect(document.activeElement).toBe(radios[2])
  key(radios[2]!, 'Enter')
  expect(onChange).toHaveBeenCalledWith('circle')
  key(radios[2]!, 'Escape')
  expect(onClose).toHaveBeenCalled()
})
