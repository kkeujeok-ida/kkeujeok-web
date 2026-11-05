import { expect, test } from 'vitest'
import { resources } from '../src/i18n'

test('ko and en have the same keys and no empty text', () => {
  expect(Object.keys(resources.ko).sort()).toEqual(Object.keys(resources.en).sort())
  for (const l of ['ko', 'en'] as const) for (const [k, v] of Object.entries(resources[l])) expect(v.trim(), `${l}:${k}`).not.toBe('')
})

test('ko texts that equal en are only names, symbols or placeholders', () => {
  const same = Object.keys(resources.ko).filter((k) => resources.ko[k as keyof typeof resources.ko] === resources.en[k as keyof typeof resources.en])
  expect(same.sort()).toEqual(['app.name', 'conflict.editedAt', 'editor.colorHex', 'settings.language.en', 'settings.language.ko'].sort())
})
