// spec rule `stroke.smooth` (pen-feel.md): Catmull-Rom densify, then neighbour-average passes, at draw time only.
export const SMOOTH_MAX = 10

/** Points are `[x, y, pressure, t]`. Ends stay; inserted points get the mean `t`; the input is not changed. */
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
      cur.push([...m, (at(i, 3) + at(i + 1, 3)) / 2])
    }
  }
  for (let pass = 0; pass < Math.ceil(level / 2); pass++) {
    const old = cur
    cur = old.map((p, i) =>
      i === 0 || i === old.length - 1 ? p : p.map((v, j) => (j === 3 ? v : v + 0.5 * ((old[i - 1]![j]! + old[i + 1]![j]!) / 2 - v))),
    )
  }
  return cur
}
