// Shape strokes (story 26.5): addStroke keeps `shape`, transforms regenerate points, partial erase pieces are plain strokes.
import { describe, expect, test } from 'vitest'
import { shapeFromDrag, shapePoints } from '../src/model/shape'
import { toWritableJson, type Note } from '../src/model/note'
import { applyOp, createNote, erasePieces, erasedElements, type Ctx } from '../src/ops/ops'

const ctx: Ctx = { rev: 'r2', now: '2026-01-01T00:00:00.000Z', editedBy: 'd', lastSeenRemoteSeq: 0 }
const made = createNote({ title: 't', existingTitles: [], background: 'blank', orientation: 'portrait', noteId: 'n', pageId: 'p', pageRev: 'r', metaRev: 'm', orderRev: 'o', now: ctx.now, editedBy: 'd' })
const base = 'note' in made ? made.note : (undefined as never)
const shape = shapeFromDrag('rect', [100, 100], [200, 160], false)!
const stroke = { id: 's1', type: 'stroke', tool: 'pen', color: '#000000', width: 2, usePressure: false, shape, points: shapePoints(shape)! }
const withShape = (): Note => {
  const r = applyOp(base, { op: 'addStroke', pageId: 'p', stroke }, ctx)
  if ('error' in r) throw new Error(r.error)
  return r.note
}
const only = (n: Note) => n.pages[0]!.elements[0] as Record<string, unknown>

describe('shape stroke', () => {
  test('shape survives addStroke and writing', () => {
    expect(only(withShape()).shape).toEqual(shape)
    expect(only(toWritableJson(withShape())).shape).toEqual(shape)
  })
  test('move regenerates points from the moved shape', () => {
    const r = applyOp(withShape(), { op: 'move', pageId: 'p', ids: ['s1'], dx: 10, dy: -5 }, ctx)
    if ('error' in r) throw new Error(r.error)
    const e = only(r.note)
    expect(e.shape).toMatchObject({ x: 110, y: 95, width: 100, height: 60 })
    expect(e.points).toEqual(shapePoints(e.shape))
  })
  test('rotate adds rotation and keeps points in sync', () => {
    const r = applyOp(withShape(), { op: 'rotate', pageId: 'p', ids: ['s1'], angle: 90 }, ctx)
    if ('error' in r) throw new Error(r.error)
    const e = only(r.note)
    expect((e.shape as { rotation: number }).rotation).toBe(90)
    expect(e.points).toEqual(shapePoints(e.shape))
  })
  test('partial erase pieces carry no shape', () => {
    const page = withShape().pages[0]!
    const hits = erasePieces(page, [[150, 90], [150, 170]], 4)
    const out = erasedElements(page, hits, true, (_o, j) => `p${j}`) as Record<string, unknown>[]
    expect(out.length).toBeGreaterThan(0)
    for (const e of out) expect('shape' in e).toBe(false)
  })
  test('drag under 4 pt gives no shape; Shift makes a square', () => {
    expect(shapeFromDrag('circle', [0, 0], [3, 3], false)).toBeNull()
    expect(shapeFromDrag('rect', [0, 0], [100, 30], true)).toMatchObject({ width: 100, height: 100 })
  })
})
