// Note model (spec note-format.md, note.formatVersion). A note is plain JSON
// so fields this client does not know ride along untouched at every level.
import { round2 } from './number'

export const SUPPORTED_FORMAT_VERSION = 1
export const BACKGROUNDS = ['plain', 'lined', 'grid', 'dot'] as const

type Extra = { [unknown: string]: unknown }
export type Stroke = Extra & {
  id: string
  type: 'stroke'
  tool: 'pen'
  color: string
  width: number
  usePressure: boolean
  points: number[][]
}
export type Page = Extra & {
  id: string
  width: number
  height: number
  background: string
  rev: string
  seq: number
  editedAt: string
  editedBy: string
  elements: unknown[]
}
export type Note = Extra & {
  formatVersion: number
  noteId: string
  meta: Extra & { title: string; coverId?: string }
  metaRev: string
  metaSeq: number
  orderRev: string
  orderSeq: number
  pages: Page[]
}

export type ReadStatus = 'ok' | 'unsupportedVersion' | 'unreadable'
export type NoteReadResult = { result: ReadStatus; writable: boolean; note?: Note }

const isObj = (v: unknown): v is Extra => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

function validElement(e: unknown): boolean {
  if (!isObj(e) || !isStr(e.id) || !isStr(e.type)) return false
  if (e.type !== 'stroke') return true
  return (
    e.tool === 'pen' &&
    isStr(e.color) &&
    isNum(e.width) &&
    typeof e.usePressure === 'boolean' &&
    Array.isArray(e.points) &&
    e.points.every((p) => Array.isArray(p) && p.length === 4 && p.every(isNum))
  )
}

export const isValidStroke = (e: unknown): e is Stroke => isObj(e) && e.type === 'stroke' && validElement(e)

function validPage(p: unknown): boolean {
  return (
    isObj(p) &&
    isStr(p.id) &&
    isNum(p.width) && p.width > 0 &&
    isNum(p.height) && p.height > 0 &&
    (BACKGROUNDS as readonly unknown[]).includes(p.background) &&
    isStr(p.rev) &&
    isInt(p.seq) &&
    isStr(p.editedAt) &&
    isStr(p.editedBy) &&
    Array.isArray(p.elements) &&
    p.elements.every(validElement)
  )
}

function validNote(m: Extra): boolean {
  if (!isInt(m.formatVersion) || m.formatVersion < 1) return false
  const meta = m.meta
  if (!isObj(meta) || !isStr(meta.title)) return false
  if ('coverId' in meta && !isStr(meta.coverId)) return false
  return (
    isStr(m.noteId) &&
    isStr(m.metaRev) &&
    isInt(m.metaSeq) &&
    isStr(m.orderRev) &&
    isInt(m.orderSeq) &&
    Array.isArray(m.pages) &&
    m.pages.every(validPage)
  )
}

/** Spec `note.formatVersion` steps 2-3 on an already parsed JSON value. */
export function validateNote(json: unknown): NoteReadResult {
  if (!isObj(json)) return { result: 'unreadable', writable: false }
  if (isInt(json.formatVersion) && json.formatVersion > SUPPORTED_FORMAT_VERSION) {
    return { result: 'unsupportedVersion', writable: false }
  }
  if (!validNote(json)) return { result: 'unreadable', writable: false }
  return { result: 'ok', writable: true, note: structuredClone(json) as Note }
}

export function roundStroke(s: Stroke): void {
  s.width = round2(s.width)
  s.points = s.points.map((p) => p.map(round2))
}

/** What gets written: a deep copy with every defined number through round2. */
export function toWritableJson(note: Note): Note {
  const j = structuredClone(note)
  j.metaSeq = round2(j.metaSeq)
  j.orderSeq = round2(j.orderSeq)
  for (const p of j.pages) {
    p.width = round2(p.width)
    p.height = round2(p.height)
    p.seq = round2(p.seq)
    for (const e of p.elements) if (isValidStroke(e)) roundStroke(e)
  }
  return j
}
