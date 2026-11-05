// Story 9.3: the real pdf.js reads the sample PDFs of test/pdf/ the way the manifest says, and the import keeps its
// promises (refusal and cancel leave nothing).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { importPdf } from '../src/library/pdfImport'
import type { PdfJs } from '../src/model/pdfParse'

const dir = fileURLToPath(new URL('../../test/pdf/', import.meta.url))
const manifest = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8')) as Record<string, { status: string; sha256: string; pages: { width: number; height: number; box: number[]; rotate: number; userUnit: number }[] }>
const load = () => import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJs>
const fileOf = (name: string) => new File([readFileSync(dir + name)], name)

function run(name: string, over: { store?: (h: string, b: Uint8Array) => Promise<void>; signal?: AbortSignal; create?: () => Promise<string> } = {}) {
  const stored: string[] = []
  const discarded: string[] = []
  const created: unknown[] = []
  const d = {
    signal: over.signal ?? new AbortController().signal,
    onProgress: () => {},
    store: over.store ?? (async (h: string) => void stored.push(h)),
    create: over.create ?? (async (imp: unknown) => (created.push(imp), 'note-1')),
    discard: async (h: string) => void discarded.push(h),
    load,
  }
  return importPdf(fileOf(name), d).then((r) => ({ r, stored, created, discarded }))
}

describe('pdf import with the sample files', () => {
  for (const [name, m] of Object.entries(manifest).filter(([, m]) => m.status === 'ok')) {
    test(`${name} gives the pages of the manifest`, async () => {
      const { r, stored, created } = await run(name)
      expect(r).toEqual({ noteId: 'note-1' })
      expect(stored).toEqual([m.sha256])
      const imp = created[0] as { asset: string; pages: { width: number; height: number; background: Record<string, unknown> }[] }
      expect(imp.asset).toBe(m.sha256)
      expect(imp.pages.map((p) => ({ width: p.width, height: p.height, box: p.background.box, rotate: p.background.rotate, userUnit: p.background.userUnit }))).toEqual(
        m.pages.map((p) => ({ width: p.width, height: p.height, box: p.box, rotate: p.rotate, userUnit: p.userUnit })),
      )
    })
  }

  for (const [name, error] of [['encryptedUser.pdf', 'encrypted'], ['encryptedOwner.pdf', 'encrypted'], ['corrupt.pdf', 'corrupt'], ['notpdf.pdf', 'notPdf']] as const) {
    test(`${name} is refused as ${error} and nothing is kept`, async () => {
      const { r, stored, created } = await run(name)
      expect(r).toEqual({ error })
      expect(stored.length + created.length).toBe(0)
    })
  }

  test('a store that is full gives noSpace and no note', async () => {
    const { r, created } = await run('a4.pdf', { store: () => Promise.reject(new Error('quota')) })
    expect(r).toEqual({ error: 'noSpace' })
    expect(created).toEqual([])
  })

  test('a note that cannot be written gives the bytes back', async () => {
    const { r, stored, discarded } = await run('a4.pdf', { create: () => Promise.reject(new Error('disk')) })
    expect(r).toEqual({ error: 'corrupt' })
    expect(discarded).toEqual(stored)
  })

  test('a cancel leaves nothing', async () => {
    const ac = new AbortController()
    ac.abort()
    const { r, stored, created } = await run('mixed.pdf', { signal: ac.signal })
    expect(r).toEqual({ cancelled: true })
    expect(stored.length + created.length).toBe(0)
  })
})
