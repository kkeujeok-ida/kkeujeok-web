import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = join(__dirname, '..', 'design_tokens', 'covers')
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))

describe('cover assets', () => {
  it('index has version 1 and the three covers in order', () => {
    expect(index.version).toBe(1)
    expect(index.covers.map((c: { id: string }) => c.id)).toEqual(['linen', 'midnight', 'sage'])
  })

  for (const c of index.covers) {
    it(`${c.id} entry is valid and its svg is renderer-safe`, () => {
      expect(c.id).toMatch(/^[a-z][a-z0-9-]{0,31}$/)
      expect(c.name.ko).toBeTruthy()
      expect(c.name.en).toBeTruthy()
      expect(c.file).toMatch(/^[a-z0-9][a-z0-9-]*\.svg$/)
      expect(existsSync(join(dir, c.file))).toBe(true)
      const svg = readFileSync(join(dir, c.file), 'utf8')
      expect(svg).toContain('viewBox="0 0 300 400"')
      for (const bad of ['pattern', 'url(#', '<style', '<script', '<defs', 'href'])
        expect(svg).not.toContain(bad)
    })
  }
})
