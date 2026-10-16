import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { md5Hex } from '../src/util/md5'

const enc = (s: string) => new TextEncoder().encode(s)

describe('md5Hex', () => {
  // RFC 1321 test suite
  test.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
  ])('known vector %j', (text, want) => {
    expect(md5Hex(enc(text))).toBe(want)
  })

  test('the padding boundaries (55, 56, 63, 64, 65, 119, 120 bytes) agree with node:crypto', () => {
    for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 121, 128, 1000]) {
      const b = new Uint8Array(randomBytes(n))
      expect(md5Hex(b), `length ${n}`).toBe(createHash('md5').update(b).digest('hex'))
    }
  })

  test('a view into a larger buffer is hashed by its own bytes', () => {
    const b = new Uint8Array(randomBytes(300))
    expect(md5Hex(b.subarray(10, 250))).toBe(createHash('md5').update(b.subarray(10, 250)).digest('hex'))
  })

  test('a few MB of random bytes', () => {
    const b = new Uint8Array(randomBytes(3 * 1024 * 1024 + 7))
    expect(md5Hex(b)).toBe(createHash('md5').update(b).digest('hex'))
  })
})
