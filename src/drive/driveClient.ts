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
  /** Newest revision, when asked for. */
  headRevisionId?: string
  md5Checksum?: string
  /** Canonical timestamp, when asked for. */
  modifiedTime?: string
  mimeType?: string
  /** Short-lived, authenticated link; never stored. */
  thumbnailLink?: string
}

/** One entry of `changes.list`: a removed file has no `file`. */
export type DriveChange = { fileId: string; removed: boolean; file?: DriveFile }
export type DriveChanges = { changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }

/** `keepForever`: pinned ("복원 전"); `revisions.list` is asked for it. */
export type DriveRevision = { id: string; modifiedTime: string; keepForever?: boolean }

/** Answer of one resumable PUT: `file` when finished (200/201), else `received` bytes are held (308). */
export type ResumableResult = { received: number; file?: DriveFile }

export type DrivePage = { files: DriveFile[]; nextPageToken?: string }

export interface DriveClient {
  list(q: string, o?: { fields?: string; pageToken?: string; pageSize?: number }): Promise<DrivePage>
  /** `files.create` with metadata only (`name`, `mimeType`, `parents`, `appProperties`). */
  create(metadata: Record<string, unknown>): Promise<DriveFile>
  get(id: string, o?: { fields?: string }): Promise<DriveFile>
  /** `files.update` of metadata: parents moved, the file trashed and/or `appProperties` set (a `null` value deletes the key). */
  update(
    id: string,
    o: { addParents?: string; removeParents?: string; trashed?: boolean; appProperties?: Record<string, string | null> },
  ): Promise<DriveFile>
  /**
   * One multipart upload (`fields=id,headRevisionId,md5Checksum`). Creates when `fileId` is
   * undefined, else replaces the content. An update never carries `parents`.
   */
  uploadSimple(o: { fileId?: string; metadata: Record<string, unknown>; bytes: Uint8Array }): Promise<DriveFile>
  /** Starts a resumable session with the same metadata; returns its URI. */
  startResumable(o: { fileId?: string; metadata: Record<string, unknown>; size: number }): Promise<string>
  /** One PUT of a session. A null `chunk` asks how far it got (`bytes *` over the size). 404/410 is a DriveError. */
  putResumable(uri: string, size: number, offset: number, chunk: Uint8Array | null): Promise<ResumableResult>
  /** Every revision of the file (all pages, `pageSize=1000`). */
  listRevisions(fileId: string): Promise<DriveRevision[]>
  /** `revisions.get` with `alt=media`. */
  downloadRevision(fileId: string, revisionId: string): Promise<Uint8Array>
  /** `revisions.update` of `keepForever` (Story 3.25). 404 = the revision is gone. */
  updateRevision(fileId: string, revisionId: string, o: { keepForever: boolean }): Promise<DriveRevision>
  /** `files.get` with `alt=media`: the content of a file, e.g. a conflict sidecar's JSON. */
  downloadFile(fileId: string): Promise<Uint8Array>
  /** `changes.getStartPageToken`. */
  getStartPageToken(): Promise<string>
  /** One page of `changes.list` from `pageToken`; a rejected token is a DriveError 400, 404 or 410. */
  listChanges(pageToken: string): Promise<DriveChanges>
}

/** Resumable chunk: a multiple of 262,144 (spec sync step 2). */
export const RESUMABLE_CHUNK = 8_388_608

const UPLOAD_FIELDS = 'id,headRevisionId,md5Checksum'

/** A random multipart boundary that occurs neither in the metadata JSON nor in the content. */
export function pickBoundary(
  json: string,
  bytes: Uint8Array,
  random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(12)),
): string {
  for (;;) {
    const b = 'kkj-' + [...random()].map((x) => x.toString(16).padStart(2, '0')).join('')
    if (!json.includes(b) && !contains(bytes, new TextEncoder().encode(b))) return b
  }
}

function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
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
    ...(typeof m.headRevisionId === 'string' && { headRevisionId: m.headRevisionId }),
    ...(typeof m.md5Checksum === 'string' && { md5Checksum: m.md5Checksum }),
    ...(typeof m.modifiedTime === 'string' && { modifiedTime: m.modifiedTime }),
    ...(typeof m.mimeType === 'string' && { mimeType: m.mimeType }),
    ...(typeof m.thumbnailLink === 'string' && { thumbnailLink: m.thumbnailLink }),
  }
}

/** The file fields a change or a tree scan needs to draw a card or compare heads. */
export const CHANGE_FILE_FIELDS =
  'id,name,mimeType,parents,appProperties,md5Checksum,modifiedTime,thumbnailLink,headRevisionId,trashed'

export type DriveOutcome = { kind: 'ok' } | { kind: 'network' } | { kind: 'unauthorized'; token: string | null }

export function createHttpDriveClient(o: {
  fetch?: typeof fetch
  /** null = no token (401 noToken); a throw is a transient failure (network). */
  token: () => string | null | Promise<string | null>
  baseUrl?: string
  uploadBaseUrl?: string
  timeoutMs?: number
  /** Test hook: the random bytes of a multipart boundary. */
  randomBytes?: () => Uint8Array
  /** Told how each request ended: answered, failed on the network, or refused for the token it carried (401). */
  onOutcome?: (o: DriveOutcome) => void
}): DriveClient {
  const base = o.baseUrl ?? 'https://www.googleapis.com/drive/v3'
  const uploadBase = o.uploadBaseUrl ?? 'https://www.googleapis.com/upload/drive/v3'
  const timeoutMs = o.timeoutMs ?? 30_000

  // Reports a failed request to `onOutcome` and hands the error on.
  function tell(e: DriveError, token: string | null): DriveError {
    if (e.kind === 'network') o.onOutcome?.({ kind: 'network' })
    else if (e.kind === 'http' && e.status === 401) o.onOutcome?.({ kind: 'unauthorized', token })
    else if (e.kind === 'http') o.onOutcome?.({ kind: 'ok' }) // answered, whatever the answer
    return e
  }

  // A raw request (body bytes, own headers). A status outside 2xx and `accept` is a DriveError.
  async function raw(
    method: string,
    url: URL | string,
    a: { headers?: Record<string, string>; body?: BodyInit; accept?: number[] } = {},
  ): Promise<{ res: Response; bytes: Uint8Array }> {
    let res: Response
    let bytes: Uint8Array
    let used: string | null = null
    try {
      const t = await o.token()
      used = t
      if (!t) throw new DriveError('http', 401, 'noToken')
      res = await (o.fetch ?? globalThis.fetch)(url, {
        method,
        headers: { ...a.headers, Authorization: `Bearer ${t}` },
        ...(a.body !== undefined && { body: a.body }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      bytes = new Uint8Array(await res.arrayBuffer())
    } catch (e) {
      throw tell(e instanceof DriveError ? e : new DriveError('network'), used)
    }
    const ok = (res.status >= 200 && res.status <= 299) || (a.accept ?? []).includes(res.status)
    if (!ok) throw tell(new DriveError('http', res.status, reasonOf(new TextDecoder().decode(bytes))), used)
    o.onOutcome?.({ kind: 'ok' })
    return { res, bytes }
  }
  const parse = (bytes: Uint8Array): unknown => {
    try {
      return JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new DriveError('parse')
    }
  }
  const uploadUrl = (type: string, fileId?: string) => {
    const u = new URL(`${uploadBase}/files${fileId === undefined ? '' : '/' + encodeURIComponent(fileId)}`)
    u.searchParams.set('uploadType', type)
    u.searchParams.set('fields', UPLOAD_FIELDS)
    return u
  }

  async function send(method: string, path: string, query: Record<string, string>, body?: unknown) {
    let res: Response
    let text: string
    let used: string | null = null
    try {
      const t = await o.token()
      used = t
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
      throw tell(e instanceof DriveError ? e : new DriveError('network'), used) // fetch, timeout, token getter
    }
    if (res.status < 200 || res.status > 299) throw tell(new DriveError('http', res.status, reasonOf(text)), used)
    o.onOutcome?.({ kind: 'ok' })
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new DriveError('parse')
    }
  }
  const file = (id: string) => `/files/${encodeURIComponent(id)}`
  const enc = new TextEncoder()

  return {
    async uploadSimple({ fileId, metadata, bytes }) {
      const meta = JSON.stringify(metadata)
      const boundary = pickBoundary(meta, bytes, o.randomBytes)
      const head = enc.encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      )
      const tail = enc.encode(`\r\n--${boundary}--`)
      const body = new Uint8Array(head.length + bytes.length + tail.length)
      body.set(head)
      body.set(bytes, head.length)
      body.set(tail, head.length + bytes.length)
      const { bytes: out } = await raw(fileId === undefined ? 'POST' : 'PATCH', uploadUrl('multipart', fileId), {
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: body as BodyInit,
      })
      return toFile(parse(out), fileId)
    },
    async startResumable({ fileId, metadata, size }) {
      const { res } = await raw(fileId === undefined ? 'POST' : 'PATCH', uploadUrl('resumable', fileId), {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'application/octet-stream',
          'X-Upload-Content-Length': String(size),
        },
        body: JSON.stringify(metadata),
      })
      const loc = res.headers.get('location')
      if (!loc) throw new DriveError('parse')
      return loc
    },
    async putResumable(uri, size, offset, chunk) {
      const range = chunk === null ? `bytes */${size}` : `bytes ${offset}-${offset + chunk.length - 1}/${size}`
      const { res, bytes } = await raw('PUT', uri, {
        headers: { 'Content-Range': range },
        body: (chunk ?? new Uint8Array(0)) as BodyInit,
        accept: [308],
      })
      if (res.status === 308) {
        // No Range header (or one the browser hides) means nothing is held: start at 0.
        const m = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '')
        return { received: m ? Number(m[1]) + 1 : 0 }
      }
      return { received: size, file: toFile(parse(bytes)) }
    },
    async listRevisions(fileId) {
      const out: DriveRevision[] = []
      let token: string | undefined
      do {
        const j = (await send('GET', `${file(fileId)}/revisions`, {
          fields: 'nextPageToken,revisions(id,modifiedTime,keepForever)',
          pageSize: '1000',
          ...(token && { pageToken: token }),
        })) as { revisions?: unknown; nextPageToken?: unknown }
        if (!Array.isArray(j?.revisions)) throw new DriveError('parse')
        for (const r of j.revisions as { id?: unknown; modifiedTime?: unknown; keepForever?: unknown }[]) {
          if (typeof r?.id !== 'string' || typeof r.modifiedTime !== 'string') throw new DriveError('parse')
          out.push({ id: r.id, modifiedTime: r.modifiedTime, keepForever: r.keepForever === true })
        }
        token = typeof j.nextPageToken === 'string' && j.nextPageToken !== '' ? j.nextPageToken : undefined
      } while (token)
      return out
    },
    async downloadRevision(fileId, revisionId) {
      const u = new URL(`${base}${file(fileId)}/revisions/${encodeURIComponent(revisionId)}`)
      u.searchParams.set('alt', 'media')
      return (await raw('GET', u)).bytes
    },
    async updateRevision(fileId, revisionId, p) {
      const j = (await send('PATCH', `${file(fileId)}/revisions/${encodeURIComponent(revisionId)}`, { fields: 'id,modifiedTime,keepForever' }, { keepForever: p.keepForever })) as {
        id?: unknown
        modifiedTime?: unknown
        keepForever?: unknown
      }
      if (typeof j?.id !== 'string' || typeof j.modifiedTime !== 'string') throw new DriveError('parse')
      return { id: j.id, modifiedTime: j.modifiedTime, keepForever: j.keepForever === true }
    },
    async downloadFile(fileId) {
      const u = new URL(`${base}${file(fileId)}`)
      u.searchParams.set('alt', 'media')
      return (await raw('GET', u)).bytes
    },
    async getStartPageToken() {
      const j = (await send('GET', '/changes/startPageToken', {})) as { startPageToken?: unknown }
      if (typeof j?.startPageToken !== 'string' || j.startPageToken === '') throw new DriveError('parse')
      return j.startPageToken
    },
    async listChanges(pageToken) {
      const j = (await send('GET', '/changes', {
        pageToken,
        pageSize: '1000',
        includeRemoved: 'true',
        restrictToMyDrive: 'true',
        spaces: 'drive',
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${CHANGE_FILE_FIELDS}))`,
      })) as { changes?: unknown; nextPageToken?: unknown; newStartPageToken?: unknown }
      if (!Array.isArray(j?.changes)) throw new DriveError('parse')
      const changes: DriveChange[] = j.changes.map((c: { fileId?: unknown; removed?: unknown; file?: unknown }) => {
        if (typeof c?.fileId !== 'string') throw new DriveError('parse')
        return { fileId: c.fileId, removed: c.removed === true, ...(c.file != null && { file: toFile(c.file, c.fileId) }) }
      })
      return {
        changes,
        ...(typeof j.nextPageToken === 'string' && j.nextPageToken !== '' && { nextPageToken: j.nextPageToken }),
        ...(typeof j.newStartPageToken === 'string' && j.newStartPageToken !== '' && { newStartPageToken: j.newStartPageToken }),
      }
    },
    async list(q, p = {}) {
      const j = (await send('GET', '/files', {
        q,
        pageSize: String(p.pageSize ?? 100),
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
          {
            ...(p.trashed !== undefined && { trashed: p.trashed }),
            ...(p.appProperties !== undefined && { appProperties: p.appProperties }),
          },
        ),
        id,
      )
    },
  }
}
