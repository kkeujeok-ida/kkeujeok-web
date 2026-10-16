// The Drive v3 calls this client makes, behind one seam so tests use an
// in-memory Drive and later stories (uploads) add methods here. Every method
// rejects only with DriveError. The token comes from the caller per call.

/** A failed Drive call in the terms of `sync.errorClass`. */
export class DriveError extends Error {
  constructor(
    readonly kind: 'http' | 'network' | 'trashed' | 'parse',
    readonly status?: number,
    readonly reason?: string,
  ) {
    super(`DriveError(${kind}, ${status ?? ''}, ${reason ?? ''})`)
    this.name = 'DriveError'
  }
}

export type DriveFile = {
  id: string
  name?: string
  parents: string[]
  appProperties: Record<string, string>
  /** Canonical timestamp, or undefined when not asked for. */
  createdTime?: string
  trashed: boolean
}

export type DrivePage = { files: DriveFile[]; nextPageToken?: string }

export interface DriveClient {
  list(q: string, o?: { fields?: string; pageToken?: string }): Promise<DrivePage>
  /** `files.create` with metadata only (`name`, `mimeType`, `parents`, `appProperties`). */
  create(metadata: Record<string, unknown>): Promise<DriveFile>
  get(id: string, o?: { fields?: string }): Promise<DriveFile>
  /** `files.update` of metadata: parents moved and/or the file trashed. */
  update(id: string, o: { addParents?: string; removeParents?: string; trashed?: boolean }): Promise<DriveFile>
}

/** Escapes `\` first and then `'` for a quoted `q` string. */
export const escapeQ = (s: string) => s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")

/** `q` for one `kkeujeokId` (spec drive-layout "Finding"). */
export const kkeujeokIdQuery = (id: string) =>
  `appProperties has { key='kkeujeokId' and value='${escapeQ(id)}' } and trashed=false`

/** `q` for the live children of a folder. */
export const childrenQuery = (folderId: string) => `'${escapeQ(folderId)}' in parents and trashed=false`

const FIELDS = 'id,name,parents,appProperties,createdTime,trashed'

function reasonOf(text: string): string | undefined {
  try {
    const e = (JSON.parse(text) as { error?: unknown }).error
    if (typeof e === 'string') return e
    const list = (e as { errors?: unknown } | null)?.errors
    const r = Array.isArray(list) ? (list[0] as { reason?: unknown } | undefined)?.reason : undefined
    return typeof r === 'string' ? r : undefined
  } catch {
    return undefined
  }
}

function toFile(json: unknown, fallbackId?: string): DriveFile {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new DriveError('parse')
  const m = json as Record<string, unknown>
  const id = typeof m.id === 'string' ? m.id : fallbackId
  if (!id) throw new DriveError('parse')
  const props: Record<string, string> = {}
  if (typeof m.appProperties === 'object' && m.appProperties !== null) {
    for (const [k, v] of Object.entries(m.appProperties)) if (typeof v === 'string') props[k] = v
  }
  return {
    id,
    ...(typeof m.name === 'string' && { name: m.name }),
    parents: Array.isArray(m.parents) ? m.parents.filter((p): p is string => typeof p === 'string') : [],
    appProperties: props,
    ...(typeof m.createdTime === 'string' && { createdTime: m.createdTime }),
    trashed: m.trashed === true,
  }
}

export function createHttpDriveClient(o: {
  fetch?: typeof fetch
  /** null = no token (401 noToken); a throw is a transient failure (network). */
  token: () => string | null | Promise<string | null>
  baseUrl?: string
  timeoutMs?: number
}): DriveClient {
  const base = o.baseUrl ?? 'https://www.googleapis.com/drive/v3'
  const timeoutMs = o.timeoutMs ?? 30_000

  async function send(method: string, path: string, query: Record<string, string>, body?: unknown) {
    let res: Response
    let text: string
    try {
      const t = await o.token()
      if (!t) throw new DriveError('http', 401, 'noToken')
      const url = new URL(base + path)
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
      res = await (o.fetch ?? globalThis.fetch)(url, {
        method,
        headers: {
          Authorization: `Bearer ${t}`,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      text = await res.text()
    } catch (e) {
      throw e instanceof DriveError ? e : new DriveError('network') // fetch, timeout, token getter
    }
    if (res.status < 200 || res.status > 299) throw new DriveError('http', res.status, reasonOf(text))
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new DriveError('parse')
    }
  }
  const file = (id: string) => `/files/${encodeURIComponent(id)}`

  return {
    async list(q, p = {}) {
      const j = (await send('GET', '/files', {
        q,
        pageSize: '100',
        fields: p.fields ?? `nextPageToken,files(${FIELDS})`,
        ...(p.pageToken && { pageToken: p.pageToken }),
      })) as { files?: unknown; nextPageToken?: unknown }
      if (!Array.isArray(j?.files)) throw new DriveError('parse')
      return {
        files: j.files.map((f) => toFile(f)),
        ...(typeof j.nextPageToken === 'string' && j.nextPageToken !== '' && { nextPageToken: j.nextPageToken }),
      }
    },
    async create(metadata) {
      return toFile(await send('POST', '/files', { fields: FIELDS }, metadata))
    },
    async get(id, p = {}) {
      return toFile(await send('GET', file(id), { fields: p.fields ?? FIELDS }), id)
    },
    async update(id, p) {
      return toFile(
        await send(
          'PATCH',
          file(id),
          {
            fields: FIELDS,
            ...(p.addParents && { addParents: p.addParents }),
            ...(p.removeParents && { removeParents: p.removeParents }),
          },
          p.trashed === undefined ? {} : { trashed: p.trashed },
        ),
        id,
      )
    },
  }
}
