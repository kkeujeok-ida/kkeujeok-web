// Runs every fixture in the root repo's test/ folder (read unchanged from the
// sibling path) against this client's implementation of the rule.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { gzipSync } from 'node:zlib'
import { decodeKkj, encodeKkj } from '../src/model/kkjCodec'
import { normalizeTitle } from '../src/model/noteTitle'
import type { Note } from '../src/model/note'
import { round2 } from '../src/model/number'
import { History } from '../src/ops/history'
import { type Ctx, type Op, applyOp, createNote } from '../src/ops/ops'

type Case = { name: string; input: unknown; expected: unknown }

// Rule id -> how to judge one case. A new spec rule adds one line here.
const runners: Record<string, (c: Case) => void | Promise<void>> = {
  'number.round2': ({ input, expected }) => {
    // Number(x) would turn null into 0 and let NaN pass against NaN.
    if (typeof input !== 'number' || typeof expected !== 'number') {
      throw new Error('"input" and "expected" must be JSON numbers')
    }
    const out = round2(input)
    expect(Object.is(out, -0), 'output is negative zero').toBe(false)
    expect(out).toBe(expected)
  },
  'note.roundTrip': async ({ input, expected }) => {
    const r = await decodeKkj(await encodeKkj((input as { note: Note }).note))
    expect(r.result).toBe('ok')
    expect({ note: r.note }).toEqual(expected)
  },
  'note.unknownFields': async ({ input, expected }) => {
    const r = await decodeKkj(await encodeKkj((input as { note: Note }).note))
    expect(r.result).toBe('ok')
    expect({ note: r.note }).toEqual(expected)
  },
  'note.formatVersion': async ({ input, expected }) => {
    const i = input as { json?: unknown; text?: string; gzipBase64?: string }
    const bytes =
      i.gzipBase64 !== undefined
        ? Buffer.from(i.gzipBase64, 'base64')
        : gzipSync(Buffer.from(i.text ?? JSON.stringify(i.json), 'utf8'))
    expect(await decodeKkj(new Uint8Array(bytes))).toEqual(expected)
  },
  'note.title': ({ input, expected }) => {
    const i = input as { title: string; existingTitles: string[] }
    const t = normalizeTitle(i.title, i.existingTitles)
    expect(t === null ? { ok: false, reason: 'tooLong' } : { ok: true, title: t }).toEqual(expected)
  },
  'ops.createNote': ({ input, expected }) => {
    expect(createNote(input as Parameters<typeof createNote>[0])).toEqual(expected)
  },
  'ops.addStroke': opRunner,
  'ops.removeStroke': opRunner,
  'ops.undoRedo': ({ input, expected }) => {
    type Step = { kind: 'do' | 'undo' | 'redo'; op?: Op; ctx: Ctx }
    const i = input as { note: Note; steps: Step[] }
    const h = new History(i.note)
    const errors = i.steps.map((s) =>
      s.kind === 'do' ? h.doOp(s.op!, s.ctx) : s.kind === 'undo' ? h.undo(s.ctx) : h.redo(s.ctx),
    )
    expect({ note: h.note, undoDepth: h.undoDepth, redoDepth: h.redoDepth, errors }).toEqual(expected)
  },
}

// Rules whose fixture must exist and be valid but have no runner yet (Story 2.10).
const PENDING = ['stroke.outline.pen', 'page.background']

function opRunner({ input, expected }: Case) {
  const i = input as { note: Note; op: Op; ctx: Ctx }
  expect(applyOp(i.note, i.op, i.ctx)).toEqual(expected)
}

const sharedDir = fileURLToPath(new URL('../../test/', import.meta.url))

function loadFixtures(dir: string, pending: string[] = PENDING): Map<string, Case[]> {
  if (!existsSync(dir)) {
    throw new Error(
      `Fixture folder not found: ${dir}\n` +
        '루트 kkeujeok 레포 안에 클론했는지 확인하세요 ' +
        '(kkeujeok-web must be cloned inside the root kkeujeok repo, next to test/).',
    )
  }
  const fixtures = new Map<string, Case[]>()
  const seen = new Set<string>()
  for (const file of readdirSync(dir)) {
    // Generator scripts, not fixtures.
    if (file === 'README.md' || file === 'tools') continue
    const bad = (why: string) => new Error(`Bad fixture ${file}: ${why}`)
    // Anything else in the folder (a subfolder, "x.JSON", "x.json.bak") would
    // otherwise be skipped without a word.
    if (!file.endsWith('.json')) throw bad('not a "<rule id>.json" file')
    const id = file.slice(0, -'.json'.length)
    // The id pattern from spec/README.md. Also keeps ids like "constructor"
    // from finding an inherited property in `runners`.
    if (!/^[a-z][a-z0-9]*\.[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)?$/.test(id)) throw bad('file name is not a rule id')
    let data: { rule?: unknown; cases?: unknown }
    try {
      data = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch (e) {
      throw bad(`not valid JSON (${(e as Error).message})`)
    }
    if (data === null || typeof data !== 'object') throw bad('top level is not an object')
    if (data.rule !== id) {
      throw bad(`"rule" is ${JSON.stringify(data.rule)}, expected "${id}" (the file name)`)
    }
    const cases: unknown = data.cases
    if (!Array.isArray(cases) || cases.length === 0) throw bad('"cases" is missing or empty')
    const names = new Set<string>()
    for (const [i, c] of cases.entries()) {
      if (c === null || typeof c !== 'object') throw bad(`case ${i} is not an object`)
      if (typeof c.name !== 'string' || c.name === '') throw bad(`case ${i} has no "name"`)
      if (names.has(c.name)) throw bad(`duplicate case name "${c.name}"`)
      names.add(c.name)
      if (!('input' in c) || !('expected' in c)) {
        throw bad(`case "${c.name}" needs both "input" and "expected"`)
      }
    }
    seen.add(id)
    const run = runners[id]
    if (!run && pending.includes(id)) continue
    if (!run) {
      throw new Error(
        `Fixture ${file} has no test: rule "${id}" is not implemented in the web client. ` +
          'Add it to `runners` in tests/fixtures.test.ts.',
      )
    }
    fixtures.set(id, cases as Case[])
  }
  for (const id of Object.keys(runners)) {
    if (!fixtures.has(id)) throw new Error(`Fixture file missing: ${join(dir, `${id}.json`)}`)
  }
  for (const id of pending) {
    if (!seen.has(id)) throw new Error(`Fixture file missing: ${join(dir, `${id}.json`)}`)
  }
  return fixtures
}

// Thrown at collection time on purpose: a broken setup fails the run, never skips.
for (const [id, cases] of loadFixtures(sharedDir)) {
  describe(id, () => {
    for (const c of cases) test(c.name, async () => void (await runners[id]!(c)))
  })
}

describe('harness refuses a broken setup', () => {
  const good = readFileSync(join(sharedDir, 'number.round2.json'), 'utf8')
  // A temp folder holding exactly the given files (removed on exit).
  const made: string[] = []
  const mkOnly = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'kkj-fixtures-'))
    made.push(dir)
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    return dir
  }
  afterAll(() => made.forEach((d) => rmSync(d, { recursive: true })))
  const loadOnly = (files: Record<string, string>) => loadFixtures(mkOnly(files))
  // The real fixture plus the given extra files.
  const real = Object.fromEntries(
    readdirSync(sharedDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => [f, readFileSync(join(sharedDir, f), 'utf8')]),
  )
  const loadWith = (files: Record<string, string>) => loadOnly({ ...real, ...files })

  test('fixture folder missing', () => {
    const missing = join(tmpdir(), 'kkj-fixtures-does-not-exist')
    expect(() => loadFixtures(missing)).toThrow('루트 kkeujeok 레포 안에 클론했는지 확인')
    expect(() => loadFixtures(missing)).toThrow(missing)
  })

  test('fixture with no test', () => {
    const fixture = JSON.stringify({ rule: 'stroke.hitTest', cases: [{ name: 'a', input: 1, expected: 1 }] })
    expect(() => loadWith({ 'stroke.hitTest.json': fixture })).toThrow('"stroke.hitTest"')
  })

  test('rule differs from file name', () => {
    const fixture = JSON.stringify({ rule: 'number.round3', cases: [{ name: 'a', input: 1, expected: 1 }] })
    expect(() => loadWith({ 'number.round2.json': fixture })).toThrow(/number\.round2\.json.*"rule"/)
  })

  test('empty cases', () => {
    const fixture = JSON.stringify({ rule: 'number.round2', cases: [] })
    expect(() => loadWith({ 'number.round2.json': fixture })).toThrow(/number\.round2\.json.*"cases"/)
  })

  test('case without input or expected', () => {
    const fixture = JSON.stringify({ rule: 'number.round2', cases: [{ name: 'a' }] })
    expect(() => loadWith({ 'number.round2.json': fixture })).toThrow(/needs both/)
  })

  test('runner whose fixture file is gone', () => {
    expect(() => loadOnly({})).toThrow(/Fixture file missing.*number\.round2\.json/)
  })

  test('entry that is not a rule id .json file', () => {
    expect(() => loadWith({ 'stroke.hitTest.JSON': good })).toThrow('stroke.hitTest.JSON')
    expect(() => loadWith({ 'constructor.json': good })).toThrow('not a rule id')
  })

  test('two-dot rule id accepted; pending rule needs no runner; unlisted still fails', () => {
    const fx = (rule: string) => JSON.stringify({ rule, cases: [{ name: 'a', input: 1, expected: 1 }] })
    // The real folder already holds the pending fixtures.
    expect(loadFixtures(sharedDir).has('stroke.outline.pen')).toBe(false)
    expect(() => loadFixtures(sharedDir, [])).toThrow('is not implemented')
    expect(() => loadWith({ 'stroke.hitTest.json': fx('stroke.hitTest') })).toThrow('"stroke.hitTest"')
  })

  test('number.round2 case with non-number values', () => {
    const run = runners['number.round2']!
    expect(() => run({ name: 'a', input: 'abc', expected: 'abc' })).toThrow('JSON numbers')
    expect(() => run({ name: 'a', input: null, expected: 0 })).toThrow('JSON numbers')
  })
})
