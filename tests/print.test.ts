// @vitest-environment jsdom
// Story 8.4: hidden-iframe print and its cleanup, the dialog's print mode (print on success, not on cancel).
import { act, createElement } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { resources } from '../src/i18n'
import { ExportDialog } from '../src/ui/library/ExportDialog'
import { printBlob } from '../src/export/printPdf'
import { type Mounted, mountUi } from './syncUiHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let m: Mounted | undefined
afterEach(() => (m?.unmount(), (m = undefined), vi.restoreAllMocks()))

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)))

test('printBlob prints only a hidden iframe, then removes it and revokes the URL after afterprint', async () => {
  const revoke = vi.fn()
  URL.createObjectURL = () => 'blob:x'
  URL.revokeObjectURL = revoke
  const print = vi.fn()
  const p = printBlob(new Blob(['%PDF']))
  const frame = document.querySelector('iframe')!
  expect(frame.getAttribute('aria-hidden')).toBe('true')
  const win = Object.assign(new EventTarget(), { focus() {}, print })
  Object.defineProperty(frame, 'contentWindow', { value: win })
  frame.dispatchEvent(new Event('load'))
  await p
  expect(print).toHaveBeenCalledOnce()
  expect(document.querySelector('iframe')).not.toBeNull()
  win.dispatchEvent(new Event('afterprint'))
  expect(document.querySelector('iframe')).toBeNull()
  expect(revoke).toHaveBeenCalledWith('blob:x')
})

test('printBlob rejects and cleans up when print throws', async () => {
  URL.createObjectURL = () => 'blob:y'
  URL.revokeObjectURL = vi.fn()
  const p = printBlob(new Blob(['%PDF']))
  const frame = document.querySelector('iframe')!
  Object.defineProperty(frame, 'contentWindow', { value: Object.assign(new EventTarget(), { focus() {}, print() { throw new Error('blocked') } }) })
  frame.dispatchEvent(new Event('load'))
  await expect(p).rejects.toThrow('blocked')
  expect(document.querySelector('iframe')).toBeNull()
})

const note = { meta: { title: 'n' }, pages: [{ id: 'p', width: 595, height: 842, background: 'plain', elements: [] }] } as never
const startBtn = () => m!.qa<HTMLButtonElement>('.dialog-actions button').find((b) => b.textContent === resources.ko['print.start'])!

test('print mode: print titles; success calls printBlob; cancel does not', async () => {
  const print = vi.fn(async () => {})
  vi.doMock('../src/export/printPdf', () => ({ printBlob: print }))
  let release!: () => void
  class Cancelled extends Error {}
  vi.doMock('../src/export/pdfExport', () => ({
    ExportCancelled: Cancelled,
    buildPdf: (o: { signal: AbortSignal }) =>
      new Promise((res, rej) => {
        release = () => res({ ok: true, fileName: 'n.pdf', blob: new Blob(['x']) })
        o.signal.addEventListener('abort', () => rej(new Cancelled()))
      }),
  }))
  vi.doMock('../src/export/browserAssets', () => ({ loadFonts: vi.fn(), webpToPng: vi.fn() }))
  const { ExportDialog: Dlg } = await import('../src/ui/library/ExportDialog')
  const onClose = vi.fn()
  m = mountUi(createElement(Dlg, { mode: 'print', note, current: 1, onClose }))
  expect(m.q('.dialog-title')!.textContent).toBe(resources.ko['print.title'])

  act(() => startBtn().click()) // cancel while making
  await flush()
  act(() => m!.qa<HTMLButtonElement>('.dialog-actions button')[0]!.click())
  await flush()
  expect(print).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalledOnce()

  m.unmount()
  m = mountUi(createElement(Dlg, { mode: 'print', note, current: 1, onClose }))
  act(() => startBtn().click())
  await flush()
  release()
  await flush()
  expect(print).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledTimes(2)
  vi.doUnmock('../src/export/printPdf')
  vi.doUnmock('../src/export/pdfExport')
  vi.doUnmock('../src/export/browserAssets')
  void ExportDialog
})
