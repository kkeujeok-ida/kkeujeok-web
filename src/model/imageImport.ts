// A picked, dropped or pasted file -> the bytes to store (spec image.md: image.accept in two steps, the SHA-256 of the
// stored bytes). The browser's decoder is injected so tests need no canvas.
import { imageAccept, IMAGE_MAX_BYTES } from './imageRules'
import { sha256Hex } from '../util/sha256'

export type Prepared = { hash: string; ext: 'jpg' | 'png' | 'webp'; bytes: Uint8Array; pxWidth: number; pxHeight: number; converted: boolean; bitmap?: ImageBitmap }
/** `ignored`: not an image, say nothing. `unsupported`: an image type the app does not take (GIF, ...). */
export type ImportError = 'ignored' | 'unsupported' | 'tooLarge' | 'convertFailed' | 'unreadable'

export type ImageIo = {
  /** Pixel size of the image in `blob` (and the decoded bitmap, kept for drawing); throws when it cannot be decoded. */
  decode(blob: Blob): Promise<{ width: number; height: number; bitmap?: ImageBitmap }>
  /** The JPEG bytes of the image in `blob`; throws when the browser cannot decode or encode it. */
  toJpeg(blob: Blob): Promise<Uint8Array>
}

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const
const hex = (b: Uint8Array) => [...b.subarray(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join('')

/** The browser's own decoder and JPEG encoder. */
export const browserImageIo: ImageIo = {
  async decode(blob) {
    const bitmap = await createImageBitmap(blob)
    return { width: bitmap.width, height: bitmap.height, bitmap }
  },
  async toJpeg(blob) {
    const bmp = await createImageBitmap(blob)
    try {
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const ctx = c.getContext('2d')
      if (!ctx) throw new Error('no canvas')
      ctx.fillStyle = '#ffffff' // JPEG has no alpha
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.drawImage(bmp, 0, 0)
      const out = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.92))
      if (!out) throw new Error('encode failed')
      return new Uint8Array(await out.arrayBuffer())
    } finally {
      bmp.close()
    }
  },
}

export async function prepareImage(file: Blob, io: ImageIo = browserImageIo): Promise<Prepared | { error: ImportError }> {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    return { error: 'unreadable' }
  }
  if (bytes.length === 0) return { error: 'ignored' }
  let a = imageAccept(hex(bytes), bytes.length)
  if ('error' in a) return { error: a.error === 'unsupported' && !file.type.startsWith('image/') ? 'ignored' : a.error }
  let converted = false
  if (a.accept === 'convert') {
    try {
      bytes = await io.toJpeg(file)
    } catch {
      return { error: 'convertFailed' }
    }
    // The limit is on the bytes that are stored: ask again with the converted ones.
    a = bytes.length > 0 ? imageAccept(hex(bytes), bytes.length) : { error: 'unsupported' }
    if ('error' in a) return { error: a.error === 'tooLarge' ? 'tooLarge' : 'convertFailed' }
    converted = true
  }
  if (bytes.length > IMAGE_MAX_BYTES) return { error: 'tooLarge' }
  const ext = a.ext
  let size: { width: number; height: number; bitmap?: ImageBitmap }
  try {
    size = await io.decode(new Blob([bytes as BlobPart], { type: MIME[ext] }))
  } catch {
    return { error: 'unreadable' }
  }
  const pxWidth = Math.round(size.width)
  const pxHeight = Math.round(size.height)
  if (!(pxWidth >= 1 && pxHeight >= 1)) return { error: 'unreadable' }
  return { hash: await sha256Hex(bytes), ext, bytes, pxWidth, pxHeight, converted, ...(size.bitmap && { bitmap: size.bitmap }) }
}
