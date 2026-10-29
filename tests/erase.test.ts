// Eraser rules beyond the shared fixtures (story 5.7): piece counts, the preview, insertElements.removeIds, width rounding.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import type { Note } from '../src/model/note'
import { type Ctx, type Op, applyOp, erasePieces, erasedElements, eraseTargets } from '../src/ops/ops'

type Case = { name: string; input: { note: Note; op: Op; ctx: Ctx }; expected: { note?: Note; inverse?: Op | null; error?: string } }
const load = (rule: string) => (JSON.parse(readFileSync(fileURLToPath(new URL(`../../test/${rule}.json`, import.meta.url)), 'utf8')) as { cases: Case[] }).cases
const round1 = (w: number) => Math.round(w * 10) / 10
const pageOf = (c: Case) => c.input.note.pages.find((p) => p.id === c.input.op.pageId)!
const resultPage = (c: Case) => c.expected.note!.pages.find((p) => p.id === c.input.op.pageId)!

describe('erasePieces and erasedElements agree with erasePartial', () => {
  for (const c of load('ops.erasePartial').filter((x) => x.expected.note && x.expected.inverse)) {
    test(c.name, () => {
      const hits = erasePieces(pageOf(c), c.input.op.path as number[][], round1(c.input.op.width as number))
      // One id per piece, in the order the operation takes them from ctx.ids.
      expect(hits.reduce((n, h) => n + h.pieces.length, 0)).toBe((c.expected.inverse!.removeIds as string[]).length)
      let k = 0
      expect(erasedElements(pageOf(c), hits, true, () => c.input.ctx.ids![k++]!)).toEqual(resultPage(c).elements)
    })
  }
})

describe('erasedElements, stroke mode', () => {
  for (const c of load('ops.eraseStrokes').filter((x) => x.expected.note && x.expected.inverse)) {
    test(c.name, () => {
      const hits = erasePieces(pageOf(c), c.input.op.path as number[][], round1(c.input.op.width as number))
      expect(erasedElements(pageOf(c), hits, false, () => 'x')).toEqual(resultPage(c).elements)
    })
  }
})

describe('eraser width', () => {
  const base = load('ops.eraseStrokes')[0]!
  const run = (width: number) => applyOp(base.input.note, { ...base.input.op, width }, base.input.ctx)
  test('rounded once to 0.1, then 2..40 inclusive', () => {
    expect(run(1.96)).not.toHaveProperty('error') // 2.0
    expect(run(1.94)).toEqual({ error: 'invalidEraserWidth' }) // 1.9
    expect(run(40.04)).not.toHaveProperty('error') // 40.0
    expect(run(40.06)).toEqual({ error: 'invalidEraserWidth' }) // 40.1
    expect(run(NaN)).toEqual({ error: 'invalidEraserWidth' })
  })
  test('error order: page, then path, then width', () => {
    const { note, op, ctx } = base.input
    expect(applyOp(note, { ...op, pageId: 'nope', path: [], width: 1 }, ctx)).toEqual({ error: 'pageNotFound' })
    expect(applyOp(note, { ...op, path: [], width: 1 }, ctx)).toEqual({ error: 'emptyPath' })
    expect(applyOp(note, { ...op, width: 1 }, ctx)).toEqual({ error: 'invalidEraserWidth' })
  })
})

describe('insertElements.removeIds', () => {
  const c = load('ops.erasePartial').find((x) => x.expected.inverse)!
  const { op, ctx } = c.input
  const inv = c.expected.inverse as unknown as { removeIds: string[]; items: { index: number; element: { id: string } }[] }
  const done = applyOp(c.input.note, op, ctx)
  if ('error' in done) throw new Error(done.error)
  const base = { op: 'insertElements', pageId: op.pageId }

  test('removes first; the inverse removes the inserted ids and restores the pieces', () => {
    const r = applyOp(done.note, { ...base, removeIds: inv.removeIds, items: inv.items }, ctx)
    expect(r).toHaveProperty('note')
    const back = (r as { inverse: Op }).inverse as unknown as { removeIds: string[]; items: { element: { id: string } }[] }
    expect(back.removeIds).toEqual(inv.items.map((i) => i.element.id))
    expect(back.items.map((i) => i.element.id)).toEqual(inv.removeIds)
  })

  test('elementNotFound before duplicateId; duplicateId against what is left; then indexOutOfRange', () => {
    expect(applyOp(done.note, { ...base, removeIds: ['ghost'], items: inv.items }, ctx)).toEqual({ error: 'elementNotFound' })
    expect(applyOp(done.note, { ...base, removeIds: [], items: inv.items.concat(inv.items) }, ctx)).toEqual({ error: 'duplicateId' })
    expect(applyOp(done.note, { ...base, removeIds: [], items: [{ index: 0, element: { id: inv.removeIds[0]! } }] }, ctx)).toEqual({ error: 'duplicateId' })
    expect(applyOp(done.note, { ...base, removeIds: inv.removeIds, items: [{ ...inv.items[0]!, index: 999 }] }, ctx)).toEqual({ error: 'indexOutOfRange' })
  })

  test('without removeIds the inverse is still delete', () => {
    const el = { id: 'fresh', type: 'text', x: 0, y: 0, width: 20, rotation: 0, text: 'a' }
    const r = applyOp(done.note, { ...base, items: [{ index: 0, element: el }] }, ctx)
    expect((r as { inverse: Op }).inverse).toMatchObject({ op: 'delete', ids: ['fresh'] })
  })
})

describe('eraseTargets (story 15.7 translucent preview)', () => {
  const stroke = (id: string, y: number) => ({ id, type: 'stroke', tool: 'pen', color: '#000000', width: 2, usePressure: false, points: Array.from({ length: 11 }, (_, i) => [i * 10, y, 0.5, i * 10]) })
  const text = { id: 'tx', type: 'text', x: 20, y: 40, width: 60, rotation: 0, text: 'hi' }
  const page = { id: 'p', width: 200, height: 200, elements: [stroke('a', 40), text, stroke('b', 150)] } as unknown as Note['pages'][number]
  const path = [[50, 30], [50, 50]]

  test('stroke mode: the touched stroke is kept and faded; text and far strokes are not', () => {
    const t = eraseTargets(page, path, 12, false)
    expect([...t.fadeIds]).toEqual(['a'])
    expect(t.elements).toEqual(page.elements)
  })
  test('partial mode: the original is faded, its surviving pieces follow it opaque', () => {
    const t = eraseTargets(page, path, 12, true)
    expect([...t.fadeIds]).toEqual(['a'])
    expect(t.elements.map((e) => (e as { id: string }).id)).toEqual(['a', 'a~0', 'a~1', 'tx', 'b'])
  })
  test('no path / a path that touches nothing: nothing fades (rewinding or cancelling restores it)', () => {
    expect(eraseTargets(page, [[150, 100]], 12, true).fadeIds.size).toBe(0)
  })
})
