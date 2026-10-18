// Checks the design tokens: DESIGN.md contrast table, Light/Dark parity, and
// that the committed build files are what the source generates.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { generate, loadTokens } from '../design_tokens/config.mjs'

const buildFile = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../design_tokens/build/${name}`, import.meta.url)), 'utf8')

// WCAG 2.x relative luminance and contrast ratio. Alpha is ignored; none of the
// checked pairs uses a translucent colour.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

const SURFACES = ['surface-base', 'surface-raised', 'surface-sunken'] as const
const TEXT = 4.5
const NON_TEXT = 3

// Every pair in the DESIGN.md contrast table, plus the ink and snackbar text pairs it implies.
// fg/bg are token paths; a bg of '*surface' expands to the three surfaces.
const pairs: { name: string; fg: string; bg: string; min: number }[] = [
  { name: 'on-accent / accent', fg: 'color.on-accent', bg: 'color.accent', min: TEXT },
  { name: 'accent-text / surface', fg: 'color.accent-text', bg: '*surface', min: TEXT },
  { name: 'accent-text / accent-soft', fg: 'color.accent-text', bg: 'color.accent-soft', min: TEXT },
  { name: 'on-warning / status-warning', fg: 'color.on-warning', bg: 'color.status-warning', min: TEXT },
  { name: 'status-warning-text / surface', fg: 'color.status-warning-text', bg: '*surface', min: TEXT },
  { name: 'on-error / status-error', fg: 'color.on-error', bg: 'color.status-error', min: TEXT },
  { name: 'status-error / surface', fg: 'color.status-error', bg: '*surface', min: TEXT },
  { name: 'ink-primary / surface', fg: 'color.ink-primary', bg: '*surface', min: TEXT },
  { name: 'ink-secondary / surface', fg: 'color.ink-secondary', bg: '*surface', min: TEXT },
  { name: 'border-control / surface', fg: 'color.border-control', bg: '*surface', min: NON_TEXT },
  { name: 'accent ring / surface', fg: 'color.accent-text', bg: '*surface', min: NON_TEXT },
  { name: 'status-warning icon / surface', fg: 'color.status-warning', bg: '*surface', min: NON_TEXT },
  { name: 'snackbar text / background', fg: 'components.snackbar.text', bg: 'components.snackbar.background', min: TEXT },
  { name: 'snackbar action / background', fg: 'components.snackbar.action', bg: 'components.snackbar.background', min: TEXT },
]

const tokens = { light: await loadTokens('light'), dark: await loadTokens('dark') }
const colorOf = (theme: 'light' | 'dark', path: string): string => {
  const t = tokens[theme][path]
  if (!t) throw new Error(`Token missing in ${theme}: ${path}`)
  return String(t.value)
}

describe.each(['light', 'dark'] as const)('contrast (%s)', (theme) => {
  test('every pair meets its minimum', () => {
    const failures: string[] = []
    for (const p of pairs) {
      const bgs = p.bg === '*surface' ? SURFACES.map((s) => `color.${s}`) : [p.bg]
      for (const bg of bgs) {
        const ratio = contrast(colorOf(theme, p.fg), colorOf(theme, bg))
        if (ratio < p.min) {
          failures.push(`${p.name} on ${bg} (${theme}): ${ratio.toFixed(2)}:1, needs ${p.min}:1`)
        }
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })
})

describe('token parity', () => {
  test('Light and Dark define the same token names', () => {
    const light = Object.keys(tokens.light)
    const dark = new Set(Object.keys(tokens.dark))
    const missingInDark = light.filter((n) => !dark.has(n))
    const missingInLight = [...dark].filter((n) => !(n in tokens.light))
    expect([...missingInDark.map((n) => `${n} (missing in Dark)`), ...missingInLight.map((n) => `${n} (missing in Light)`)]).toEqual([])
  })

  test('colors: 19 per theme, none from the pen palette or page', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(Object.keys(tokens[theme]).filter((n) => n.startsWith('color.'))).toHaveLength(19)
    }
  })
})

describe('generated files', () => {
  test('committed build/ matches the source, and generation is deterministic', async () => {
    const first = await generate()
    const second = await generate()
    expect(second).toEqual(first)
    expect(buildFile('tokens.css')).toBe(first.css)
    expect(buildFile('tokens.dart')).toBe(first.dart)
  })

  test('every var(--x) the web styles use is defined in tokens.css', () => {
    const css = buildFile('tokens.css')
    const styles = readFileSync(fileURLToPath(new URL('../src/ui/app.css', import.meta.url)), 'utf8')
    const used = [...styles.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!)
    expect(used.length).toBeGreaterThan(0)
    expect(used.filter((name) => !css.includes(`${name}:`))).toEqual([])
  })

  test('tokens.css has Light on :root and Dark on [data-theme="dark"]', () => {
    const css = buildFile('tokens.css')
    expect(css).toMatch(/:root \{[^}]*--color-surface-base: #F7F6F3;/)
    expect(css).toMatch(/\[data-theme="dark"\] \{[^}]*--color-surface-base: #1B1C1F;/)
  })
})
