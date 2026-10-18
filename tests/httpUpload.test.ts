// The upload, resumable, revisions and media calls of the HTTP Drive client.
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { DriveError, createHttpDriveClient, pickBoundary } from '../src/drive/driveClient'

type Req = { url: URL; init: RequestInit }
function client(answer: (r: Req) => Response | Promise<Response>, o: { randomBytes?: () => Uint8Array } = {}) {
  const seen: Req[] = []
  const fetchStub = (async (url: URL | string, init: RequestInit) => {
    const r = { url: new URL(url), init }
    seen.push(r)
    return answer(r)
  }) as unknown as typeof fetch
  return {
    seen,
    c: createHttpDriveClient({
      fetch: fetchStub,
      token: () => 'tok',
      baseUrl: 'https://drive.test/v3',
      uploadBaseUrl: 'https://drive.test/upload/v3',
      ...o,
    }),
  }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const rejection = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as DriveError)
const text = (b: unknown) => new TextDecoder('latin1').decode(b as Uint8Array)
const hdr = (r: Req, k: string) => (r.init.headers as Record<string, string>)[k]!

describe('uploadSimple', () => {
  test('creates with a multipart body: metadata part, content part, random boundary', async () => {
    const { c, seen } = client(() => json({ id: 'f1', headRevisionId: 'r1', md5Checksum: 'abc' }))
    const bytes = new Uint8Array([0, 1, 2, 255, 254])
    const f = await c.uploadSimple({ metadata: { name: 'a.kkj', parents: ['ROOT'] }, bytes })
    expect(f).toMatchObject({ id: 'f1', headRevisionId: 'r1', md5Checksum: 'abc' })
    const r = seen[0]!
    expect(r.init.method).toBe('POST')
    expect(r.url.pathname).toBe('/upload/v3/files')
    expect(r.url.searchParams.get('uploadType')).toBe('multipart')
    expect(r.url.searchParams.get('fields')).toBe('id,headRevisionId,md5Checksum')
    expect(hdr(r, 'Authorization')).toBe('Bearer tok')
    const boundary = /boundary=(.+)$/.exec(hdr(r, 'Content-Type'))![1]!
    const body = r.init.body as Uint8Array
    const s = text(body)
    expect(s.startsWith(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.kkj","parents":["ROOT"]}\r\n--${boundary}\r\n`)).toBe(true)
    expect(s.endsWith(`\r\n--${boundary}--`)).toBe(true)
    // the content bytes sit between the headers and the closing boundary, unchanged
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.kkj","parents":["ROOT"]}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
    expect([...body.subarray(head.length, head.length + bytes.length)]).toEqual([...bytes])
  })

  test('a different boundary every time', async () => {
    const { c, seen } = client(() => json({ id: 'f' }))
    await c.uploadSimple({ metadata: {}, bytes: new Uint8Array(1) })
    await c.uploadSimple({ metadata: {}, bytes: new Uint8Array(1) })
    const b = seen.map((r) => /boundary=(.+)$/.exec(hdr(r, 'Content-Type'))![1])
    expect(b[0]).not.toBe(b[1])
    expect(b[0]).toMatch(/^kkj-[0-9a-f]{24}$/)
  })

  test('a boundary that occurs in the body or the metadata is not used', () => {
    const clash = new TextEncoder().encode('xx kkj-aaaaaaaaaaaaaaaaaaaaaaaa yy')
    const draws = [new Uint8Array(12).fill(0xaa), new Uint8Array(12).fill(0xaa), new Uint8Array(12).fill(0xbb)]
    expect(pickBoundary('{}', clash, () => draws.shift()!)).toBe('kkj-bbbbbbbbbbbbbbbbbbbbbbbb')
    const draws2 = [new Uint8Array(12).fill(0xaa), new Uint8Array(12).fill(0xcc)]
    expect(pickBoundary('{"name":"kkj-aaaaaaaaaaaaaaaaaaaaaaaa"}', new Uint8Array(0), () => draws2.shift()!)).toBe('kkj-cccccccccccccccccccccccc')
  })

  test('an update patches the file id and never carries parents or addParents', async () => {
    const { c, seen } = client(() => json({ id: 'f1', headRevisionId: 'r2' }))
    await c.uploadSimple({ fileId: 'f 1', metadata: { name: 'a.kkj' }, bytes: new Uint8Array(0) })
    expect(seen[0]!.init.method).toBe('PATCH')
    expect(seen[0]!.url.pathname).toBe('/upload/v3/files/f%201')
    expect(seen[0]!.url.searchParams.has('addParents')).toBe(false)
    expect(text(seen[0]!.init.body)).not.toContain('parents')
  })

  test('a 403 is a DriveError with the Drive reason', async () => {
    const { c } = client(() => json({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } }, 403))
    expect(await rejection(c.uploadSimple({ metadata: {}, bytes: new Uint8Array(0) }))).toMatchObject({ kind: 'http', status: 403, reason: 'storageQuotaExceeded' })
  })

  test('a network failure is kind network; no token is 401 noToken', async () => {
    const { c } = client(() => Promise.reject(new TypeError('offline')))
    expect(await rejection(c.uploadSimple({ metadata: {}, bytes: new Uint8Array(0) }))).toMatchObject({ kind: 'network' })
    const c2 = createHttpDriveClient({ fetch: (() => Promise.reject(new Error('never'))) as unknown as typeof fetch, token: () => null })
    expect(await rejection(c2.uploadSimple({ metadata: {}, bytes: new Uint8Array(0) }))).toMatchObject({ kind: 'http', status: 401, reason: 'noToken' })
  })

  test('an answer that is not JSON is parse', async () => {
    const { c } = client(() => new Response('<html>', { status: 200 }))
    expect(await rejection(c.uploadSimple({ metadata: {}, bytes: new Uint8Array(0) }))).toMatchObject({ kind: 'parse' })
  })
})

describe('resumable', () => {
  test('startResumable posts the metadata with the upload size and returns the Location', async () => {
    const { c, seen } = client(() => new Response('', { status: 200, headers: { location: 'https://drive.test/session/1' } }))
    const uri = await c.startResumable({ metadata: { name: 'a' }, size: 123 })
    expect(uri).toBe('https://drive.test/session/1')
    const r = seen[0]!
    expect(r.url.searchParams.get('uploadType')).toBe('resumable')
    expect(hdr(r, 'X-Upload-Content-Length')).toBe('123')
    expect(r.init.body).toBe('{"name":"a"}')
  })

  test('startResumable without a Location is parse', async () => {
    const { c } = client(() => new Response('', { status: 200 }))
    expect(await rejection(c.startResumable({ metadata: {}, size: 1 }))).toMatchObject({ kind: 'parse' })
  })

  test('a chunk carries its Content-Range; a 308 with Range gives the held bytes + 1', async () => {
    const { c, seen } = client(() => new Response('', { status: 308, headers: { range: 'bytes=0-262143' } }))
    expect(await c.putResumable('https://drive.test/s', 1_000_000, 0, new Uint8Array(262_144))).toEqual({ received: 262_144 })
    expect(hdr(seen[0]!, 'Content-Range')).toBe('bytes 0-262143/1000000')
    expect(seen[0]!.init.method).toBe('PUT')
  })

  test('a 308 without a Range header holds nothing', async () => {
    const { c } = client(() => new Response('', { status: 308 }))
    expect(await c.putResumable('https://drive.test/s', 10, 0, new Uint8Array(5))).toEqual({ received: 0 })
  })

  test('the status query sends bytes */size and an empty body', async () => {
    const { c, seen } = client(() => new Response('', { status: 308, headers: { range: 'bytes=0-9' } }))
    expect(await c.putResumable('https://drive.test/s', 100, 0, null)).toEqual({ received: 10 })
    expect(hdr(seen[0]!, 'Content-Range')).toBe('bytes */100')
    expect((seen[0]!.init.body as Uint8Array).length).toBe(0)
  })

  test('200 or 201 is the finished file', async () => {
    for (const status of [200, 201]) {
      const { c } = client(() => json({ id: 'f', headRevisionId: 'r1' }, status))
      expect(await c.putResumable('https://drive.test/s', 5, 0, new Uint8Array(5))).toMatchObject({ file: { id: 'f', headRevisionId: 'r1' } })
    }
  })

  test('404 and 410 are DriveErrors of a gone session', async () => {
    for (const status of [404, 410]) {
      const { c } = client(() => json({}, status))
      expect(await rejection(c.putResumable('https://drive.test/s', 5, 0, null))).toMatchObject({ kind: 'http', status })
    }
  })
})

describe('revisions', () => {
  test('listRevisions follows every page with pageSize 1000', async () => {
    const { c, seen } = client((r) =>
      r.url.searchParams.get('pageToken') === 'p2'
        ? json({ revisions: [{ id: 'r3', modifiedTime: 't3' }] })
        : json({ revisions: [{ id: 'r1', modifiedTime: 't1', keepForever: true }, { id: 'r2', modifiedTime: 't2' }], nextPageToken: 'p2' }),
    )
    expect(await c.listRevisions('f1')).toEqual([
      { id: 'r1', modifiedTime: 't1', keepForever: true },
      { id: 'r2', modifiedTime: 't2', keepForever: false },
      { id: 'r3', modifiedTime: 't3', keepForever: false },
    ])
    expect(seen[0]!.url.pathname).toBe('/v3/files/f1/revisions')
    expect(seen[0]!.url.searchParams.get('pageSize')).toBe('1000')
    expect(seen[0]!.url.searchParams.get('fields')).toBe('nextPageToken,revisions(id,modifiedTime,keepForever)')
  })

  test('a revision without an id is parse', async () => {
    const { c } = client(() => json({ revisions: [{ modifiedTime: 't' }] }))
    expect(await rejection(c.listRevisions('f1'))).toMatchObject({ kind: 'parse' })
  })

  test('updateRevision PATCHes keepForever on the revision (Story 3.25)', async () => {
    const { c, seen } = client(() => json({ id: 'r 1', modifiedTime: 't1', keepForever: true }))
    expect(await c.updateRevision('f1', 'r 1', { keepForever: true })).toEqual({ id: 'r 1', modifiedTime: 't1', keepForever: true })
    expect(seen[0]!.init.method).toBe('PATCH')
    expect(seen[0]!.url.pathname).toBe('/v3/files/f1/revisions/r%201')
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ keepForever: true })
  })

  test('updateRevision of a purged revision is a 404 DriveError', async () => {
    const { c } = client(() => json({ error: { errors: [{ reason: 'notFound' }] } }, 404))
    expect(await rejection(c.updateRevision('f1', 'r1', { keepForever: false }))).toMatchObject({ kind: 'http', status: 404 })
  })

  test('downloadFile reads alt=media bytes of a file (a sidecar)', async () => {
    const { c, seen } = client(() => new Response(new Uint8Array([1, 2])))
    expect([...(await c.downloadFile('f 1'))]).toEqual([1, 2])
    expect(seen[0]!.url.pathname).toBe('/v3/files/f%201')
    expect(seen[0]!.url.searchParams.get('alt')).toBe('media')
  })

  test('downloadRevision reads alt=media bytes', async () => {
    const { c, seen } = client(() => new Response(new Uint8Array([9, 8, 7])))
    expect([...(await c.downloadRevision('f1', 'r 1'))]).toEqual([9, 8, 7])
    expect(seen[0]!.url.pathname).toBe('/v3/files/f1/revisions/r%201')
    expect(seen[0]!.url.searchParams.get('alt')).toBe('media')
  })

  test('get returns headRevisionId, md5Checksum and modifiedTime', async () => {
    const { c } = client(() => json({ id: 'f1', headRevisionId: 'r9', md5Checksum: createHash('md5').update('x').digest('hex'), modifiedTime: '2026-10-10T04:20:00.000Z' }))
    expect(await c.get('f1', { fields: 'headRevisionId' })).toMatchObject({ headRevisionId: 'r9', modifiedTime: '2026-10-10T04:20:00.000Z' })
  })
})
