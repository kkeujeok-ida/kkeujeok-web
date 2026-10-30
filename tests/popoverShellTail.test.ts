// @vitest-environment jsdom
// The tail points at the tool button inside the toolbar, not at the toolbar (Story 17.3).
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { PopoverShell } from '../src/ui/library/PopoverShell'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rect = (left: number, top: number, w: number, h: number) =>
  ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect

// A toolbar at `bar` with one slot at `slot` (a scrolled slot area just means a slot far from the bar's centre).
function tailOf(bar: DOMRect, slot: DOMRect) {
  const toolbar = document.createElement('div')
  toolbar.setAttribute('role', 'toolbar')
  toolbar.innerHTML = '<button data-slot="3"></button>'
  toolbar.getBoundingClientRect = () => bar
  toolbar.querySelector('button')!.getBoundingClientRect = () => slot
  document.body.append(toolbar)
  const host = document.createElement('div')
  document.body.append(host)
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 100 })
  window.innerWidth = 1000
  window.innerHeight = 800
  act(() => createRoot(host).render(createElement(PopoverShell, { anchor: toolbar, tool: '[data-slot="3"]', onClose: () => {}, labelledBy: 'x', className: 'pen-popover' }, null)))
  const bubble = host.querySelector<HTMLElement>('.pen-popover')!
  const tail = host.querySelector<HTMLElement>('.pen-popover-tail')!
  return { bubble, tail }
}

test('horizontal bar: tail centre is the slot centre, not the bar centre', () => {
  const { tail } = tailOf(rect(100, 12, 800, 48), rect(700, 12, 36, 36)) // bar centre 500, slot centre 718
  expect(tail.dataset.side).toBe('down')
  expect(parseFloat(tail.style.left) + 8).toBe(718)
})

test('vertical bar: tail centre is the slot centre along the bar', () => {
  const { tail } = tailOf(rect(12, 100, 48, 600), rect(12, 560, 36, 36)) // bar centre 400, slot centre 578
  expect(tail.dataset.side).toBe('right')
  expect(parseFloat(tail.style.top) + 8).toBe(578)
})
