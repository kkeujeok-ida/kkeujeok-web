// spec rules invert.* (spec/invert.md): how All Dark shows a page. Display only: never saved, exported or printed.
import { isPdfBackground } from './pdfRules'

type Rgb = [number, number, number]
export const PAPER: Rgb = [27, 28, 31] // #1b1c1f
const LINE = '#c5ced8'
const DOT = '#a0aab5'

const hex = (s: string): Rgb => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) as Rgb
const lin = (v: number) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const gam = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)

function toOklch([R, G, B]: Rgb) {
  const r = lin(R), g = lin(G), b = lin(B)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  return { L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, C: Math.hypot(a, bb), h: Math.atan2(bb, a) }
}

function linear(L: number, C: number, h: number): Rgb {
  const a = C * Math.cos(h), b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ]
}

const EPS = 1e-6
const inGamut = (L: number, C: number, h: number) => linear(L, C, h).every((v) => v >= -EPS && v <= 1 + EPS)

function toRgb(L: number, C: number, h: number): Rgb {
  if (!inGamut(L, C, h)) {
    let lo = 0, hi = C
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(L, mid, h)) lo = mid
      else hi = mid
    }
    C = lo
  }
  return linear(L, C, h).map((v) => Math.round(gam(Math.min(1, Math.max(0, v))) * 255)) as Rgb
}

const luminance = ([R, G, B]: Rgb) => 0.2126 * lin(R) + 0.7152 * lin(G) + 0.0722 * lin(B)
const contrast = (x: Rgb, y: Rgb) => {
  const a = luminance(x), b = luminance(y)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const colorRgb = (c: string): Rgb => {
  const { L, C, h } = toOklch(hex(c))
  return toRgb(1 - L, C, h)
}

export const invertColor = ({ color }: { color: string }) => ({ rgb: colorRgb(color) })

export function invertInk({ color }: { color: string }): { rgb: Rgb; corrected: boolean } {
  const { L, C, h } = toOklch(hex(color))
  const inv = toRgb(1 - L, C, h)
  if (contrast(inv, PAPER) >= 3) return { rgb: inv, corrected: false }
  let lo = 1 - L, hi = 1
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (contrast(toRgb(mid, C, h), PAPER) >= 4.5) hi = mid
    else lo = mid
  }
  return { rgb: toRgb(hi, C, h), corrected: true }
}

export const invertPaper = () => ({ rgb: [...PAPER] as Rgb })

export function invertHighlighter({ colors }: { colors: string[] }) {
  let px: number[] = [...PAPER]
  for (const c of colors) {
    const s = hex(c)
    px = px.map((v, i) => v * 0.6 + s[i]! * 0.4)
  }
  return { rgb: px.map((v) => Math.floor(v + 0.5)) as Rgb }
}

export function invertBackground({ background }: { background: unknown }) {
  const out: { paper: Rgb; line?: Rgb; dot?: Rgb } = { paper: [...PAPER] }
  if (background === 'lined' || background === 'grid') out.line = colorRgb(LINE)
  else if (background === 'dot') out.dot = colorRgb(DOT)
  return out
}

type LayersIn = { page?: { background?: unknown }; element?: { type?: unknown; tool?: unknown }; layer?: 'paper' | 'pattern' | 'pdf' | 'cover' }
type LayersOut = { invert: boolean; how: 'ink' | 'highlighter' | 'paper' | 'pattern' | 'none'; underlay?: '#ffffff' }

export function invertLayers({ page, element, layer }: LayersIn): LayersOut {
  const none: LayersOut = { invert: false, how: 'none' }
  if (layer === 'cover' || layer === 'pdf') return none
  const pdf = isPdfBackground(page?.background)
  if (layer === 'paper' || layer === 'pattern') return pdf ? none : { invert: true, how: layer }
  if (!element || pdf) return none
  if (element.type === 'stroke' && element.tool === 'tape') return none // a cover color, drawn as stored
  if (element.type === 'stroke') return { invert: true, how: element.tool === 'highlighter' ? 'highlighter' : 'ink' }
  if (element.type === 'text') return { invert: true, how: 'ink' }
  if (element.type === 'image') return { ...none, underlay: '#ffffff' }
  return none
}

const toHex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
const inkMemo = new Map<string, string>()
/** Ink color (pen stroke, text letters) as All Dark draws it, "#rrggbb". */
export function inkHex(color: string): string {
  let r = inkMemo.get(color)
  if (!r) {
    if (inkMemo.size > 512) inkMemo.clear()
    inkMemo.set(color, (r = toHex(invertInk({ color }).rgb)))
  }
  return r
}
export const lineHex = () => toHex(colorRgb(LINE))
export const dotHex = () => toHex(colorRgb(DOT))
export const paperHex = () => toHex(PAPER)
