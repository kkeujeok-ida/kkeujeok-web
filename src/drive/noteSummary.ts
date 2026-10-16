// Spec drive.fileName and drive.listSummary (write and read). Pure; never throws.
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const bad = { error: 'invalidInput' } as const

// The trim set of note.title (the same characters as src/model/noteTitle.ts).
const WS = '\\t-\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'
const EDGE = new RegExp(`^[${WS}]|[${WS}]$`)

const validTitle = (t: string) => {
  const n = [...t].length
  return n >= 1 && n <= 100 && !EDGE.test(t)
}

export function driveFileNameRule(input: unknown): { name: string } | { error: 'invalidTitle' } {
  const t = isObj(input) ? input.title : undefined
  return typeof t === 'string' && validTitle(t) ? { name: `${t}.kkj` } : { error: 'invalidTitle' }
}

const MD5 = /^[0-9a-f]{32}$/
const TIMESTAMP = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/

/** Longest `kkjCover` value: key (8 bytes) + value stay within 124. */
export const MAX_COVER_BYTES = 116

export type SummaryWrite = {
  name: string
  appProperties: Record<string, string | null>
  thumbnail: { mimeType: 'image/png'; width: 300; height: number } | null
}

function write(input: Obj): SummaryWrite | { error: string } {
  const note = input.note
  if (!isObj(note) || !isObj(note.meta) || !Array.isArray(note.pages) || typeof note.noteId !== 'string') return bad
  const name = driveFileNameRule({ title: note.meta.title })
  if ('error' in name) return name
  const md5 = input.md5
  if (typeof md5 !== 'string' || !MD5.test(md5)) return { error: 'invalidMd5' }
  const size = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0
  const pages = note.pages as unknown[]
  for (const p of pages) if (!isObj(p) || !size(p.width) || !size(p.height) || typeof p.editedAt !== 'string') return bad

  const ps = pages as { id: unknown; width: number; height: number; editedAt: string }[]
  const order = input.order
  let first = ps[0]
  if (Array.isArray(order) && order.length > 0) first = ps.find((p) => p.id === order[0]) ?? first
  let edited: string | null = null
  for (const p of ps) if (edited === null || p.editedAt > edited) edited = p.editedAt
  const cover = note.meta.coverId
  const coverValue = typeof cover === 'string' && cover !== '' ? cover : null
  if (coverValue !== null && new TextEncoder().encode(coverValue).length > MAX_COVER_BYTES) {
    return {
      name: name.name,
      appProperties: { kkeujeokId: note.noteId, kkjV: null, kkjMd5: null, kkjCover: null, kkjEdited: null },
      thumbnail: null,
    }
  }
  const height = first ? Math.min(900, Math.max(1, Math.floor((300 * first.height) / first.width + 0.5))) : 0
  return {
    name: name.name,
    appProperties: { kkeujeokId: note.noteId, kkjV: '1', kkjMd5: md5, kkjCover: coverValue, kkjEdited: edited },
    thumbnail: first ? { mimeType: 'image/png', width: 300, height } : null,
  }
}

function read(input: Obj) {
  const download = { source: 'download' } as const
  const f = input.file
  if (!isObj(f)) return bad
  const props = f.appProperties
  const name = f.name
  if (!isObj(props) || typeof name !== 'string') return download
  const id = props.kkeujeokId
  const md5 = props.kkjMd5
  const sum = f.md5Checksum
  const edited = props.kkjEdited
  const title = name.endsWith('.kkj') ? name.slice(0, -4) : name
  if (
    props.kkjV !== '1' ||
    typeof id !== 'string' || id === '' ||
    typeof md5 !== 'string' || !MD5.test(md5) ||
    typeof sum !== 'string' || sum !== md5 ||
    !validTitle(title) ||
    (edited != null && (typeof edited !== 'string' || !TIMESTAMP.test(edited)))
  ) return download
  const parents = f.parents
  const root = input.rootFolderId ?? null
  let folder: string | null = Array.isArray(parents) && typeof parents[0] === 'string' ? parents[0] : null
  if (folder !== null && root !== null && folder === root) folder = null
  const cover = props.kkjCover
  const link = f.thumbnailLink
  return {
    source: 'summary',
    card: {
      noteId: id,
      title,
      folderId: folder,
      coverId: typeof cover === 'string' && cover !== '' ? cover : null,
      modifiedAt: typeof edited === 'string' ? edited : f.modifiedTime,
      thumbnail: typeof link === 'string' && link !== '' ? 'drive' : 'none',
    },
  } as const
}

export function listSummaryRule(input: unknown) {
  try {
    if (!isObj(input)) return bad
    if (input.op === 'write') return write(input)
    if (input.op === 'read') return read(input)
    return bad
  } catch {
    return bad
  }
}
