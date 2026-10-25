// @vitest-environment jsdom
// Story 4.13: web image insert and asset sync, the core paths: conversion and the size limit, insert + undo, the same
// image twice, assets before the note against the fake Drive, placeholder -> picture, and the paste priority.
import 'fake-indexeddb/auto'
import { createHash } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DriveError } from '../src/drive/driveClient'
import { I18nContext, createI18n } from '../src/i18n'
import { elementClipboard } from '../src/model/elementClipboard'
import { type ImageIo, prepareImage } from '../src/model/imageImport'
import { IMAGE_MAX_BYTES } from '../src/model/imageRules'
import type { Note } from '../src/model/note'
import { defaultPen } from '../src/model/pen'
import { History } from '../src/ops/history'
import { clearSessionHistories } from '../src/ops/sessionHistories'
import { createImageHost } from '../src/render/imageHost'
import { createAssetStore } from '../src/storage/assetStore'
import { deleteNoteDatabase, openNoteDb } from '../src/storage/noteDb'
import { openNoteStore, type NoteStore } from '../src/storage/noteStore'
import { savesSettled } from '../src/storage/saveQueue'
import { createAssetSync } from '../src/sync/assetSync'
import { createPenDetected } from '../src/storage/penDetected'
import { NoteEditor } from '../src/ui/library/NoteEditor'
import { Writer } from '../src/ui/library/writer'
import { createFakeDrive } from './fakeDrive'
import { type Env, NID, makeEnv, mkNote } from './uploadHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (n = 20, fill = 7) => new Uint8Array([...PNG_SIG, ...new Array<number>(n).fill(fill)])
const jpeg = (n = 20) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(n).fill(1)])
const heic = () => new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 1, 2, 3, 4])
// A file-like value: jsdom's Blob may lack arrayBuffer().
const file = (bytes: Uint8Array, type: string, name = 'f') => ({ type, name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) as unknown as File
const io = (o: Partial<ImageIo> = {}): ImageIo => ({ decode: async () => ({ width: 800, height: 600 }), toJpeg: async () => jpeg(), ...o })

describe('prepareImage', () => {
  test('PNG as is: hash of the stored bytes, pixel size from the decoder', async () => {
    const b = png()
    const r = await prepareImage(file(b, 'image/png'), io())
    expect(r).toMatchObject({ hash: sha(b), ext: 'png', pxWidth: 800, pxHeight: 600, converted: false })
  })

  test('HEIC is converted to JPEG, the hash is that of the converted bytes, and it says so', async () => {
    const j = jpeg(50)
    const r = await prepareImage(file(heic(), 'image/heic'), io({ toJpeg: async () => j }))
    expect(r).toMatchObject({ hash: sha(j), ext: 'jpg', converted: true })
  })

  test('the limit is on the stored bytes: a conversion over 10 MB, and a PNG over it, are tooLarge; exactly 10 MB passes', async () => {
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1)
    big.set(PNG_SIG)
    expect(await prepareImage(file(big, 'image/png'), io())).toEqual({ error: 'tooLarge' })
    expect(await prepareImage(file(heic(), 'image/heic'), io({ toJpeg: async () => { const j = new Uint8Array(IMAGE_MAX_BYTES + 1); j.set([0xff, 0xd8, 0xff]); return j } }))).toEqual({ error: 'tooLarge' })
    const exact = new Uint8Array(IMAGE_MAX_BYTES)
    exact.set(PNG_SIG)
    expect(await prepareImage(file(exact, 'image/png'), io())).toMatchObject({ ext: 'png' })
  })

  test('a browser that cannot convert gives convertFailed; files that are not images are ignored; GIF is unsupported', async () => {
    expect(await prepareImage(file(heic(), 'image/heic'), io({ toJpeg: async () => { throw new Error('no') } }))).toEqual({ error: 'convertFailed' })
    expect(await prepareImage(file(new TextEncoder().encode('hello world!!'), 'text/plain'), io())).toEqual({ error: 'ignored' })
    expect(await prepareImage(file(new TextEncoder().encode('GIF89a......'), 'image/gif'), io())).toEqual({ error: 'unsupported' })
    expect(await prepareImage(file(png(), 'image/png'), io({ decode: async () => { throw new Error('bad') } }))).toEqual({ error: 'unreadable' })
  })
})

function newNote(): Note {
  const n = mkNote()
  n.noteId = 'n'
  n.pages[0]!.id = 'p'
  return n
}

describe('assets and sync state', () => {
  let ndb: ReturnType<typeof openNoteDb>
  let drive: ReturnType<typeof createFakeDrive>
  const flush = () => new Promise((r) => setTimeout(r, 10))
  const mkSync = (o: { allowed?: () => boolean } = {}) => {
    const store = createAssetStore(ndb)
    return { store, sync: createAssetSync({ store, drive, online: () => true, allowed: o.allowed ?? (() => true), sleep: async () => {}, jitter: () => 0.5 }) }
  }
  const putOnDrive = (bytes: Uint8Array, hash = sha(bytes)) =>
    drive.uploadSimple({ metadata: { name: `${hash}.png`, parents: ['ROOT'], appProperties: { kkeujeokId: `asset:${hash}` } }, bytes })

  beforeEach(() => {
    ndb = openNoteDb()
    drive = createFakeDrive()
  })
  afterEach(async () => {
    ndb.close()
    await deleteNoteDatabase()
  })

  test('a placeholder (downloading) becomes ready when the asset arrives, one download per hash, bytes verified and kept', async () => {
    const b = png(40)
    const h = sha(b)
    await putOnDrive(b)
    const { store, sync } = mkSync()
    expect(sync.state(h)).toBe('downloading')
    await Promise.all([sync.ensure(new Map([[h, 'png']])), sync.ensure(new Map([[h, 'png']]))])
    await flush()
    expect(sync.state(h)).toBe('ready')
    expect(drive.count('downloadFile')).toBe(1)
    expect((await store.get(h))!.bytes).toEqual(b)
    expect(sync.pending(h)).toBe(false) // it came from Drive
  })

  test('a failed download is `failed`, [다시 시도] fetches again; bytes that do not match their hash are dropped', async () => {
    const b = png(40)
    const h = sha(b)
    await putOnDrive(b)
    const { sync } = mkSync()
    drive.failAlways('downloadFile', new DriveError('http', 500))
    await sync.ensure(new Map([[h, 'png']]))
    await flush()
    expect(sync.state(h)).toBe('failed')
    drive.clearFailures()
    sync.retry(h, 'png')
    await flush()
    expect(sync.state(h)).toBe('ready')

    const other = png(41)
    const bad = sha(other)
    await putOnDrive(png(42), bad) // Drive holds other bytes under that name
    await sync.ensure(new Map([[bad, 'png']]))
    await flush()
    expect(sync.state(bad)).toBe('failed')
  })

  test('bytes stored here and not on Drive are `pending` until Drive is seen to hold them', async () => {
    const b = png(40)
    const h = sha(b)
    const { store, sync } = mkSync()
    await store.put(h, 'png', b)
    sync.markLocal(h)
    expect(sync.pending(h)).toBe(true)
    sync.markConfirmed(h)
    expect(sync.pending(h)).toBe(false)
  })

  test('the store survives a reload (a new store over the same database) and refuses bytes that are not their hash', async () => {
    const b = png(40)
    const h = sha(b)
    await createAssetStore(ndb).put(h, 'png', b)
    expect((await createAssetStore(openNoteDb()).get(h))!.ext).toBe('png')
    await expect(createAssetStore(ndb).put(sha(png(41)), 'png', b)).rejects.toThrow()
  })

  describe('upload order (against the fake Drive)', () => {
    let env: Env
    afterEach(() => env?.close())
    const withImage = (hash: string): Note => {
      const n = mkNote()
      n.pages[0]!.elements.push({ id: 'img1', type: 'image', x: 10, y: 10, width: 100, height: 50, rotation: 0, asset: hash, ext: 'png', pxWidth: 800, pxHeight: 600 } as never)
      return n
    }
    const names = () => env.drive.uploads.map((u) => u.metadata.name as string)

    test('the asset goes first into `.assets`, then the note; the second upload does not send the asset again', async () => {
      const b = png(60)
      const h = sha(b)
      const assets = createAssetStore(ndb)
      await assets.put(h, 'png', b)
      env = await makeEnv({ assets })
      await env.store.writeNote(withImage(h))
      expect(await env.uploader.upload(NID)).toBe('uploaded')
      expect(names()).toEqual([`${h}.png`, '수학 노트.kkj'])
      const folder = env.drive.byKkeujeokId('assets')
      expect(folder).toHaveLength(1)
      expect(env.drive.byKkeujeokId(`asset:${h}`)[0]!.parents).toEqual([folder[0]!.id])
      // An edit: only the note goes again.
      const n = withImage(h)
      n.pages[0]!.rev = 'a2'
      await env.store.writeNote(n)
      expect(await env.uploader.upload(NID)).toBe('uploaded')
      expect(names()).toEqual([`${h}.png`, '수학 노트.kkj', '수학 노트.kkj'])
    })

    test('an asset that fails keeps the note back', async () => {
      const b = png(60)
      const h = sha(b)
      const assets = createAssetStore(ndb)
      await assets.put(h, 'png', b)
      env = await makeEnv({ assets })
      await env.store.writeNote(withImage(h))
      env.drive.failAlways('uploadSimple', new DriveError('http', 500))
      expect(await env.uploader.upload(NID)).toBe('failed')
      expect(env.drive.byKkeujeokId(NID)).toHaveLength(0)
      expect(names()).toEqual([])
    })

    test('an asset nobody has (no bytes here, none on Drive) blocks the note', async () => {
      env = await makeEnv({ assets: createAssetStore(ndb) })
      await env.store.writeNote(withImage(sha(png(61))))
      expect(await env.uploader.upload(NID)).toBe('failed')
      expect(env.drive.byKkeujeokId(NID)).toHaveLength(0)
      expect(names()).toEqual([])
    })

    test('an asset Drive already holds is not sent, and the bytes here need not exist', async () => {
      const b = png(60)
      const h = sha(b)
      env = await makeEnv({ assets: createAssetStore(ndb) })
      await env.drive.uploadSimple({ metadata: { name: `${h}.png`, parents: ['ROOT'], appProperties: { kkeujeokId: `asset:${h}` } }, bytes: b })
      await env.store.writeNote(withImage(h))
      expect(await env.uploader.upload(NID)).toBe('uploaded')
      expect(names()).toEqual([`${h}.png`, '수학 노트.kkj'])
    })
  })
})

describe('Writer insert', () => {
  const proto = HTMLCanvasElement.prototype
  const origRect = proto.getBoundingClientRect
  const origCtx = proto.getContext
  let canvas: HTMLCanvasElement
  let ndb: ReturnType<typeof openNoteDb>
  const make = (readOnly = false) => {
    const w = new Writer(new History(newNote()), { writeNote: async () => {}, close: () => {} } as never, () => defaultPen, () => {}, () => 'X')
    const store = createAssetStore(ndb)
    const sync = createAssetSync({ store, drive: createFakeDrive(), online: () => false, allowed: () => false, sleep: async () => {}, jitter: () => 0.5 })
    w.images = createImageHost({ store, sync, io: io() })
    w.readOnly = readOnly
    w.attach(canvas)
    return { w, store }
  }
  const els = (w: Writer) => w.history.note.pages[0]!.elements as unknown as Record<string, unknown>[]

  beforeEach(() => {
    proto.getBoundingClientRect = () => ({ width: 595, height: 842, left: 0, top: 0, right: 595, bottom: 842, x: 0, y: 0, toJSON() {} }) as DOMRect
    proto.getContext = (() => null) as never
    canvas = document.createElement('canvas')
    document.body.append(canvas)
    ndb = openNoteDb()
  })
  afterEach(async () => {
    proto.getBoundingClientRect = origRect
    proto.getContext = origCtx
    canvas.remove()
    ndb.close()
    await deleteNoteDatabase()
  })

  test('one insert is one edit, selected, smaller than the page, with the bytes stored first; undo takes it back', async () => {
    const { w, store } = make()
    const b = png(30)
    expect(await w.insertImage(file(b, 'image/png'), 'center')).toBe(true)
    expect(els(w)).toHaveLength(1)
    const e = els(w)[0]!
    expect(e).toMatchObject({ type: 'image', asset: sha(b), ext: 'png', pxWidth: 800, pxHeight: 600, rotation: 0 })
    expect(e.width as number).toBeLessThanOrEqual((595 * 4) / 5)
    expect(w.selectedCount).toBe(1)
    expect(w.history.undoDepth).toBe(1)
    expect((await store.get(sha(b)))!.bytes).toEqual(b)
    w.undo()
    expect(els(w)).toHaveLength(0)
    w.redo()
    expect(els(w)).toHaveLength(1)
  })

  test('the same image twice: two elements, one asset', async () => {
    const { w, store } = make()
    const b = png(30)
    await w.insertImage(file(b, 'image/png'), 'center')
    await w.insertImage(file(b, 'image/png'), 'center')
    expect(els(w)).toHaveLength(2)
    expect(els(w)[0]!.asset).toBe(els(w)[1]!.asset)
    expect(els(w)[0]!.id).not.toBe(els(w)[1]!.id)
    const n = await ndb.withDb((db) => db.count('assets'))
    expect(n).toBe(1)
    expect(await store.get(sha(b))).not.toBeNull()
  })

  test('a drop over the page is centered there; a drop outside the page goes to the middle of the view', async () => {
    const { w } = make()
    await w.insertImage(file(png(30), 'image/png'), { x: 100, y: 200 })
    const a = els(w)[0]!
    expect(Math.abs((a.x as number) + (a.width as number) / 2 - 100 / w.info().scale)).toBeLessThan(1.5)
    await w.insertImage(file(png(31), 'image/png'), { x: -500, y: -500 })
    const b = els(w)[1]!
    expect(Math.abs((b.x as number) + (b.width as number) / 2 - 297.5)).toBeLessThan(1.5) // the page middle
  })

  test('read-only inserts nothing; a file that is not an image changes nothing and says nothing', async () => {
    const ro = make(true)
    expect(await ro.w.insertImage(file(png(), 'image/png'), 'center')).toBe(false)
    expect(els(ro.w)).toHaveLength(0)
    const { w } = make()
    expect(await w.insertImage(file(new TextEncoder().encode('just some text'), 'text/plain'), 'center')).toBe(false)
    expect(w.history.undoDepth).toBe(0)
  })
})

describe('editor paste priority', () => {
  const proto = HTMLCanvasElement.prototype
  const origRect = proto.getBoundingClientRect
  const origCtx = proto.getContext
  let host: HTMLElement
  let root: Root
  const stores: NoteStore[] = []
  let ndb: ReturnType<typeof openNoteDb>
  const settle = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
  const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)
  const textBox = { id: 't1', type: 'text', x: 100, y: 100, width: 200, rotation: 0, text: 'abc', runs: [], size: 16, color: '#000000', bold: false, italic: false }

  async function mount() {
    const s = openNoteStore()
    await s.writeNote(newNote())
    s.close()
    const store = createAssetStore(ndb)
    const sync = createAssetSync({ store, drive: createFakeDrive(), online: () => false, allowed: () => false, sleep: async () => {}, jitter: () => 0.5 })
    act(() =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: createI18n({ navigatorLanguage: 'ko-KR', storage: { getItem: () => null, setItem: () => {} } }) },
          createElement(NoteEditor, {
            noteId: 'n', penDetectedStore: createPenDetected({ getItem: () => null, setItem: () => {} }),
            images: createImageHost({ store, sync, io: io() }),
            openStore: () => {
              const st = openNoteStore()
              stores.push(st)
              return st
            },
          }),
        ),
      ),
    )
    await settle()
    await settle()
  }
  const paste = (init: { files?: File[]; text?: string }) => {
    const e = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown }
    e.clipboardData = { files: init.files ?? [], getData: (t: string) => (t === 'text/plain' ? (init.text ?? '') : '') }
    const c = q<HTMLCanvasElement>('canvas.editor-canvas')!
    c.focus()
    act(() => void c.dispatchEvent(e))
    return e
  }
  const images = () => [...host.querySelectorAll('ul[aria-label="이미지"] li')].map((li) => li.textContent)
  const texts = () => [...host.querySelectorAll('ul[aria-label="텍스트 상자"] li')].map((li) => li.textContent)

  beforeEach(() => {
    proto.getBoundingClientRect = () => ({ width: 595, height: 842, left: 0, top: 0, right: 595, bottom: 842, x: 0, y: 0, toJSON() {} }) as DOMRect
    proto.getContext = (() => null) as never
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    location.hash = ''
    clearSessionHistories()
    elementClipboard.set([])
    ndb = openNoteDb()
  })
  afterEach(async () => {
    act(() => root.unmount())
    await savesSettled()
    host.remove()
    for (const s of stores.splice(0)) s.close()
    ndb.close()
    await deleteNoteDatabase()
    proto.getBoundingClientRect = origRect
    proto.getContext = origCtx
  })

  test('an image file on the clipboard becomes an image (waiting to be saved), even with text next to it', async () => {
    await mount()
    const e = paste({ files: [file(png(30), 'image/png')], text: 'caption' })
    await settle()
    expect(e.defaultPrevented).toBe(true)
    expect(images()).toEqual(['이미지, 저장 대기'])
    expect(texts()).toEqual([])
  })

  test('elements copied in this tab win; plain text with no image is a text box', async () => {
    await mount()
    elementClipboard.set([textBox])
    paste({ files: [file(png(30), 'image/png')] })
    await settle()
    expect(images()).toEqual([])
    expect(texts()).toEqual(['abc'])
    elementClipboard.set([])
    paste({ text: '글' })
    await settle()
    expect(texts()).toEqual(['abc', '글'])
  })

  test('typing in a field keeps its own paste; the toolbar [이미지] picks files', async () => {
    await mount()
    const input = document.createElement('textarea')
    host.append(input)
    input.focus()
    const e = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown }
    e.clipboardData = { files: [file(png(30), 'image/png')], getData: () => '' }
    act(() => void input.dispatchEvent(e))
    await settle()
    expect(e.defaultPrevented).toBe(false)
    expect(images()).toEqual([])
    const btn = q('button[data-tool="image"]')!
    expect(btn.getAttribute('aria-label')).toBe('이미지')
    const picker = q<HTMLInputElement>('input[data-image-picker]')!
    Object.defineProperty(picker, 'files', { value: [file(png(33), 'image/png', 'a.png'), file(new TextEncoder().encode('nope nope nope'), 'text/plain', 'b.txt')], configurable: true })
    act(() => void picker.dispatchEvent(new Event('change', { bubbles: true })))
    await settle()
    expect(images()).toEqual(['이미지, 저장 대기'])
  })
})
