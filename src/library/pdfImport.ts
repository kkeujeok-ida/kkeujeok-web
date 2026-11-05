// A picked or dropped PDF becomes a new note (spec pdf.md `pdf.import`). Order: read and check -> keep the bytes ->
// write the note, so a refusal or a cancel leaves nothing and the note never exists without its PDF.
import { type PdfJs, browserPdfjs, probePdf } from '../model/pdfParse'
import { type ImportError, type PdfImportOut, pdfImport } from '../model/pdfRules'

/** `noSpace`: the browser would not keep the bytes. */
export type PdfImportError = ImportError | 'noSpace'
export type PdfImportResult = { noteId: string } | { error: PdfImportError } | { cancelled: true }

export type PdfImportDeps = {
  signal: AbortSignal
  onProgress: (done: number, total: number) => void
  /** Keeps the bytes of the PDF under `hash`; throws when they cannot be kept. */
  store: (hash: string, bytes: Uint8Array) => Promise<void>
  /** Writes the new note; resolves with its id. */
  create: (imp: PdfImportOut) => Promise<string>
  /** Drops the kept bytes unless a note uses them. */
  discard: (hash: string) => Promise<void>
  /** The bytes are about to be kept: from here a cancel is too late for the caller. */
  onSaving?: () => void
  load?: () => Promise<PdfJs>
}

export async function importPdf(file: File, d: PdfImportDeps): Promise<PdfImportResult> {
  try {
    const p = await probePdf(file, d.load ?? browserPdfjs, d.signal, d.onProgress)
    const imp = pdfImport({ fileName: file.name, size: p.size, head: p.head, sha256: p.sha256, parse: p.parse })
    if ('error' in imp) return imp
    if (d.signal.aborted) return { cancelled: true }
    d.onSaving?.()
    try {
      await d.store(p.sha256, p.bytes)
    } catch {
      return { error: 'noSpace' }
    }
    const drop = () => d.discard(p.sha256).catch(() => {})
    if (d.signal.aborted) return await drop(), { cancelled: true }
    try {
      return { noteId: await d.create(imp) }
    } catch {
      await drop()
      return { error: 'corrupt' }
    }
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError' || d.signal.aborted) return { cancelled: true }
    return { error: 'corrupt' }
  }
}
