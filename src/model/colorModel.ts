/** The shared pen color model (spec/pen.md): HSV with h in 0..360, s and v in 0..1; colors are `#rrggbb` in lower case. */
export type Hsv = { h: number; s: number; v: number }

export const HEX6 = /^#[0-9a-f]{6}$/

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export function hsvToHex({ h, s, v }: Hsv): string {
  const hh = (((h % 360) + 360) % 360) / 60
  const ss = clamp01(s)
  const vv = clamp01(v)
  const f = (n: number) => {
    const k = (n + hh) % 6
    return vv - vv * ss * Math.max(0, Math.min(k, 4 - k, 1))
  }
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0')
  return `#${hex(f(5))}${hex(f(3))}${hex(f(1))}`
}

/** Null when `hex` is not `#rrggbb` (case ignored). Gray gives h 0, s 0. */
export function hexToHsv(hex: string): Hsv | null {
  const x = hex.toLowerCase()
  if (!HEX6.test(x)) return null
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: h * 60, s: max ? d / max : 0, v: max }
}
