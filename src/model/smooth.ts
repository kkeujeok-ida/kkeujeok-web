// spec rule `stroke.smooth` (pen-feel.md): Catmull-Rom densify, then neighbour-average passes, at draw time only.
export const SMOOTH_MAX = 10

/** Azimuth `a` moved toward `b` by `w` along the shorter arc (degrees, 0..360). */
const arc = (a: number, b: number, w: number) => (((a + (((b - a + 540) % 360) - 180) * w) % 360) + 360) % 360
const tilted = (...ps: readonly (readonly number[])[]) => ps.every((p) => p.length === 6)

/** Points are `[x, y, pressure, t]` or `[.., tilt, azimuth]`. Ends stay; inserted points get the mean `t`; tilt is kept only where its neighbours have it too; the input is not changed. */
export function smoothPoints<P extends readonly number[]>(points: readonly P[], level: number): (P | number[])[] {
  const n = points.length
  // 2-point strokes (a straightened line) never bend.
  if (level <= 0 || n < 3) return points.slice()
  const at = (i: number, j: number) => points[Math.min(n - 1, Math.max(0, i))]![j]!
  let cur: number[][] = []
  for (let i = 0; i < n; i++) {
    cur.push(Array.from(points[i]!))
    if (i < n - 1) {
      const m = [0, 1, 2].map((j) => (-at(i - 1, j) + 9 * at(i, j) + 9 * at(i + 1, j) - at(i + 2, j)) / 16)
      const a = points[i]!
      const b = points[i + 1]!
      cur.push([...m, (at(i, 3) + at(i + 1, 3)) / 2, ...(tilted(a, b) ? [(a[4]! + b[4]!) / 2, arc(a[5]!, b[5]!, 0.5)] : [])])
    }
  }
  for (let pass = 0; pass < Math.ceil(level / 2); pass++) {
    const old = cur
    cur = old.map((p, i) => {
      if (i === 0 || i === old.length - 1) return p
      const [pr, nx] = [old[i - 1]!, old[i + 1]!]
      const q = p.slice(0, 4).map((v, j) => (j === 3 ? v : v + 0.5 * ((pr[j]! + nx[j]!) / 2 - v)))
      if (p.length === 6) {
        if (!tilted(pr, nx)) return p
        q.push(p[4]! + 0.5 * ((pr[4]! + nx[4]!) / 2 - p[4]!), arc(p[5]!, arc(pr[5]!, nx[5]!, 0.5), 0.5))
      }
      return q
    })
  }
  return cur
}
