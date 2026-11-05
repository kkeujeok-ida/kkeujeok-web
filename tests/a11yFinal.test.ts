import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { NARROW_PX } from '../src/ui/library/useToolbarDock'

const css = readFileSync(new URL('../src/ui/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

describe('a11y final check (10.8)', () => {
  test('narrow width keeps the toolbar on top only', () => {
    expect(NARROW_PX).toBe(400)
    expect(readFileSync(new URL('../src/ui/library/useToolbarDock.ts', import.meta.url), 'utf8')).toMatch(/win\.w <= NARROW_PX \? \{ \.\.\.DEFAULT_POS \}/)
  })
  test('every transition/animation rule has a reduced-motion override', () => {
    const reduce = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1] ?? '').join('\n')
    const rules = [...css.matchAll(/(^|\n)([^{}@\n][^{}]*)\{([^{}]*(?:transition|animation):[^{}]*)\}/g)]
    for (const [, , sel = '', body = ''] of rules) {
      if (/transition: none|animation: none/.test(body)) continue
      const s = sel.trim().replace(/\s+/g, ' ')
      if (/search/.test(s)) continue // lives inside prefers-reduced-motion: no-preference
      expect(reduce, s).toContain(s.split(',')[0]!.trim())
    }
  })
})
