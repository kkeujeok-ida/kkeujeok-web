// Draws an image element (spec image.md): the decoded picture in its box, turned about the box center, or the grey
// placeholder while the asset is not on this device; a small mark while Drive does not hold the asset yet.
import type { AssetState } from '../model/imageRules'

type El = Record<string, unknown>

/** What the painter needs to know about an asset; the page being drawn has no host (thumbnails), then only the grey box is drawn. */
export type ImageSource = {
  /** The decoded picture, 'broken' when it could not be decoded, null while it is being decoded. */
  bitmap(hash: string): CanvasImageSource | 'broken' | null
  state(asset: unknown): AssetState
  pending(asset: string): boolean
  labels: { downloading: string; failed: string; broken: string }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** An image element that can be drawn. */
export const drawableImage = (e: unknown): e is El => !!e && typeof e === 'object' && (e as El).type === 'image' && ['x', 'y', 'width', 'height'].every((k) => isNum((e as El)[k]))

export function paintImage(ctx: CanvasRenderingContext2D, e: El, src?: ImageSource): void {
  const x = e.x as number, y = e.y as number, w = e.width as number, h = e.height as number
  const rot = isNum(e.rotation) ? e.rotation : 0
  const asset = e.asset
  ctx.save()
  try {
    if (rot) {
      ctx.translate(x + w / 2, y + h / 2)
      ctx.rotate((rot * Math.PI) / 180)
      ctx.translate(-(x + w / 2), -(y + h / 2))
    }
    const state = src ? src.state(asset) : 'downloading'
    const pic = src && state === 'ready' && typeof asset === 'string' ? src.bitmap(asset) : null
    if (pic && pic !== 'broken') {
      ctx.drawImage(pic, x, y, w, h)
    } else {
      ctx.fillStyle = '#e5e7eb'
      ctx.fillRect(x, y, w, h)
      const text = !src ? '' : pic === 'broken' ? src.labels.broken : state === 'failed' ? src.labels.failed : state === 'downloading' ? src.labels.downloading : ''
      const size = Math.max(6, Math.min(14, Math.min(w, h) / 6))
      if (text && w > size * 3) {
        ctx.fillStyle = '#6b7280'
        ctx.font = `400 ${size}px Pretendard, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, x + w / 2, y + h / 2, w - 8)
      }
    }
    if (src && typeof asset === 'string' && src.pending(asset)) {
      // "저장 대기": a small clock on the top right corner.
      const r = Math.max(3, Math.min(8, Math.min(w, h) / 4))
      const cx = x + w - r - 2, cy = y + r + 2
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(55, 65, 81, 0.85)'
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = Math.max(0.6, r / 6)
      ctx.beginPath()
      ctx.moveTo(cx, cy - r * 0.55)
      ctx.lineTo(cx, cy)
      ctx.lineTo(cx + r * 0.4, cy + r * 0.25)
      ctx.stroke()
    }
  } finally {
    ctx.restore()
  }
}
