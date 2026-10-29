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
import { PEN_DEFAULTS, PEN_PALETTE, PEN_WIDTH, colorNameKey, defaultPenSlots, type PenTool } from '../src/model/pen'
import { resources } from '../src/i18n'
import { highlighterOutline } from '../src/render/highlighterOutline'
import { History } from '../src/ops/history'
import { type Ctx, type Op, applyOp, createNote } from '../src/ops/ops'
import { selectLasso, selectRect, selectTap, type El, type P } from '../src/model/select'
import { driveAssetsFolderRule } from '../src/drive/duplicates'
import { assetState, imageAccept, imageInitialSize, imageUploadPlan, referencedAssets } from '../src/model/imageRules'
import { layoutText, type LineBox } from '../src/model/textLayout'
import { snapScale } from '../src/render/pagePainter'
import { pageBackground } from '../src/render/pageBackground'
import { strokeOutline } from '../src/render/strokeOutline'
import { hasUnsentRule } from '../src/sync/hasUnsent'
import { checkLogEntry } from '../src/sync/syncLogEntry'
import { driveDuplicatesRule } from '../src/drive/duplicates'
import type { Conflict, Sidecar } from '../src/sync/merge'
import { merge, mergeRequeue, type MergeCtx } from '../src/sync/merge'
import { resolveConflict } from '../src/ops/resolveConflict'
import { errorClassRule } from '../src/sync/errorClass'
import { backoffRule, staleHeadRule, stateMachineRule, uploadKindRule, verifyPlanRule } from '../src/sync/syncRules'
import { driveFileNameRule, driveRemoteTitleRule, listSummaryRule } from '../src/drive/noteSummary'
import { restoreNote, restorePage } from '../src/ops/restore'
import { keepForeverRule, versionListRule } from '../src/sync/versionList'

// `tolerance` is the fixture file's top-level value, copied onto each case.
type Case = { name: string; input: unknown; expected: unknown; tolerance?: number }

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
  'pen.defaultSlots': ({ expected }) => {
    expect({ slots: defaultPenSlots }).toEqual(expected)
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
  'ops.move': opRunner,
  'ops.scale': opRunner,
  'ops.rotate': opRunner,
  'ops.setStrokeColor': opRunner,
  'ops.setStrokeWidth': opRunner,
  'ops.delete': opRunner,
  'ops.paste': opRunner,
  'ops.createTextBox': opRunner,
  'ops.editText': opRunner,
  'ops.setTextBoxWidth': opRunner,
  'ops.textBox': opRunner,
  'ops.image': opRunner,
  'ops.insertImage': opRunner,
  'select.image': ({ input, expected }) => {
    const i = input as { fn: 'lasso' | 'tap' | 'rect'; elements: El[]; polygon?: P[]; point?: P; tolerance?: number; rect?: [number, number, number, number] }
    const got = i.fn === 'lasso' ? selectLasso(i.elements, i.polygon!) : i.fn === 'tap' ? selectTap(i.elements, i.point!, i.tolerance) : selectRect(i.elements, i.rect!)
    expect(got).toEqual(expected)
  },
  'drive.assetsFolder': ({ input, expected }) => void expect(driveAssetsFolderRule(input as Parameters<typeof driveAssetsFolderRule>[0])).toEqual(expected),
  'image.accept': ({ input, expected }) => {
    const i = input as { head: string; size: number }
    expect(imageAccept(i.head, i.size)).toEqual(expected)
  },
  'image.initialSize': ({ input, expected }) => {
    const i = input as { pxWidth: number; pxHeight: number; pageWidth: number; pageHeight: number }
    expect(imageInitialSize(i.pxWidth, i.pxHeight, i.pageWidth, i.pageHeight)).toEqual(expected)
  },
  'image.referencedAssets': ({ input, expected }) => void expect(referencedAssets((input as { note: Note }).note)).toEqual(expected),
  'image.uploadPlan': ({ input, expected }) => {
    const i = input as { referenced: string[]; confirmed: string[]; onDevice: string[] }
    expect(imageUploadPlan(i.referenced, i.confirmed, i.onDevice)).toEqual(expected)
  },
  'image.assetState': ({ input, expected }) => {
    const i = input as { asset: unknown; local: string[]; failed: string[] }
    expect({ state: assetState(i.asset, i.local, i.failed) }).toEqual(expected)
  },
  'image.unknownFields': async ({ input, expected }) => {
    const i = input as { note: Note; op?: Op; ctx?: Ctx }
    if (!i.op) {
      const r = await decodeKkj(await encodeKkj(i.note))
      expect(r.result).toBe('ok')
      expect({ note: r.note }).toEqual(expected)
      return
    }
    const r = applyOp(i.note, i.op, i.ctx!)
    expect({ note: 'note' in r ? r.note : undefined }).toEqual(expected)
  },
  'text.unknownFields': async ({ input, expected }) => {
    const i = input as { note: Note; op?: Op; ctx?: Ctx }
    if (!i.op) {
      const r = await decodeKkj(await encodeKkj(i.note))
      expect(r.result).toBe('ok')
      expect({ note: r.note }).toEqual(expected)
      return
    }
    const r = applyOp(i.note, i.op, i.ctx!)
    expect({ note: 'note' in r ? r.note : undefined }).toEqual(expected)
  },
  'text.layout': ({ input, expected, tolerance }) => {
    const l = layoutText((input as { element: Record<string, unknown> }).element)
    const e = expected as { height: number; lines: LineBox[] }
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tolerance! + 1e-9)
    near(l.height, e.height)
    expect(l.lines).toHaveLength(e.lines.length)
    e.lines.forEach((x, k) => {
      const y = l.lines[k]!
      expect([y.start, y.end]).toEqual([x.start, x.end])
      near(y.width, x.width); near(y.top, x.top); near(y.baseline, x.baseline); near(y.height, x.height)
    })
  },
  'select.textBox': ({ input, expected }) => {
    const i = input as { fn: 'lasso' | 'tap' | 'rect'; elements: El[]; polygon?: P[]; point?: P; tolerance?: number; rect?: [number, number, number, number] }
    const got = i.fn === 'lasso' ? selectLasso(i.elements, i.polygon!) : i.fn === 'tap' ? selectTap(i.elements, i.point!, i.tolerance) : selectRect(i.elements, i.rect!)
    expect(got).toEqual(expected)
  },
  'ops.undoRedo': historyRunner,
  'ops.eraseHistory': historyRunner,
  'ops.eraseStrokes': opRunner,
  'ops.erasePartial': opRunner,
  'stroke.outline.pen': ({ input, expected, tolerance }) => {
    const i = input as { width: number; usePressure: boolean; points: number[][] }
    const want = (expected as { polygon: number[][] }).polygon
    const got = strokeOutline(i.width, i.usePressure, i.points)
    expect(got).toHaveLength(want.length)
    expect(typeof tolerance, 'fixture has no tolerance').toBe('number')
    for (const [k, p] of got.entries()) {
      for (const axis of [0, 1]) {
        // 2-decimal outputs: an exact 0.02 step shows up as 0.020000000000000018.
        expect(Math.abs(p[axis]! - want[k]![axis]!)).toBeLessThanOrEqual(tolerance! + 1e-9)
      }
    }
  },
  'stroke.outline.highlighter': ({ input, expected, tolerance }) => {
    const i = input as { width: number; points: number[][] }
    const want = (expected as { polygons: number[][][] }).polygons
    const got = highlighterOutline(i.width, i.points)
    expect(got).toHaveLength(want.length)
    expect(typeof tolerance, 'fixture has no tolerance').toBe('number')
    for (const [k, rect] of got.entries()) {
      expect(rect).toHaveLength(want[k]!.length)
      for (const [j, p] of rect.entries()) {
        for (const axis of [0, 1]) expect(Math.abs(p[axis]! - want[k]![j]![axis]!)).toBeLessThanOrEqual(tolerance! + 1e-9)
      }
    }
  },
  'pen.palette': ({ input, expected }) => {
    const tool = (input as { tool: PenTool }).tool
    const pal = PEN_PALETTE[tool]
    expect({
      columns: pal.columns,
      rows: pal.rows,
      colors: pal.colors.map((color) => ({ color, ko: resources.ko[colorNameKey(color)], en: resources.en[colorNameKey(color)] })),
      width: { ...PEN_WIDTH[tool], default: PEN_DEFAULTS[tool].width, step: 0.1 },
      usePressureDefault: PEN_DEFAULTS[tool].usePressure,
    }).toEqual(expected)
  },
  'page.background': ({ input, expected }) => {
    const i = input as { background: string; width: number; height: number }
    expect(pageBackground(i.background, i.width, i.height)).toEqual(expected)
  },
  'sync.hasUnsent': ({ input, expected }) => {
    expect(hasUnsentRule(input)).toEqual(expected)
  },
  'drive.duplicates': ({ input, expected }) => {
    expect(driveDuplicatesRule(input as Parameters<typeof driveDuplicatesRule>[0])).toEqual(expected)
  },
  'sync.errorClass': ({ input, expected }) => {
    expect(errorClassRule(input as Record<string, unknown>)).toEqual(expected)
  },
  'sync.uploadKind': ({ input, expected }) => void expect(uploadKindRule(input)).toEqual(expected),
  'sync.staleHead': ({ input, expected }) => void expect(staleHeadRule(input)).toEqual(expected),
  'sync.verifyPlan': ({ input, expected }) => void expect(verifyPlanRule(input)).toEqual(expected),
  'sync.backoff': ({ input, expected }) => void expect(backoffRule(input)).toEqual(expected),
  'sync.stateMachine': ({ input, expected }) => void expect(stateMachineRule(input)).toEqual(expected),
  'drive.fileName': ({ input, expected }) => void expect(driveFileNameRule(input)).toEqual(expected),
  'drive.remoteTitle': ({ input, expected }) => void expect(driveRemoteTitleRule(input as Parameters<typeof driveRemoteTitleRule>[0])).toEqual(expected),
  'drive.listSummary': ({ input, expected }) => void expect(listSummaryRule(input)).toEqual(expected),
  'merge.page3way': mergeRunner,
  'merge.staleSeq': mergeRunner,
  'merge.seqAfterMerge': mergeRunner,
  'merge.conflictSidecar': mergeRunner,
  'merge.order': mergeRunner,
  'merge.meta': mergeRunner,
  'merge.unknownFields': mergeRunner,
  'merge.formatVersion': mergeRunner,
  'merge.undoDrop': mergeRunner,
  'merge.requeue': ({ input, expected }) => {
    expect(mergeRequeue(input as Parameters<typeof mergeRequeue>[0])).toEqual(expected)
  },
  'merge.resolve': ({ input, expected }) => {
    const i = input as { note: Note; conflict: Conflict; sidecar: Sidecar; choice: unknown; ctx: MergeCtx }
    expect(resolveConflict(i.note, i.conflict, i.sidecar, i.choice, i.ctx)).toEqual(expected)
  },
  'merge.keepBothConverge': ({ input, expected }) => {
    type Side = { note: Note; conflict: Conflict; sidecar: Sidecar; ctx: MergeCtx }
    const i = input as { base: Note; a: Side; b: Side; ctx: MergeCtx }
    const res = (s: Side) => resolveConflict(s.note, s.conflict, s.sidecar, 'both', s.ctx)
    const a = res(i.a)
    const b = res(i.b)
    expect('note' in a && 'note' in b, 'both sides resolve').toBe(true)
    const [an, bn] = [(a as { note: Note }).note, (b as { note: Note }).note]
    expect({ a, b, ab: merge(i.base, an, bn, i.ctx), ba: merge(i.base, bn, an, i.ctx) }).toEqual(expected)
  },
  'version.list': ({ input, expected }) => void expect(versionListRule(input)).toEqual(expected),
  'version.keepForever': ({ input, expected }) => void expect(keepForeverRule(input)).toEqual(expected),
  'ops.restoreNote': ({ input, expected }) => {
    const j = input as { note: Parameters<typeof restoreNote>[0]; op: Parameters<typeof restoreNote>[1]; ctx: Parameters<typeof restoreNote>[2]; conflicts: Parameters<typeof restoreNote>[3] }
    expect(restoreNote(j.note, j.op, j.ctx, j.conflicts)).toEqual(expected)
  },
  'ops.restorePage': ({ input, expected }) => {
    const j = input as { note: Parameters<typeof restorePage>[0]; op: Parameters<typeof restorePage>[1]; ctx: Parameters<typeof restorePage>[2]; conflicts: Parameters<typeof restorePage>[3] }
    expect(restorePage(j.note, j.op, j.ctx, j.conflicts)).toEqual(expected)
  },
  'synclog.entry': ({ input, expected }) => {
    expect(checkLogEntry((input as { entry: unknown }).entry)).toEqual(expected)
  },
  'select.lasso': ({ input, expected }) => {
    const i = input as { elements: El[]; polygon: P[] }
    expect(selectLasso(i.elements, i.polygon)).toEqual(expected)
  },
  'select.tap': ({ input, expected }) => {
    const i = input as { elements: El[]; point: P; tolerance?: number }
    expect(selectTap(i.elements, i.point, i.tolerance)).toEqual(expected)
  },
  'select.rect': ({ input, expected }) => {
    const i = input as { elements: El[]; rect: [number, number, number, number] }
    expect(selectRect(i.elements, i.rect)).toEqual(expected)
  },
  'zoom.snap': ({ input, expected }) => {
    const i = input as { scale: number; fitScale: number }
    expect(snapScale(i.scale, i.fitScale)).toBe(expected)
  },
}

// Rules whose fixture must exist and be valid but have no runner yet.
// Sync rules (Story 3.2) arrive with the web sync stories (3.4, 3.6, 3.10, ...);
// each story removes its rule here when it adds the runner.
// Selection and edit rules (Story 4.1) arrive with the web stories 4.3, 4.5, 4.7.
const PENDING: string[] = []

function mergeRunner({ input, expected }: Case) {
  const i = input as { base: Note | null; local: Note; remote: Note; ctx: MergeCtx }
  expect(merge(i.base, i.local, i.remote, i.ctx)).toEqual(expected)
}

function historyRunner({ input, expected }: Case) {
  type Step = { kind: 'do' | 'undo' | 'redo'; op?: Op; ctx: Ctx }
  const i = input as { note: Note; steps: Step[] }
  const h = new History(i.note)
  const errors = i.steps.map((s) =>
    s.kind === 'do' ? h.doOp(s.op!, s.ctx) : s.kind === 'undo' ? h.undo(s.ctx) : h.redo(s.ctx),
  )
  expect({ note: h.note, undoDepth: h.undoDepth, redoDepth: h.redoDepth, errors }).toEqual(expected)
}

function opRunner({ input, expected }: Case) {
  const i = input as { note: Note; op: Op; ctx: Ctx; undoCtx?: Ctx }
  let r = applyOp(i.note, i.op, i.ctx)
  // Inverse case: the inverse goes onto the result; only its note is compared.
  if (i.undoCtx && 'note' in r && r.inverse) {
    const u = applyOp(r.note, r.inverse, i.undoCtx)
    r = 'note' in u ? { note: u.note, inverse: null } : u
    expect({ note: (r as { note: Note }).note }).toEqual(expected)
    return
  }
  expect(r).toEqual(expected)
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
    if (run && pending.includes(id)) {
      throw new Error(`Rule "${id}" has a runner but is still listed in PENDING: remove it from PENDING.`)
    }
    if (!run && pending.includes(id)) continue
    if (!run) {
      throw new Error(
        `Fixture ${file} has no test: rule "${id}" is not implemented in the web client. ` +
          'Add it to `runners` in tests/fixtures.test.ts.',
      )
    }
    const tolerance = (data as { tolerance?: unknown }).tolerance
    fixtures.set(
      id,
      (cases as Case[]).map((c) => (typeof tolerance === 'number' ? { ...c, tolerance } : c)),
    )
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

  test('two-dot rule id accepted; listed pending rule needs no runner; unlisted still fails', () => {
    const fx = (rule: string) => JSON.stringify({ rule, cases: [{ name: 'a', input: 1, expected: 1 }] })
    expect(loadFixtures(sharedDir).has('stroke.outline.pen')).toBe(true)
    expect(loadFixtures(sharedDir).get('stroke.outline.pen')![0]!.tolerance).toBe(0.02)
    // a synthetic pending id, next to the real pending rules (the real fixtures include them)
    const only = ['stroke.hitTest', ...PENDING]
    expect(loadFixtures(mkOnly({ ...real, 'stroke.hitTest.json': fx('stroke.hitTest') }), only).has('stroke.hitTest')).toBe(false)
    expect(() => loadWith({ 'stroke.hitTest.json': fx('stroke.hitTest') })).toThrow('"stroke.hitTest"')
  })

  test('a PENDING rule that has a runner fails', () => {
    expect(() => loadFixtures(sharedDir, [...PENDING, 'sync.hasUnsent'])).toThrow(/"sync\.hasUnsent".*PENDING/)
    expect(PENDING).not.toContain('sync.hasUnsent')
    expect(PENDING).not.toContain('synclog.entry')
  })

  test('number.round2 case with non-number values', () => {
    const run = runners['number.round2']!
    expect(() => run({ name: 'a', input: 'abc', expected: 'abc' })).toThrow('JSON numbers')
    expect(() => run({ name: 'a', input: null, expected: 0 })).toThrow('JSON numbers')
  })
})
