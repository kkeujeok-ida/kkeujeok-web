// spec rule `stroke.texture.pencil` (pen-kinds.md): density only. The grain is the tile image public/pencil_grain.png,
// never stored in a note. Page units per tile pixel: the tile is a 512 px paper-tooth grain.
export const PENCIL_GRAIN_SCALE = 0.6

/** `density(q)` and `threshold(q)`; `q` is clamped to 0..1. */
export function pencilDensity(q: number): { density: number; threshold: number } {
  const c = Number.isNaN(q) ? 0.5 : Math.min(1, Math.max(0, q))
  const density = 0.35 + 0.6 * c
  return { density, threshold: Math.floor(density * 65536 + 1e-6) }
}

let tilePromise: Promise<CanvasImageSource | null> | null = null
function loadTile(): Promise<CanvasImageSource | null> {
  tilePromise ??= new Promise((resolve) => {
    if (typeof Image === 'undefined') return resolve(null)
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null) // the plain alpha polygon stays
    img.src = `${import.meta.env.BASE_URL}pencil_grain.png`
  })
  return tilePromise
}

/** The grain tile (shared by every page). `tile` is null until loaded; set `onReady` to repaint then. */
export class PencilTextures {
  tile: CanvasImageSource | null = null
  onReady: (() => void) | null = null
  private ready = loadTile().then((t) => {
    this.tile = t
    if (t) this.onReady?.()
  })

  /** Resolves when the tile is loaded (export). */
  settled(): Promise<void> {
    return this.ready
  }
}
