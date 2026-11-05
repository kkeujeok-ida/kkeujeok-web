// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { I18nContext, createI18n, resources } from '../src/i18n'
import { SHORTCUT_GROUPS, POINTER_ROWS } from '../src/ui/helpData'
import { ShortcutSheet } from '../src/ui/ShortcutSheet'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('every help row has ko and en text; F2, Delete, /, Ctrl+P are listed', () => {
  const rows = [...SHORTCUT_GROUPS.flatMap((g) => g.rows), ...POINTER_ROWS]
  for (const r of rows) for (const l of ['ko', 'en'] as const) expect(resources[l][r.label], r.label).toBeTruthy()
  const keys = rows.map((r) => r.keys)
  for (const k of ['F2', 'Delete', '/', 'Ctrl+P', '?']) expect(keys).toContain(k)
})

test('sheet: Esc closes it and focus returns', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const i18n = createI18n({ storage: { getItem: () => 'en', setItem: () => {} }, navigatorLanguage: 'en' })
  const root = createRoot(host)
  let closed = false
  act(() => root.render(createElement(I18nContext.Provider, { value: i18n }, createElement(ShortcutSheet, { onClose: () => (closed = true) }))))
  expect(host.querySelector('[role="dialog"]')).toBeTruthy()
  act(() => host.querySelector('.dialog-scrim')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(closed).toBe(true)
  act(() => root.unmount())
  expect(document.activeElement).toBe(opener)
})
