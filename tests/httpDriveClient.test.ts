import { describe, expect, test } from 'vitest'
import {
  DriveError,
  childrenQuery,
  createHttpDriveClient,
  escapeQ,
  kkeujeokIdQuery,
} from '../src/drive/driveClient'
import { classifyDriveError } from '../src/sync/errorClass'

type Req = { url: URL; init: RequestInit }
function client(answer: (r: Req) => Response | Promise<Response>, token: () => string | null | Promise<string | null> = () => 'tok') {
  const seen: Req[] = []
  const fetchStub = (async (url: URL, init: RequestInit) => {
    const r = { url, init }
    seen.push(r)
    return answer(r)
  }) as unknown as typeof fetch
  return { seen, c: createHttpDriveClient({ fetch: fetchStub, token, baseUrl: 'https://drive.test/v3' }) }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const rejection = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as DriveError)

describe('q strings', () => {
  test('escape the backslash first, then the quote', () => {
    expect(escapeQ("a\\b'c")).toBe("a\\\\b\\'c")
    expect(kkeujeokIdQuery("x'y")).toBe("appProperties has { key='kkeujeokId' and value='x\\'y' } and trashed=false")
    expect(childrenQuery('f\\1')).toBe("'f\\\\1' in parents and trashed=false")
  })
})

describe('requests', () => {
  test('list sends the token, q, page size and page token; reads files and the next page', async () => {
    const { c, seen } = client(() =>
      json({ files: [{ id: 'a', name: 'Kkeujeok', parents: ['root'], appProperties: { kkeujeokId: 'root', n: 5 }, createdTime: 't' }], nextPageToken: 'p2' }),
    )
    const page = await c.list(kkeujeokIdQuery('root'), { pageToken: 'p1' })
    expect(page).toEqual({
      files: [{ id: 'a', name: 'Kkeujeok', parents: ['root'], appProperties: { kkeujeokId: 'root' }, createdTime: 't', trashed: false }],
      nextPageToken: 'p2',
    })
    const { url, init } = seen[0]!
    expect(url.pathname).toBe('/v3/files')
    expect(url.searchParams.get('q')).toBe(kkeujeokIdQuery('root'))
    expect(url.searchParams.get('pageToken')).toBe('p1')
    expect(url.searchParams.get('pageSize')).toBe('100')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  test('create posts metadata only; update patches parents and trashed', async () => {
    const { c, seen } = client(() => json({ id: 'n1' }))
    expect((await c.create({ name: 'Kkeujeok' })).id).toBe('n1')
    expect(seen[0]!.init.method).toBe('POST')
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ name: 'Kkeujeok' })
    await c.update('a/b', { addParents: 'k', removeParents: 'd', trashed: true })
    const { url, init } = seen[1]!
    expect(init.method).toBe('PATCH')
    expect(url.pathname).toBe('/v3/files/a%2Fb')
    expect(url.searchParams.get('addParents')).toBe('k')
    expect(url.searchParams.get('removeParents')).toBe('d')
    expect(JSON.parse(init.body as string)).toEqual({ trashed: true })
  })

  test('update sends appProperties in the PATCH body (a null value deletes the key), with or without trashed', async () => {
    const { c, seen } = client(() => json({ id: 'f1' }))
    await c.update('f1', { appProperties: { kkjResolved: '2026-10-13T00:00:00.000Z', old: null } })
    expect(seen[0]!.init.method).toBe('PATCH')
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ appProperties: { kkjResolved: '2026-10-13T00:00:00.000Z', old: null } })
    await c.update('f1', { addParents: 'k' })
    expect(JSON.parse(seen[1]!.init.body as string)).toEqual({})
  })

  test('get falls back to the asked id when the answer has none', async () => {
    const { c } = client(() => json({ trashed: true }))
    expect(await c.get('x', { fields: 'trashed' })).toMatchObject({ id: 'x', trashed: true })
  })
})

describe('errors are DriveError and classify', () => {
  test('http: status and the first errors[].reason', async () => {
    const { c } = client(() => json({ error: { errors: [{ reason: 'rateLimitExceeded' }, { reason: 'x' }] } }, 403))
    const e = (await rejection(c.get('x')))!
    expect(e).toBeInstanceOf(DriveError)
    expect([e.kind, e.status, e.reason]).toEqual(['http', 403, 'rateLimitExceeded'])
    expect(classifyDriveError(e)).toBe('backoff')
  })

  test('an OAuth-style error string is the reason', async () => {
    const { c } = client(() => json({ error: 'invalid_grant' }, 400))
    const e = (await rejection(c.get('x')))!
    expect(classifyDriveError(e)).toBe('reauth')
  })

  test('fetch failure, timeout and a throwing token getter are network (backoff), not reauth', async () => {
    const a = client(() => Promise.reject(new TypeError('failed to fetch')))
    expect(classifyDriveError((await rejection(a.c.get('x')))!)).toBe('backoff')
    const b = client(() => json({}), () => {
      throw new Error('token refresh failed')
    })
    const e = (await rejection(b.c.get('x')))!
    expect(e.kind).toBe('network')
    expect(classifyDriveError(e)).toBe('backoff')
    expect(b.seen).toHaveLength(0)
  })

  test('no token is a 401 and sends nothing', async () => {
    const { c, seen } = client(() => json({}), () => null)
    const e = (await rejection(c.get('x')))!
    expect([e.kind, e.status]).toEqual(['http', 401])
    expect(classifyDriveError(e)).toBe('reauth')
    expect(seen).toHaveLength(0)
  })

  test('a body that is not JSON is parse (unreadable); 5xx is backoff; 404 is deleted', async () => {
    const p = client(() => new Response('<html>', { status: 200 }))
    expect((await rejection(p.c.get('x')))!.kind).toBe('parse')
    const l = client(() => json({ nope: 1 }))
    expect((await rejection(l.c.list('q')))!.kind).toBe('parse')
    const s = client(() => new Response('oops', { status: 502 }))
    expect(classifyDriveError((await rejection(s.c.get('x')))!)).toBe('backoff')
    const n = client(() => json({ error: { errors: [{ reason: 'notFound' }] } }, 404))
    expect(classifyDriveError((await rejection(n.c.get('x')))!)).toBe('deleted')
  })
})
