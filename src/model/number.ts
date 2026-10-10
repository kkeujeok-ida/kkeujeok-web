/**
 * spec rule `number.round2`: round to 2 decimal places, half away from zero,
 * on the shortest round-trip decimal of `x` (what `String(x)` prints), not on
 * its binary value. Never returns `-0`. `x` must be finite.
 */
export function round2(x: number): number {
  // Every double of magnitude 2^53 or more is an integer, so this also covers
  // the values String() prints with a positive exponent.
  if (Number.isInteger(x)) return x === 0 ? 0 : x

  const s = String(Math.abs(x))
  // A non-integer in exponent notation is below 1e-6 in magnitude.
  if (s.includes('e')) return 0

  const [int = '', frac = ''] = s.split('.')
  if (frac.length <= 2) return x

  // Exact decimal arithmetic on the digits, never on the binary value.
  const hundredths = BigInt(int + frac.slice(0, 2)) + (frac.charAt(2) >= '5' ? 1n : 0n)
  const magnitude = Number(
    `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`,
  )
  return x < 0 && magnitude !== 0 ? -magnitude : magnitude
}
