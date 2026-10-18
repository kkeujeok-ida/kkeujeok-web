// Story 3.25: the four rules never throw on malformed input (spec: `{error}`), beyond the shared fixtures.
import { describe, expect, test } from 'vitest'
import type { Note } from '../src/model/note'
import { restoreNote, restorePage } from '../src/ops/restore'
import { keepForeverRule, versionListRule } from '../src/sync/versionList'
import { NID, PA, mkNote } from './uploadHarness'

const ctx = { revs: ['r1'], rev: 'r1', orderRev: 'o', now: '2026-10-13T00:00:00.000Z', editedBy: 'x', lastSeenRemoteSeq: 0 }

describe('malformed input is an error, never a throw', () => {
  test('version.list', () => {
    for (const bad of [null, 1, 'x', [], {}, { now: 'x', noteId: NID, revisions: [], sidecars: [] }, { now: ctx.now, noteId: NID, revisions: [{}], sidecars: [] }, { now: ctx.now, noteId: NID, revisions: [], sidecars: [null] }]) {
      expect(versionListRule(bad)).toEqual({ error: 'invalidInput' })
    }
    expect(versionListRule({ now: ctx.now, noteId: NID, headRevisionId: null, revisions: [], sidecars: [] })).toEqual({ entries: [] })
  })

  test('version.keepForever', () => {
    for (const bad of [null, [], {}, { revisions: [], target: 'a' }, { revisions: 3, target: 'a' }, { revisions: [{ id: 'a', modifiedTime: 'x' }], target: 'a' }]) {
      expect(keepForeverRule(bad)).toEqual({ error: 'invalidInput' })
    }
  })

  test('restoreNote / restorePage', () => {
    const note = mkNote()
    const junk = [null, undefined, 3, {}] as unknown as Note[]
    for (const j of junk) {
      expect(restoreNote(note, { op: 'restoreNote', version: j as never }, ctx as never, [])).toMatchObject({ error: expect.any(String) })
      expect(restorePage(note, { op: 'restorePage', pageId: PA, page: j as never, originalIndex: 0 }, ctx as never, [])).toMatchObject({ error: expect.any(String) })
    }
    expect(restoreNote(note, { op: 'restoreNote', version: note }, { ...(ctx as object), revs: [] } as never, [])).toEqual({ error: 'invalidInput' })
    expect(restoreNote(note, { op: 'restoreNote', version: note }, ctx as never, null as never)).toEqual({ error: 'invalidInput' })
    expect(restorePage(note, { op: 'restorePage', pageId: PA, page: note.pages[0]!, originalIndex: 1.5 }, ctx as never, [])).toEqual({ error: 'invalidInput' })
  })

  test('the inputs are not changed', () => {
    const note = mkNote()
    const before = JSON.stringify(note)
    const r = restoreNote(note, { op: 'restoreNote', version: note }, ctx as never, [])
    expect('note' in r && r.note).not.toBe(note)
    expect(JSON.stringify(note)).toBe(before)
  })
})
