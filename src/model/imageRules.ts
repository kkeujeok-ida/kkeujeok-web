// Spec rules of spec/image.md: image.accept, image.initialSize, image.referencedAssets, image.uploadPlan,
// image.assetState. Pure (port of the Android lib/model/image_rules.dart).
import type { Note } from './note'
import { round2 } from './number'

/** The least width or height of an image, pt. */
export const IMAGE_SIZE_MIN = 1
/** Largest stored asset, bytes (10 MB). */
export const IMAGE_MAX_BYTES = 10_485_760

const HASH = /^[0-9a-f]{64}$/
/** True for 64 lowercase hex characters. */
export const isAssetHash = (v: unknown): v is string => typeof v === 'string' && HASH.test(v)

const HEIC = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])
export type Accept = { accept: 'as-is' | 'convert'; ext: 'jpg' | 'png' | 'webp' } | { error: 'unsupported' | 'tooLarge' }

/** `image.accept`: `head` is the first 12 bytes of the file as lowercase hex. */
export function imageAccept(head: string, size: number): Accept {
  const ascii = (from: number, to: number) =>
    head.length < to * 2 ? '' : String.fromCharCode(...Array.from({ length: to - from }, (_, i) => parseInt(head.slice((from + i) * 2, (from + i) * 2 + 2), 16)))
  let ext: 'jpg' | 'png' | 'webp' | null = null
  if (head.startsWith('ffd8ff')) ext = 'jpg'
  else if (head.startsWith('89504e470d0a1a0a')) ext = 'png'
  else if (head.length === 24 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') ext = 'webp'
  else if (head.length === 24 && ascii(4, 8) === 'ftyp' && HEIC.has(ascii(8, 12))) return { accept: 'convert', ext: 'jpg' }
  if (!ext) return { error: 'unsupported' }
  return size > IMAGE_MAX_BYTES ? { error: 'tooLarge' } : { accept: 'as-is', ext }
}

/** `image.initialSize`: `{ width, height, x, y }`. */
export function imageInitialSize(pxWidth: number, pxHeight: number, pageWidth: number, pageHeight: number) {
  const maxW = (pageWidth * 4) / 5
  const maxH = (pageHeight * 4) / 5
  const scale = Math.min(1, maxW / pxWidth, maxH / pxHeight)
  const w = Math.max(IMAGE_SIZE_MIN, pxWidth * scale)
  const h = Math.max(IMAGE_SIZE_MIN, pxHeight * scale)
  return { width: round2(w), height: round2(h), x: round2((pageWidth - w) / 2), y: round2((pageHeight - h) / 2) }
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** `image.referencedAssets`: the `asset` of every image element, sorted, without duplicates; a malformed one is kept (`""` when not a string). */
export function referencedAssets(note: Pick<Note, 'pages'>): string[] {
  const out = new Set<string>()
  for (const p of note.pages) {
    for (const e of (Array.isArray(p.elements) ? p.elements : []) as { type?: unknown; asset?: unknown }[]) {
      if (e && e.type === 'image') out.add(typeof e.asset === 'string' ? e.asset : '')
    }
  }
  return [...out].sort(byCodeUnit)
}

/** `image.uploadPlan`: what goes to Drive before the note. */
export function imageUploadPlan(referenced: readonly string[], confirmed: Iterable<string>, onDevice: Iterable<string>) {
  const conf = new Set(confirmed)
  const dev = new Set(onDevice)
  const upload = new Set<string>()
  const missing = new Set<string>()
  for (const h of referenced) {
    if (conf.has(h)) continue
    ;(dev.has(h) ? upload : missing).add(h)
  }
  return { upload: [...upload].sort(byCodeUnit), missing: [...missing].sort(byCodeUnit), blocked: missing.size > 0 }
}

export type AssetState = 'ready' | 'downloading' | 'failed'

/** `image.assetState`. */
export function assetState(asset: unknown, local: Iterable<string>, failed: Iterable<string>): AssetState {
  if (!isAssetHash(asset)) return 'failed'
  if (new Set(local).has(asset)) return 'ready'
  return new Set(failed).has(asset) ? 'failed' : 'downloading'
}
