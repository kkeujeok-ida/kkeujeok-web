// @vitest-environment jsdom
// Story 8.3: the range choice of the export dialog (error in place, [내보내기] off), Esc, polite progress region.
import { act, createElement } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { resources } from '../src/i18n'
import { ExportDialog } from '../src/ui/library/ExportDialog'
import { type Mounted, mountUi } from './syncUiHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let m: Mounted | undefined
afterEach(() => (m?.unmount(), (m = undefined)))

const note = { meta: { title: 'n' }, pages: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, width: 595, height: 842, background: 'plain', elements: [] })) } as never
const start = () => m!.qa<HTMLButtonElement>('.dialog-actions button').find((b) => b.textContent === resources.ko['export.start'])!
function type(el: HTMLInputElement, v: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('custom range: error in place and the start button off until the input is valid; Esc closes', () => {
  const onClose = vi.fn()
  m = mountUi(createElement(ExportDialog, { note, current: 2, onClose }))
  expect(start().getAttribute('aria-disabled')).toBe('false')
  act(() => m!.qa<HTMLInputElement>('input[type="radio"]')[2]!.click())
  const input = m.q<HTMLInputElement>('input.field-input')!
  expect(start().getAttribute('aria-disabled')).toBe('true') // empty
  type(input, '4-2')
  expect(m.q('.dialog-error')!.textContent).toBe(resources.ko['export.err.reversedRange'])
  expect(start().getAttribute('aria-disabled')).toBe('true')
  type(input, '6')
  expect(m.q('.dialog-error')!.textContent).toBe(resources.ko['export.err.outOfRange'].replace('{total}', '5'))
  type(input, '2-3')
  expect(m.q('.dialog-error')!.textContent).toBe('')
  expect(start().getAttribute('aria-disabled')).toBe('false')
  expect(m.q('[aria-live="polite"][role="status"]')).not.toBeNull()
  act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(onClose).toHaveBeenCalledOnce()
})
