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
  load?: () => Promise<PdfJs>
}

export async function importPdf(file: File, d: PdfImportDeps): Promise<PdfImportResult> {
  try {
    const p = await probePdf(file, d.load ?? browserPdfjs, d.signal, d.onProgress)
    const imp = pdfImport({ fileName: file.name, size: p.size, head: p.head, sha256: p.sha256, parse: p.parse })
    if ('error' in imp) return imp
    if (d.signal.aborted) return { cancelled: true }
    try {
      await d.store(p.sha256, p.bytes)
    } catch {
      return { error: 'noSpace' }
    }
    // shortcut: a cancel after the bytes were kept leaves them (content addressed, unreferenced) in the store.
    if (d.signal.aborted) return { cancelled: true }
    return { noteId: await d.create(imp) }
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError' || d.signal.aborted) return { cancelled: true }
    return { error: 'corrupt' }
  }
}
