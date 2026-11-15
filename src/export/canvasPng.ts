// Canvas PNG export (spec canvas.md): the one page at 1x/2x, transparent kept transparent, a color ground drawn, no checkerboard.
import type { Note } from '../model/note'
import { canvasExportSize } from '../model/canvasRules'
import { sharedAssetStore } from '../sync/imageWiring'
import { downloadBlob } from '../ui/download'
import { renderPageRaster } from './pageRaster'

/** Over the pixel limit, or the browser could not draw it: the caller asks for a lower scale. */
export class CanvasExportTooLarge extends Error {}

export async function exportCanvasPng(note: Note, scale: number): Promise<void> {
  const page = note.pages[0] as unknown as { width: number; height: number; background: unknown }
  const size = canvasExportSize(page.width, page.height, scale, page.background)
  if ('error' in size) throw new CanvasExportTooLarge()
  const bytes = await renderPageRaster(page as never, size.pixelWidth, size.pixelHeight, sharedAssetStore(), { scale, alpha: size.alpha })
  if (!bytes) throw new CanvasExportTooLarge()
  downloadBlob(`${note.meta.title.replace(/[\/:*?"<>|]/g, '_') || 'canvas'}@${scale}x.png`, bytes as BlobPart, 'image/png')
}
