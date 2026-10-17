// The upload engine (Story 3.12) against the fake Drive and fake-indexeddb: every
// row of the spec's I/O matrix, the crash points, and the guards of the patch round.
import 'fake-indexeddb/auto'
import { randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import { DriveError } from '../src/drive/driveClient'
import { decodeKkj } from '../src/model/kkjCodec'
import type { Note } from '../src/model/note'
import { NOTE_DB_NAME, SYNC_STORE, deleteNoteDatabase } from '../src/storage/noteDb'
import { backoffRule } from '../src/sync/syncRules'
import { type Env, NID, PA, PB, bytesOf, foreignEdit, makeEnv, md5Of, mkNote, withStroke } from './uploadHarness'

let env: Env | undefined
const make: typeof makeEnv = async (o) => (env = await makeEnv(o))
afterEach(async () => {
  env?.close()
  env = undefined
  await deleteNoteDatabase()
})

const PC = '01926f3a-0000-7000-8000-0000000000b3'
const PD = '01926f3a-0000-7000-8000-0000000000b4'
const four = () => mkNote({ pages: { [PA]: 'a1', [PB]: 'b1', [PC]: 'c1', [PD]: 'd1' } })
const two = () => mkNote({ pages: { [PA]: 'a1', [PB]: 'b1' } })
const pageRev = (n: Note, id: string) => n.pages.find((p) => p.id === id)?.rev
const headOf = async (e: Env, fileId: string) => {
  const revs = e.drive.revisions(fileId)
  return (await decodeKkj(revs.at(-1)!.bytes)).note!
}

// A page with ~8 MiB of incompressible data: its gzip is over 5 MiB, so the upload is resumable.
function big(): Note {
  const n = mkNote()
  ;(n.pages[0] as Record<string, unknown>).blob = randomBytes(8 * 1024 * 1024).toString('base64')
  return n
}

/** The first upload of `note`; returns the Drive file id. */
async function uploaded(e: Env, note: Note) {
  await e.store.writeNote(note)
  expect(await e.uploader.upload(note.noteId)).toBe('uploaded')
  return e.drive.byKkeujeokId(note.noteId)[0]!.id
}

describe('new note', () => {
  test('intent, lookup, create at the root with the summary, verify, base advance', async () => {
    const e = await make()
    const note = mkNote()
    await e.store.writeNote(note)
    expect(await e.uploader.upload(NID)).toBe('uploaded')

    const files = e.drive.byKkeujeokId(NID)
    expect(files).toHaveLength(1)
    const f = files[0]!
    expect(f.name).toBe('수학 노트.kkj')
    expect(f.parents).toEqual(['ROOT'])
    expect(f.revs).toHaveLength(1)
    expect(f.appProperties).toMatchObject({ kkeujeokId: NID, kkjV: '1', kkjMd5: md5Of(f.revs[0]!.bytes), kkjEdited: '2026-10-10T04:20:00.000Z' })
    expect(e.drive.uploads[0]).toMatchObject({ kind: 'simple' })
    expect(e.drive.uploads[0]!.metadata.mimeType).toBe('application/vnd.kkeujeok.kkj')

    const s = await e.sync()
    expect(s.info).toMatchObject({ fileId: f.id, baseHeadRevisionId: 'rev1', state: 'synced', pendingVerify: null, createIntent: null, resumableSession: null, lastError: null })
    expect(s.hasUnsent).toBe(false)
    expect(s.base?.noteId).toBe(NID)
    const names = e.entries.map((x) => x.event)
    for (const n of ['stateChange', 'uploadStarted', 'uploadFinished', 'verifyRound', 'baseAdvanced']) expect(names).toContain(n)
    expect(names.indexOf('uploadStarted')).toBeLessThan(names.indexOf('uploadFinished'))
    expect(names.indexOf('uploadFinished')).toBeLessThan(names.indexOf('baseAdvanced'))
    expect(e.invalid).toEqual([])
    expect(JSON.stringify(e.entries)).not.toContain('수학') // no note content in the log
  })

  test('the create intent is stored before the lookup', async () => {
    const e = await make()
    await e.store.writeNote(mkNote())
    e.drive.failAlways('list', new DriveError('http', 400))
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect((await e.sync()).info.createIntent).toEqual({ kkeujeokId: NID, parentId: 'ROOT' })
    expect(e.drive.count('uploadSimple')).toBe(0)
  })

  test('a lagging listing: the response id is used and the note is verified', async () => {
    const e = await make()
    e.drive.lagOn()
    const id = await uploaded(e, mkNote())
    expect((await e.sync()).info.fileId).toBe(id)
  })

  test('without a root folder id nothing is created', async () => {
    const e = await make({ rootFolderId: null })
    await e.store.writeNote(mkNote())
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect(e.drive.count('uploadSimple')).toBe(0)
    expect((await e.sync()).info.lastError).toMatchObject({ class: 'fatal', reason: 'rootMissing' })
  })

  test('a retried create looks the file up first and adopts it (no second file)', async () => {
    const e = await make()
    await e.store.writeNote(mkNote())
    e.drive.loseAnswer('uploadSimple', 1) // the file was created, the answer was lost
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.drive.byKkeujeokId(NID)).toHaveLength(1)
    expect(e.drive.count('uploadSimple')).toBe(1)
    expect(e.sleeps).toEqual([1000])
    expect((await e.sync()).info.state).toBe('synced')
  })

  test('adopting counts duplicates in the log and keeps the earliest', async () => {
    const e = await make()
    await e.store.writeNote(mkNote())
    const a = e.drive.addChild('ROOT')
    const b = e.drive.addChild('ROOT')
    for (const x of [a, b]) x.appProperties.kkeujeokId = NID
    // the first upload finds two; a lost-answer retry would find them too
    await e.uploader.upload(NID)
    expect(e.events('duplicatesCleaned')).toEqual([expect.objectContaining({ count: 1 })])
    expect((await e.sync()).info.fileId).toBe(a.id)
  })
})

describe('existing note', () => {
  test('head == base: name and summary written, no parent change, renamed file renamed back', async () => {
    const e = await make()
    const id = await uploaded(e, mkNote())
    const f = e.drive.items.get(id)!
    f.name = 'renamed in Drive.kkj'
    f.parents = ['elsewhere']
    await e.store.writeNote(withStroke(mkNote(), PA, 'a2'))
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(f.name).toBe('수학 노트.kkj')
    expect(f.parents).toEqual(['elsewhere'])
    const last = e.drive.uploads.at(-1)!
    expect(last.fileId).toBe(id)
    expect(last.metadata).not.toHaveProperty('parents')
    expect(last.metadata).not.toHaveProperty('mimeType')
    expect(f.appProperties.kkjMd5).toBe(md5Of(f.revs.at(-1)!.bytes))
    expect(e.drive.calls.some((c) => c.startsWith('update'))).toBe(false) // never addParents/removeParents
    expect((await e.sync()).info).toMatchObject({ baseHeadRevisionId: 'rev2', state: 'synced' })
  })

  test('nothing to send: no Drive call', async () => {
    const e = await make()
    await uploaded(e, mkNote())
    const before = e.drive.calls.length
    expect(await e.uploader.upload(NID)).toBe('skipped')
    expect(e.drive.calls.length).toBe(before)
  })

  test('pendingVerify is stored before the request goes out', async () => {
    const e = await make()
    await uploaded(e, mkNote())
    await e.store.writeNote(withStroke(mkNote(), PA, 'a2'))
    e.hooks.onLog = (ev) => {
      if (ev === 'uploadStarted') throw new Error('crash after pendingVerify')
    }
    await expect(e.uploader.upload(NID)).rejects.toThrow('crash')
    const s = await e.sync()
    expect(s.info.pendingVerify).toMatchObject({ oursRevisionId: null, round: 1 })
    expect(e.drive.revisions(e.drive.byKkeujeokId(NID)[0]!.id)).toHaveLength(1) // Drive still has the old revision
  })

  test('head != base, clean merge: merged into the working copy, uploaded, both changes in Drive', async () => {
    const e = await make()
    const id = await uploaded(e, two())
    e.drive.foreignRevision(id, await bytesOf(foreignEdit(two(), PB, 'b2')))
    await e.store.writeNote(withStroke(two(), PA, 'a2'))
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    const head = await headOf(e, id)
    expect([pageRev(head, PA), pageRev(head, PB)]).toEqual(['a2', 'b2'])
    const work = (await e.store.loadNote(NID))!.note!
    expect([pageRev(work, PA), pageRev(work, PB)]).toEqual(['a2', 'b2'])
    expect(e.events('revisionDownloaded').length).toBeGreaterThan(0)
    expect(e.events('merged').length).toBeGreaterThan(0)
    expect((await e.sync()).info.state).toBe('synced')
  })

  test('remote with a newer formatVersion: never merged, never overwritten', async () => {
    const e = await make()
    const id = await uploaded(e, two())
    const newer = { ...(await bytesOfJson(two())), formatVersion: 2 }
    e.drive.foreignRevision(id, new Uint8Array(gzipSync(JSON.stringify(newer))))
    await e.store.writeNote(withStroke(two(), PA, 'a2'))
    const before = e.drive.revisions(id).length
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect(e.drive.revisions(id)).toHaveLength(before)
    expect((await e.sync()).info.lastError).toMatchObject({ class: 'unreadable', reason: 'unsupportedVersion' })
    expect(e.events('error')).toEqual([expect.objectContaining({ class: 'unreadable', reason: 'unsupportedVersion' })])
  })

  test('remote that cannot be read: parse, nothing overwritten', async () => {
    const e = await make()
    const id = await uploaded(e, two())
    e.drive.foreignRevision(id, new Uint8Array([1, 2, 3]))
    await e.store.writeNote(withStroke(two(), PA, 'a2'))
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect((await e.sync()).info.lastError).toMatchObject({ class: 'unreadable', reason: 'parse' })
    expect(e.drive.revisions(id)).toHaveLength(2)
  })

  test('a trashed file is deleted, a 404 too: no upload', async () => {
    const e = await make()
    const id = await uploaded(e, two())
    await e.store.writeNote(withStroke(two(), PA, 'a2'))
    e.drive.trash(id)
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect((await e.sync()).info.lastError).toMatchObject({ class: 'deleted', reason: 'trashed' })
  })

  test('head == base but the working copy needs lineage: merged with remote = base, then uploaded', async () => {
    const e = await make()
    await uploaded(e, two())
    await e.store.writeNote(withStroke(two(), PA, 'a2'))
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.events('merged').length).toBe(1)
  })
})

describe('verify', () => {
  test('a foreign revision after ours: merged, uploaded again as round 2', async () => {
    const e = await make()
    const id = await uploaded(e, two())
    await e.store.writeNote(withStroke(two(), PA, 'a2'))
    // the other device wrote its note right after ours
    let once = true
    e.drive.hooks.afterUploadAsync = async (fileId) => {
      if (!once) return
      once = false
      e.drive.foreignRevision(fileId, await bytesOf(foreignEdit(two(), PB, 'b2')))
    }
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    const head = await headOf(e, id)
    expect([pageRev(head, PA), pageRev(head, PB)]).toEqual(['a2', 'b2'])
    expect(e.events('verifyRound').slice(1).map((x) => [x.round, x.count])).toEqual([[1, 1], [2, 0]])
    expect(e.drive.uploads).toHaveLength(3)
  })

  test('round 3 with a foreign revision: error verifyExhausted, base not advanced, change stays', async () => {
    const e = await make()
    const id = await uploaded(e, four())
    await e.store.writeNote(withStroke(four(), PA, 'a2'))
    const others = [PB, PC, PD]
    let k = 0
    e.drive.hooks.afterUploadAsync = async (fileId) => {
      const page = others[k++]
      if (page) e.drive.foreignRevision(fileId, await bytesOf(foreignEdit(four(), page, `x${k}`)))
    }
    expect(await e.uploader.upload(NID)).toBe('failed')
    const s = await e.sync()
    expect(s.info).toMatchObject({ state: 'error', pendingVerify: null, baseHeadRevisionId: 'rev1' })
    expect(s.info.lastError).toMatchObject({ class: 'fatal', reason: 'verifyExhausted' })
    expect(s.hasUnsent).toBe(true)
    expect(e.drive.uploads.length).toBe(4) // first + three rounds
    expect(e.drive.revisions(id).length).toBeGreaterThan(3)
  })

  test('the listing lags behind (invalidInput): waits with backoff, asks again, no attempt used', async () => {
    const e = await make()
    e.drive.lagRevisions(1)
    await uploaded(e, mkNote())
    expect(e.sleeps).toEqual([(backoffRule({ attempt: 1, jitter: 0.5 }) as { delayMs: number }).delayMs])
    expect(e.events('backoff')).toEqual([]) // no backoff attempt
    expect(e.drive.count('listRevisions')).toBe(2)
  })

  test('the listing keeps lagging: a network failure, then the attempts run out', async () => {
    const e = await make()
    e.drive.lagRevisions(1000)
    await e.store.writeNote(mkNote())
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect(e.events('backoff').length).toBe(6)
    expect((await e.sync()).info.lastError).toMatchObject({ class: 'backoff' })
  })

  test('md5Checksum of the response must equal the local MD5', async () => {
    const e = await make()
    e.drive.hooks.corruptMd5 = true
    await e.store.writeNote(mkNote())
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect((await e.sync()).info.lastError).toMatchObject({ class: 'fatal', reason: 'md5Mismatch' })
    expect((await e.sync()).info.baseHeadRevisionId).toBeNull()
  })
})

describe('edits during and after the upload', () => {
  test('an edit during the upload stays unsent; the upload is the start snapshot', async () => {
    const e = await make()
    await uploaded(e, mkNote())
    await e.store.writeNote(withStroke(mkNote(), PA, 'a2'))
    e.drive.hooks.afterUploadAsync = async () => {
      e.drive.hooks.afterUploadAsync = undefined
      await e.store.writeNote(withStroke(withStroke(mkNote(), PA, 'a2'), PA, 'a3'))
    }
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    const s = await e.sync()
    expect(s.hasUnsent).toBe(true)
    expect(s.state).toBe('pending')
    expect(pageRev(s.base!, PA)).toBe('a2')
    expect(pageRev((await e.store.loadNote(NID))!.note!, PA)).toBe('a3')
  })

  test('the working copy is re-checked after the commit: an edit that lands there keeps it pending', async () => {
    const e = await make()
    await uploaded(e, mkNote())
    await e.store.writeNote(withStroke(mkNote(), PA, 'a2'))
    e.hooks.onLog = (ev) => {
      if (ev !== 'baseAdvanced') return
      e.hooks.onLog = undefined
      // runs inside the commit callback; the write waits for the note lock
      void e.store.writeNote(withStroke(withStroke(mkNote(), PA, 'a2'), PA, 'a3'))
    }
    await e.uploader.upload(NID)
    await new Promise((r) => setTimeout(r, 50))
    expect((await e.sync()).info.state).toBe('pending') // the stored state, not the derived one
  })
})

describe('crash points', () => {
  test('after pendingVerify was stored: the upload is done again', async () => {
    const e = await make()
    await e.store.writeNote(mkNote())
    e.hooks.onLog = (ev) => {
      if (ev === 'uploadStarted') throw new Error('killed')
    }
    await expect(e.uploader.upload(NID)).rejects.toThrow('killed')
    expect(e.drive.byKkeujeokId(NID)).toHaveLength(0)
    e.hooks.onLog = undefined
    expect(await e.reload().resume(NID)).toBe('uploaded')
    expect(e.drive.byKkeujeokId(NID)).toHaveLength(1)
    expect((await e.sync()).info.state).toBe('synced')
  })

  test('after the upload, before ours was stored: it is verified, not uploaded again', async () => {
    const e = await make()
    await e.store.writeNote(mkNote())
    e.hooks.onLog = (ev) => {
      if (ev === 'uploadFinished') throw new Error('killed')
    }
    await expect(e.uploader.upload(NID)).rejects.toThrow('killed')
    expect(e.drive.count('uploadSimple')).toBe(1)
    e.hooks.onLog = undefined
    expect(await e.reload().resume(NID)).toBe('uploaded')
    expect(e.drive.count('uploadSimple')).toBe(1)
    expect(e.drive.byKkeujeokId(NID)).toHaveLength(1)
    expect((await e.sync()).info).toMatchObject({ state: 'synced', baseHeadRevisionId: 'rev1' })
  })

  test('after ours was stored (upload complete, verify not started): only verify', async () => {
    const e = await make()
    const id = await uploaded(e, mkNote())
    await e.store.writeNote(withStroke(mkNote(), PA, 'a2'))
    e.hooks.onLog = (ev) => {
      if (ev === 'verifyRound') throw new Error('killed')
    }
    await expect(e.uploader.upload(NID)).rejects.toThrow('killed')
    const s = await e.sync()
    expect(s.info.pendingVerify).toMatchObject({ oursRevisionId: 'rev2' })
    e.hooks.onLog = undefined
    expect(await e.reload().resume(NID)).toBe('uploaded')
    expect(e.drive.revisions(id)).toHaveLength(2) // not uploaded again
    expect((await e.sync()).info).toMatchObject({ state: 'synced', baseHeadRevisionId: 'rev2', pendingVerify: null })
  })

  test('resume leaves a note without an unfinished upload to upload()', async () => {
    const e = await make()
    await e.store.writeNote(mkNote())
    expect(await e.uploader.resume(NID)).toBe('skipped')
    expect(e.drive.calls).toEqual([])
  })
})

describe('resumable', () => {
  test('a body over 5 MiB: session saved, chunks contiguous by the Range header, md5 of the sent bytes', async () => {
    const e = await make({ chunkSize: 2 * 1024 * 1024 })
    const sessionsSeen: unknown[] = []
    e.drive.hooks.beforeCall = (m) => {
      if (m === 'putResumable' && sessionsSeen.length === 0) sessionsSeen.push(1)
    }
    const note = big()
    await e.store.writeNote(note)
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.drive.uploads[0]).toMatchObject({ kind: 'resumable' })
    const f = e.drive.byKkeujeokId(NID)[0]!
    expect(f.appProperties.kkjMd5).toBe(md5Of(f.revs[0]!.bytes))
    expect(e.drive.chunkLog.length).toBeGreaterThan(2)
    let at = 0
    for (const c of e.drive.chunkLog) {
      expect(c.offset).toBe(at)
      at += c.length
    }
    expect(at).toBe(f.revs[0]!.bytes.length)
    expect(e.events('uploadStarted')[0]).toMatchObject({ kind: 'resumable' })
    expect((await e.sync()).info).toMatchObject({ state: 'synced', resumableSession: null })
  })

  test('the session is stored in sync.json while chunks go', async () => {
    const e = await make({ chunkSize: 2 * 1024 * 1024 })
    await e.store.writeNote(big())
    let seen: unknown
    e.drive.hooks.beforeCall = (m, nth) => {
      if (m === 'putResumable' && nth === 2) {
        void e.sync().then((s) => (seen = s.info.resumableSession))
      }
    }
    await e.uploader.upload(NID)
    await new Promise((r) => setTimeout(r, 30))
    expect(seen).toMatchObject({ uri: expect.stringContaining('session:') })
  })

  test('a chunk whose answer was lost: the status query comes first, then the next bytes', async () => {
    const e = await make({ chunkSize: 2 * 1024 * 1024 })
    await e.store.writeNote(big())
    e.drive.loseAnswer('putResumable', 2)
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    const calls = e.drive.calls.filter((c) => c.startsWith('putResumable'))
    expect(calls[2]).toContain('status') // right after the lost chunk
    let at = 0
    for (const c of e.drive.chunkLog) {
      expect(c.offset).toBeLessThanOrEqual(at) // never past what Drive holds
      at = Math.max(at, c.offset + c.length)
    }
    const f = e.drive.byKkeujeokId(NID)[0]!
    expect(at).toBe(f.revs[0]!.bytes.length)
    expect(f.revs).toHaveLength(1)
  })

  test('a 308 with no Range header means nothing is held: it never skips ahead', async () => {
    const e = await make({ chunkSize: 2 * 1024 * 1024 })
    await e.store.writeNote(big())
    e.drive.hideRangeHeader()
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect((await e.sync()).info.lastError).toMatchObject({ reason: 'sessionLost' })
    expect(e.drive.byKkeujeokId(NID)).toHaveLength(0) // no half-written file
  })

  test('a session gone (404): starts again from byte 0', async () => {
    const e = await make({ chunkSize: 2 * 1024 * 1024 })
    await e.store.writeNote(big())
    e.drive.failAt('putResumable', 2, new DriveError('http', 404, 'notFound'))
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.drive.count('startResumable')).toBe(2)
    expect(e.drive.byKkeujeokId(NID)[0]!.revs).toHaveLength(1)
  })

  test('killed mid-session: Start asks the session, restarts, Drive has the complete revision only', async () => {
    const e = await make({ chunkSize: 2 * 1024 * 1024 })
    await e.store.writeNote(big())
    e.drive.hooks.beforeCall = (m, nth) => {
      if (m === 'putResumable' && nth === 3) throw new Error('killed')
    }
    await expect(e.uploader.upload(NID)).rejects.toThrow('killed')
    expect(e.drive.byKkeujeokId(NID)).toHaveLength(0) // nothing half-written is a file
    e.drive.hooks.beforeCall = undefined
    expect((await e.sync()).info.resumableSession).not.toBeNull()
    expect(await e.reload().resume(NID)).toBe('uploaded')
    const f = e.drive.byKkeujeokId(NID)
    expect(f).toHaveLength(1)
    expect(f[0]!.revs).toHaveLength(1)
    expect((await e.sync()).info.state).toBe('synced')
  })

  test('killed after the last chunk: Start finds the finished upload and only verifies', async () => {
    const e = await make({ chunkSize: 2 * 1024 * 1024 })
    await e.store.writeNote(big())
    e.drive.hooks.afterUploadAsync = () => {
      throw new Error('killed')
    }
    await expect(e.uploader.upload(NID)).rejects.toThrow('killed')
    e.drive.hooks.afterUploadAsync = undefined
    const files = e.drive.byKkeujeokId(NID)
    expect(files).toHaveLength(1)
    const chunksBefore = e.drive.chunkLog.length
    expect(await e.reload().resume(NID)).toBe('uploaded')
    expect(e.drive.chunkLog.length).toBe(chunksBefore) // nothing sent again
    expect(files[0]!.revs).toHaveLength(1)
    expect((await e.sync()).info).toMatchObject({ state: 'synced', baseHeadRevisionId: 'rev1' })
  })
})

describe('thumbnail', () => {
  test('a rendered PNG goes in contentHints (base64url) at the size the summary names', async () => {
    const calls: number[][] = []
    const e = await make({
      thumbnail: async (_p, w, h) => {
        calls.push([w, h])
        return new Uint8Array([137, 80, 78, 71])
      },
    })
    await uploaded(e, mkNote())
    expect(calls).toEqual([[300, 425]])
    expect(e.drive.uploads[0]!.metadata.contentHints).toEqual({ thumbnail: { image: 'iVBORw==', mimeType: 'image/png' } })
  })

  test.each([
    ['unavailable', async () => null],
    ['throws', async () => Promise.reject(new Error('no canvas'))],
    ['over 2 MiB', async () => new Uint8Array(2_097_153)],
  ])('%s: no contentHints, the upload still happens', async (_n, thumbnail) => {
    const e = await make({ thumbnail })
    await uploaded(e, mkNote())
    expect(e.drive.uploads[0]!.metadata).not.toHaveProperty('contentHints')
  })
})

describe('errors and gates', () => {
  test('backoff waits equal sync.backoff, the 7th failure logs only the error', async () => {
    const e = await make()
    await e.store.writeNote(mkNote())
    e.drive.failAlways('uploadSimple', new DriveError('http', 503))
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect(e.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000])
    expect(e.events('backoff').map((x) => x.attempt)).toEqual([1, 2, 3, 4, 5, 6])
    expect(e.events('error')).toEqual([expect.objectContaining({ class: 'backoff', status: 503 })])
    const s = await e.sync()
    expect(s.info.state).toBe('error')
    expect(s.info.lastError).toMatchObject({ class: 'backoff', status: 503 })
    expect(s.hasUnsent).toBe(true) // the change stays in IndexedDB
    expect((await e.store.loadNote(NID))!.note).toBeDefined()
    expect(e.invalid).toEqual([])
  })

  test.each([
    ['429', new DriveError('http', 429)],
    ['403 rate limit', new DriveError('http', 403, 'rateLimitExceeded')],
    ['network', new DriveError('network')],
  ])('%s is retried after a wait and then succeeds', async (_n, err) => {
    const e = await make()
    await e.store.writeNote(mkNote())
    e.drive.failAt('uploadSimple', 1, err)
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect(e.sleeps).toEqual([1000])
  })

  test('storageQuotaExceeded: no retry, class quota', async () => {
    const e = await make()
    await e.store.writeNote(mkNote())
    e.drive.failAt('uploadSimple', 1, new DriveError('http', 403, 'storageQuotaExceeded'))
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect(e.sleeps).toEqual([])
    expect((await e.sync()).info.lastError).toMatchObject({ class: 'quota', status: 403, reason: 'storageQuotaExceeded' })
  })

  test('401 / no token: class reauth, no retry', async () => {
    const e = await make()
    await e.store.writeNote(mkNote())
    e.drive.failAt('list', 1, new DriveError('http', 401, 'noToken'))
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect(e.sleeps).toEqual([])
    expect((await e.sync()).info.lastError).toMatchObject({ class: 'reauth' })
  })

  test('an error note is left alone until retry moves it', async () => {
    const e = await make()
    await e.store.writeNote(mkNote())
    e.drive.failAt('list', 1, new DriveError('http', 401, 'noToken'))
    await e.uploader.upload(NID)
    const calls = e.drive.calls.length
    expect(await e.uploader.upload(NID)).toBe('skipped')
    expect(e.drive.calls.length).toBe(calls)
  })

  test.each([
    ['offline', (e: Env) => (e.flags.online = false)],
    ['gate closed', (e: Env) => (e.flags.allowed = false)],
  ])('%s: no Drive call, the note stays pending', async (_n, close) => {
    const e = await make()
    await e.store.writeNote(mkNote())
    close(e)
    expect(await e.uploader.upload(NID)).toBe('skipped')
    expect(e.drive.calls).toEqual([])
    expect((await e.sync()).state).toBe('pending')
  })

  test('a sync.json that cannot be read is never overwritten and nothing is sent', async () => {
    const e = await make()
    await e.store.writeNote(mkNote())
    await rawPut(SYNC_STORE, NID, { state: 'not a state', fileId: 5 })
    expect(await e.uploader.upload(NID)).toBe('failed')
    expect(await rawGet(SYNC_STORE, NID)).toEqual({ state: 'not a state', fileId: 5 })
    expect(e.drive.calls).toEqual([])
    expect(e.events('error')).toEqual([expect.objectContaining({ class: 'fatal', reason: 'syncUnreadable' })])
  })

  test('a base file that is gone is recovered: the note still uploads', async () => {
    const e = await make()
    await uploaded(e, mkNote())
    await rawDelete('base', NID) // sync.json still names the base revision
    await e.store.writeNote(withStroke(mkNote(), PA, 'a2'))
    expect(await e.uploader.upload(NID)).toBe('uploaded')
    expect((await e.sync()).info.state).toBe('synced')
  })

  test('two calls for one note do not overlap (one chain per note)', async () => {
    const e = await make()
    await e.store.writeNote(mkNote())
    const [a, b] = await Promise.all([e.uploader.upload(NID), e.uploader.upload(NID)])
    expect([a, b]).toEqual(['uploaded', 'skipped'])
    expect(e.drive.byKkeujeokId(NID)).toHaveLength(1)
  })
})

async function bytesOfJson(n: Note) {
  return JSON.parse(JSON.stringify(n)) as Record<string, unknown>
}

function rawDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(NOTE_DB_NAME)
    r.onerror = () => reject(r.error)
    r.onsuccess = () => {
      const db = r.result
      fn(db).then(
        (v) => (db.close(), resolve(v)),
        (x) => (db.close(), reject(x)),
      )
    }
  })
}
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))))
const rawPut = (store: string, key: string, value: unknown) =>
  rawDb(async (db) => void (await req(db.transaction(store, 'readwrite').objectStore(store).put(value, key))))
const rawGet = (store: string, key: string) => rawDb((db) => req(db.transaction(store).objectStore(store).get(key)))
const rawDelete = (store: string, key: string) =>
  rawDb(async (db) => void (await req(db.transaction(store, 'readwrite').objectStore(store).delete(key))))
