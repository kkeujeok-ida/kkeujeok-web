// What the PDF file says (spec pdf.md `pdf.import` input): size, head, SHA-256 and the page boxes pdf.js reads.
// pdf.js parses in its own worker, so the page never waits for a 100 MB file. The library is injected (tests pass the
// Node build); the browser one is loaded only when an import starts.
import { PDF_HEAD_HEX, PDF_MAX_BYTES, PDF_MAX_PAGES, type PdfParse } from './pdfRules'
import { sha256Hex } from '../util/sha256'

export type PdfJs = typeof import('pdfjs-dist')

/** pdf.js with its worker file, loaded on first use. */
export async function browserPdfjs(): Promise<PdfJs> {
  const [lib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
  lib.GlobalWorkerOptions.workerSrc = worker.default
  return lib
}

export type Probe = { size: number; head: string; sha256: string; parse: PdfParse; bytes: Uint8Array }

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b)
const CHUNK = 65536

// pdf.js does not say whether a file has an owner password (it opens without asking), so the trailer text is looked at:
// /Encrypt in the first or last 64 KB. shortcut: a trailer inside a compressed object stream of an odd file is missed.
const hasEncrypt = (b: Uint8Array) => latin1(b.subarray(0, CHUNK)).includes('/Encrypt') || latin1(b.subarray(Math.max(0, b.length - CHUNK))).includes('/Encrypt')

/**
 * Reads `file` and asks pdf.js for the pages; reports `(done, total)` pages. A file that is too large or not a PDF is
 * not read further (the rule refuses it before anything else). Throws an AbortError when `signal` fires.
 */
export async function probePdf(file: Blob, load: () => Promise<PdfJs>, signal: AbortSignal, onProgress: (done: number, total: number) => void): Promise<Probe> {
  const stop = () => {
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError')
  }
  const size = file.size
  const head = hex(new Uint8Array(await file.slice(0, 5).arrayBuffer()))
  stop()
  const none = { size, head, sha256: '', parse: { status: 'corrupt' } as PdfParse, bytes: new Uint8Array(0) }
  if (head !== PDF_HEAD_HEX || size > PDF_MAX_BYTES) return none
  const bytes = new Uint8Array(await file.arrayBuffer())
  const sha256 = await sha256Hex(bytes)
  stop()
  const done = (parse: PdfParse): Probe => ({ size, head, sha256, parse, bytes })
  if (hasEncrypt(bytes)) return done({ status: 'encrypted' })
  const lib = await load()
  stop()
  // pdf.js takes over (detaches) the buffer it is given: it gets a copy.
  const task = lib.getDocument({ data: bytes.slice(), verbosity: 0 })
  const onAbort = () => void task.destroy()
  signal.addEventListener('abort', onAbort)
  try {
    const doc = await task.promise
    const n = doc.numPages
    // Too many pages are refused by the rule before any page is looked at.
    if (n > PDF_MAX_PAGES) return done({ status: 'ok', encrypted: false, pages: Array.from({ length: n }, () => ({})) })
    const pages = []
    for (let i = 1; i <= n; i++) {
      stop()
      const page = await doc.getPage(i)
      // shortcut: `view` is CropBox ∩ MediaBox (pdf.js falls back to the MediaBox when they do not meet, and to Letter
      // when a page has no MediaBox), so it goes in as the MediaBox; a corrupt box is not told apart.
      pages.push({ mediaBox: page.view, rotate: page.rotate, userUnit: page.userUnit })
      page.cleanup()
      onProgress(i, n)
    }
    return done({ status: 'ok', encrypted: false, pages })
  } catch (e) {
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError')
    return done({ status: (e as { name?: string })?.name === 'PasswordException' ? 'encrypted' : 'corrupt' })
  } finally {
    signal.removeEventListener('abort', onAbort)
    void task.destroy()
  }
}
