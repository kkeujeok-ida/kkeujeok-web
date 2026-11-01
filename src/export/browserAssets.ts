// Browser-side inputs of the PDF export: the Pretendard files (public/fonts, OFL) and the WebP decoder.
import type { PdfFonts } from './pdfExport'

const get = async (name: string) => {
  const r = await fetch(`${import.meta.env.BASE_URL}fonts/Pretendard-${name}.ttf`)
  if (!r.ok) throw new Error(`font ${name}: ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

export const loadFonts = async (): Promise<PdfFonts> => {
  const [regular, semibold] = await Promise.all([get('Regular'), get('SemiBold')])
  return { regular, semibold }
}

/** WebP is not a PDF image type; its pixels go in losslessly as PNG. */
export async function webpToPng(bytes: Uint8Array): Promise<Uint8Array> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/webp' }))
  const c = new OffscreenCanvas(bmp.width, bmp.height)
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())
}
