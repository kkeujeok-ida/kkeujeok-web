// The images of the notes on screen: the bytes (IndexedDB), their sync state with Drive, the decoded pictures the
// painter draws, and the import of a new file. One per page session; the writers and the uploader share it.
import { type ImageIo, type ImportError, type Prepared, browserImageIo, prepareImage } from '../model/imageImport'
import type { Note } from '../model/note'
import type { AssetStore } from '../storage/assetStore'
import type { AssetSync } from '../sync/assetSync'
import type { ImageSource } from './imagePainter'

/** The longest side a picture is kept at for drawing (pixels). */
export const DECODE_MAX = 2048
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

export type ImageHost = ImageSource & {
  /** Starts reading, fetching and confirming the assets of the images of `note` (a no-op for a note already seen). */
  watch(note: Note): void
  subscribe(fn: () => void): () => void
  /** [다시 시도] on a placeholder. */
  retry(asset: string): void
  /** The file as bytes in the store and the sync state, ready for `insertImage`; nothing is stored on an error. */
  prepare(file: Blob): Promise<(Prepared & { stored: true }) | { error: ImportError | 'storeFailed' }>
  markConfirmed(hash: string): void
}

export function createImageHost(d: { store: AssetStore; sync: AssetSync; io?: ImageIo; decodeBitmap?: (blob: Blob) => Promise<ImageBitmap> }): ImageHost {
  const io = d.io ?? browserImageIo
  const bitmaps = new Map<string, CanvasImageSource | 'broken'>()
  const decoding = new Set<string>()
  const exts = new Map<string, string>()
  const listeners = new Set<() => void>()
  const tell = () => listeners.forEach((f) => f())
  d.sync.subscribe(tell)
  let seen: Note | null = null

  // Decodes once per hash; a hash that failed is not tried again (no endless repaint).
  async function decode(hash: string) {
    decoding.add(hash)
    try {
      const rec = await d.store.get(hash)
      if (!rec) {
        // The bytes are gone or failed their check: no retry here; the sync state forgets them (a fetch may bring them back).
        bitmaps.set(hash, 'broken')
        d.sync.dropLocal(hash)
        return
      }
      const blob = new Blob([rec.bytes as BlobPart], { type: MIME[rec.ext] ?? '' })
      let bmp = await (d.decodeBitmap ?? createImageBitmap)(blob)
      const long = Math.max(bmp.width, bmp.height)
      if (long > DECODE_MAX) {
        const k = DECODE_MAX / long
        const small = await createImageBitmap(bmp, { resizeWidth: Math.max(1, Math.round(bmp.width * k)), resizeHeight: Math.max(1, Math.round(bmp.height * k)), resizeQuality: 'high' })
        bmp.close()
        bmp = small
      }
      bitmaps.set(hash, bmp)
    } catch {
      bitmaps.set(hash, 'broken')
    } finally {
      decoding.delete(hash)
      tell()
    }
  }

  return {
    labels: { downloading: '', failed: '', broken: '' },
    state: (asset) => d.sync.state(asset),
    pending: (asset) => d.sync.pending(asset),
    bitmap(hash) {
      const b = bitmaps.get(hash)
      if (b) return b
      if (!decoding.has(hash)) void decode(hash)
      return null
    },
    watch(note) {
      if (note === seen) return
      seen = note
      const found = new Map<string, string>()
      for (const p of note.pages) for (const e of p.elements as { type?: unknown; asset?: unknown; ext?: unknown }[]) if (e?.type === 'image' && typeof e.asset === 'string') found.set(e.asset, String(e.ext))
      for (const [h, ext] of found) exts.set(h, ext)
      if (found.size > 0) void d.sync.ensure(found)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    retry: (asset) => d.sync.retry(asset, exts.get(asset) ?? 'jpg'),
    markConfirmed: (hash) => d.sync.markConfirmed(hash),
    async prepare(file) {
      const p = await prepareImage(file, io)
      if ('error' in p) return p
      try {
        await d.store.put(p.hash, p.ext, p.bytes)
      } catch {
        p.bitmap?.close()
        return { error: 'storeFailed' }
      }
      if (p.bitmap && !bitmaps.has(p.hash) && Math.max(p.pxWidth, p.pxHeight) <= DECODE_MAX) bitmaps.set(p.hash, p.bitmap)
      else p.bitmap?.close()
      exts.set(p.hash, p.ext)
      d.sync.markLocal(p.hash)
      return { ...p, stored: true }
    },
  }
}
