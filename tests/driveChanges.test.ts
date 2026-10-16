// changes.getStartPageToken and changes.list of the HTTP Drive client (Story 3.14).
import { describe, expect, test } from 'vitest'
import { DriveError, createHttpDriveClient } from '../src/drive/driveClient'

function client(answer: (u: URL) => Response) {
  const seen: URL[] = []
  const fetchStub = (async (url: URL | string) => {
    const u = new URL(url)
    seen.push(u)
    return answer(u)
  }) as unknown as typeof fetch
  return { seen, c: createHttpDriveClient({ fetch: fetchStub, token: () => 'tok', baseUrl: 'https://drive.test/v3' }) }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const rejection = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as DriveError)

describe('getStartPageToken', () => {
  test('asks changes/startPageToken and returns the token', async () => {
    const { c, seen } = client(() => json({ startPageToken: '4711' }))
    expect(await c.getStartPageToken()).toBe('4711')
    expect(seen[0]!.pathname).toBe('/v3/changes/startPageToken')
  })
  test('an answer without a token is a parse error', async () => {
    const { c } = client(() => json({}))
    expect(await rejection(c.getStartPageToken())).toMatchObject({ kind: 'parse' })
  })
})

describe('listChanges', () => {
  test('one page: params of the spec, files with mimeType and thumbnail, removed entries', async () => {
    const { c, seen } = client(() =>
      json({
        newStartPageToken: '99',
        changes: [
          { fileId: 'f1', removed: false, file: { id: 'f1', name: 'a.kkj', mimeType: 'application/vnd.kkeujeok.kkj', headRevisionId: 'r1', thumbnailLink: 'https://t', appProperties: { kkeujeokId: 'x' }, trashed: false } },
          { fileId: 'f2', removed: true },
        ],
      }),
    )
    const r = await c.listChanges('7')
    const q = seen[0]!.searchParams
    expect(seen[0]!.pathname).toBe('/v3/changes')
    expect(q.get('pageToken')).toBe('7')
    expect(q.get('pageSize')).toBe('1000')
    expect(q.get('includeRemoved')).toBe('true')
    expect(q.get('restrictToMyDrive')).toBe('true')
    expect(q.get('spaces')).toBe('drive')
    expect(q.get('fields')).toContain('newStartPageToken')
    expect(q.get('fields')).toContain('headRevisionId')
    expect(r.newStartPageToken).toBe('99')
    expect(r.nextPageToken).toBeUndefined()
    expect(r.changes[0]).toMatchObject({ fileId: 'f1', removed: false, file: { mimeType: 'application/vnd.kkeujeok.kkj', headRevisionId: 'r1', thumbnailLink: 'https://t' } })
    expect(r.changes[1]).toEqual({ fileId: 'f2', removed: true })
  })

  test('a page with nextPageToken has no new start token', async () => {
    const { c } = client(() => json({ nextPageToken: '8', changes: [] }))
    expect(await c.listChanges('7')).toEqual({ changes: [], nextPageToken: '8' })
  })

  test.each([400, 404, 410])('a rejected token (%i) is a DriveError of that status', async (status) => {
    const { c } = client(() => json({ error: { errors: [{ reason: 'notFound' }] } }, status))
    expect(await rejection(c.listChanges('old'))).toMatchObject({ kind: 'http', status })
  })

  test('a malformed answer is a parse error', async () => {
    expect(await rejection(client(() => json({ nope: 1 })).c.listChanges('1'))).toMatchObject({ kind: 'parse' })
    expect(await rejection(client(() => json({ changes: [{ removed: true }] })).c.listChanges('1'))).toMatchObject({ kind: 'parse' })
  })
})

describe('list', () => {
  test('pageSize defaults to 100 and can be 1000 (the tree rescan)', async () => {
    const { c, seen } = client(() => json({ files: [] }))
    await c.list('q')
    await c.list('q', { pageSize: 1000 })
    expect(seen.map((u) => u.searchParams.get('pageSize'))).toEqual(['100', '1000'])
  })
})
