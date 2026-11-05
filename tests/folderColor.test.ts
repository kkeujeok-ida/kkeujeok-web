// @vitest-environment jsdom
import { beforeEach, expect, test } from 'vitest'
import { FOLDER_COLORS, getFolderColor, setFolderColor } from '../src/library/folderColor'
import { SNACKBAR_MS } from '../src/ui/snackbar'

beforeEach(() => localStorage.clear())

test('a folder color is kept per folder; null clears it; unknown values are ignored', () => {
  expect(getFolderColor('a')).toBeNull()
  setFolderColor('a', FOLDER_COLORS[2])
  expect(getFolderColor('a')).toBe('#FFD54F')
  expect(getFolderColor('b')).toBeNull()
  setFolderColor('a', null)
  expect(getFolderColor('a')).toBeNull()
  localStorage.setItem('kkeujeok.folderColors', '{"a":"red"}')
  expect(getFolderColor('a')).toBeNull()
})

test('every snackbar shares one duration', () => {
  expect(SNACKBAR_MS).toBe(4000)
})
