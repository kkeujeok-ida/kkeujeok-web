// Story 15.8: the incremental eraser equals the full recompute; synthetic 5,000-stroke benchmark.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import type { Note, Page } from '../src/model/note'
import { EraseScan, eraseTargets, erasePieces } from '../src/ops/ops'

const load = (rule: string) => (JSON.parse(readFileSync(fileURLToPath(new URL(`../../test/${rule}.json`, import.meta.url)), 'utf8')) as { cases: { input: { note: Note; op: { pageId: string; path: number[][]; width: number } }; expected: { note?: Note } }[] }).cases
let seed = 7
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const scan = (page: Page, path: number[][], w: number, partial: boolean) => {
  const s = new EraseScan(page, w, partial)
  for (const p of path) s.push(p)
  return s.targets()
}
const same = (a: ReturnType<typeof eraseTargets>, b: ReturnType<typeof eraseTargets>) => {
  expect(a.elements).toEqual(b.elements)
  expect([...a.fadeIds].sort()).toEqual([...b.fadeIds].sort())
}
const stroke = (i: number, W: number, H: number) => {
  const x = rnd() * W, y = rnd() * H
  return { type: 'stroke', id: `s${i}`, points: Array.from({ length: 2 + Math.floor(rnd() * 12) }, (_, k) => [x + k * 3 + rnd() * 2, y + rnd() * 20]) }
}
const synth = (n: number): Page => ({ id: 'p', width: 2000, height: 3000, elements: Array.from({ length: n }, (_, i) => stroke(i, 2000, 3000)) }) as unknown as Page
const randPath = (len: number, W: number, H: number) => {
  let x = rnd() * W, y = rnd() * H
  return Array.from({ length: len }, () => [(x = Math.min(W, Math.max(0, x + (rnd() - 0.5) * 60))), (y = Math.min(H, Math.max(0, y + (rnd() - 0.5) * 60)))])
}

describe('incremental == full', () => {
  for (const partial of [false, true]) {
    test(`fixtures, ${partial ? 'partial' : 'stroke'} mode`, () => {
      for (const c of load(partial ? 'ops.erasePartial' : 'ops.eraseStrokes')) {
        const page = c.input.note.pages.find((p) => p.id === c.input.op.pageId)
        const w = Math.round(c.input.op.width * 10) / 10
        if (!page || !Array.isArray(c.input.op.path) || c.input.op.path.length === 0 || !(w >= 2 && w <= 40)) continue
        same(scan(page, c.input.op.path, w, partial), eraseTargets(page, c.input.op.path, w, partial))
      }
    })
    test(`random paths, ${partial ? 'partial' : 'stroke'} mode, checked at every prefix`, () => {
      const page = synth(300)
      for (let t = 0; t < 6; t++) {
        const path = randPath(40, 2000, 3000)
        // aim the path at strokes so it hits something
        const s0 = (page.elements[t] as unknown as { points: number[][] }).points[0]!
        path[0] = [s0[0]!, s0[1]!]
        const w = 2 + rnd() * 38
        const s = new EraseScan(page, w, partial)
        path.forEach((p, i) => {
          s.push(p)
          if (i % 7 === 0 || i === path.length - 1) same(s.targets(), eraseTargets(page, path.slice(0, i + 1), w, partial))
        })
        expect(erasePieces(page, path, w).length).toBeGreaterThan(0)
      }
    })
  }
})

describe('5,000-stroke benchmark', () => {
  test('per-move time', () => {
    const page = synth(5000)
    const path = randPath(300, 2000, 3000)
    for (const partial of [false, true]) {
      const s = new EraseScan(page, 20, partial)
      const times: number[] = []
      for (const p of path) {
        const t0 = performance.now()
        s.push(p)
        s.targets()
        times.push(performance.now() - t0)
      }
      const avg = times.reduce((a, b) => a + b, 0) / times.length
      const max = Math.max(...times)
      console.log(`bench ${partial ? 'partial' : 'stroke'}: moves=${times.length} avg=${avg.toFixed(3)}ms max=${max.toFixed(3)}ms`)
      expect(avg).toBeLessThan(16)
      expect(max).toBeLessThan(200)
    }
  })
})
