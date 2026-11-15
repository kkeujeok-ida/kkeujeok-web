import { expect, test } from 'vitest'
import { toItem } from '../src/ui/library/useLibrary'
import { canvasModeOf } from '../src/model/canvasRules'
import { validateNote } from '../src/model/note'
import { createCanvas, createNote } from '../src/ops/ops'

const ids = { noteId: 'n', pageId: 'p', pageRev: 'r', metaRev: 'm', orderRev: 'o', now: '2026-01-01T00:00:00.000Z', editedBy: 'x' }

test('a created canvas reads, is a canvas and gets the library badge; a plain note does not', () => {
  const r = createCanvas({ title: 'c', existingTitles: [], width: 100, height: 64, background: { type: 'color', value: '#ffffff' }, ...ids })
  if (!('note' in r)) throw new Error(r.error)
  const read = validateNote(JSON.parse(JSON.stringify(r.note)))
  expect(read.result).toBe('ok')
  expect(canvasModeOf(r.note.meta.kind, r.note.pages)).toBe('canvas')
  expect(toItem({ noteId: 'n', result: read } as never).canvas).toBe(true)
  const n = createNote({ title: 'n', existingTitles: [], background: 'plain', orientation: 'portrait', ...ids })
  if (!('note' in n)) throw new Error(n.error)
  expect(toItem({ noteId: 'n', result: { result: 'ok', writable: true, note: n.note } } as never).canvas).toBeUndefined()
})
