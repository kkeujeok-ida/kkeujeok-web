// Story 3.20: how the conflicts of a merge are put into sync.json (the pure rules of src/sync/conflicts.ts).
// Each rule has a test that fails when the rule is removed.
import { describe, expect, test } from 'vitest'
import { emptySync } from '../src/storage/syncInfo'
import { conflictLogFields, noRecorded, recordInto, sidecarKey, unresolvedOf } from '../src/sync/conflicts'
import type { Conflict, Sidecar } from '../src/sync/merge'
import { NID, PA, PB, mkNote } from './uploadHarness'

const conf = (pageId: string, rev: string, o: Partial<Conflict> = {}): Conflict => ({
  pageId,
  kind: 'bothEdited',
  rev,
  theirsRev: 't1',
  detectedAt: '2026-10-12T04:20:00.000Z',
  originalIndex: 0,
  resolvedAt: null,
  ...o,
})
const side = (pageId: string, rev: string, o: Partial<Sidecar> = {}): Sidecar => ({
  noteId: NID,
  pageId,
  rev,
  seq: 2,
  editedAt: '2026-10-11T04:20:00.000Z',
  editedBy: 'Chrome, Windows',
  kind: 'bothEdited',
  page: mkNote().pages[0]!,
  ...o,
})
const add = (pageId: string, rev: string) => ({ conflicts: [conf(pageId, rev)], sidecars: [side(pageId, rev)] })

describe('recordInto', () => {
  test('a new conflict: entry appended, sidecar stored and listed as unsent, state untouched', () => {
    const base = { ...emptySync(), state: 'syncing' as const }
    const r = recordInto(base, add(PA, 'a2'))
    expect(r.info.conflicts).toEqual([conf(PA, 'a2')])
    expect(r.info.unsentSidecars).toEqual([{ pageId: PA, rev: 'a2' }])
    expect(r.store.map(sidecarKey)).toEqual([`${PA}:a2`])
    expect(r.added).toEqual({ conflicts: [{ pageId: PA, rev: 'a2' }], sidecars: [{ pageId: PA, rev: 'a2' }] })
    expect(r.info.state).toBe('syncing')
    expect(base.conflicts).toEqual([]) // the input is not changed
  })

  test('two pages: both recorded, in order', () => {
    const r = recordInto(emptySync(), {
      conflicts: [conf(PA, 'a2', { originalIndex: 0 }), conf(PB, 'b2', { originalIndex: 1 })],
      sidecars: [side(PA, 'a2'), side(PB, 'b2')],
    })
    expect(r.info.conflicts.map((c) => c.pageId)).toEqual([PA, PB])
    expect(r.info.unsentSidecars.map((u) => u.pageId)).toEqual([PA, PB])
  })

  test('a page that already has an unresolved entry keeps it: only kind and theirsRev follow, no second sidecar', () => {
    const first = recordInto(emptySync(), add(PA, 'a2')).info
    const r = recordInto(first, { conflicts: [conf(PA, 'a9', { kind: 'remoteDeleted', theirsRev: null })], sidecars: [side(PA, 'a9')] })
    expect(r.info.conflicts).toEqual([conf(PA, 'a2', { kind: 'remoteDeleted', theirsRev: null })])
    expect(r.info.unsentSidecars).toEqual([{ pageId: PA, rev: 'a2' }])
    expect(r.store).toEqual([])
    expect(r.added).toEqual(noRecorded())
  })

  test('the same detection twice is idempotent', () => {
    const once = recordInto(emptySync(), add(PA, 'a2')).info
    const twice = recordInto(once, add(PA, 'a2'))
    expect(twice.info.conflicts).toHaveLength(1)
    expect(twice.info.unsentSidecars).toHaveLength(1)
    expect(twice.store).toEqual([])
  })

  test('a resolved entry of the page does not block a new conflict', () => {
    const resolved = { ...emptySync(), conflicts: [{ ...conf(PA, 'a1'), resolvedAt: '2026-10-12T05:00:00.000Z' }] }
    const r = recordInto(resolved, add(PA, 'a2'))
    expect(r.info.conflicts.map((c) => [c.rev, c.resolvedAt])).toEqual([
      ['a1', '2026-10-12T05:00:00.000Z'],
      ['a2', null],
    ])
    expect(unresolvedOf(r.info).map((c) => c.rev)).toEqual(['a2'])
  })

  test('supersedes: what an earlier try recorded is removed first, then the new one is recorded', () => {
    const tryOne = recordInto(emptySync(), add(PA, 'a2'))
    const tryTwo = recordInto(tryOne.info, add(PA, 'a3'), tryOne.added)
    expect(tryTwo.info.conflicts.map((c) => c.rev)).toEqual(['a3'])
    expect(tryTwo.info.unsentSidecars).toEqual([{ pageId: PA, rev: 'a3' }])
    expect(tryTwo.drop).toEqual([{ pageId: PA, rev: 'a2' }])
    expect(tryTwo.store.map(sidecarKey)).toEqual([`${PA}:a3`])
  })

  test('supersedes touches only what it names: other pages and resolved entries stay', () => {
    const other = recordInto(emptySync(), add(PB, 'b2')).info
    const withResolved = { ...other, conflicts: [...other.conflicts, { ...conf(PA, 'a2'), resolvedAt: '2026-10-12T05:00:00.000Z' }] }
    const r = recordInto(withResolved, add(PA, 'a3'), { conflicts: [{ pageId: PA, rev: 'a2' }], sidecars: [{ pageId: PA, rev: 'a2' }] })
    expect(r.info.conflicts.map((c) => `${c.pageId}:${c.rev}`)).toEqual([`${PB}:b2`, `${PA}:a2`, `${PA}:a3`])
    expect(r.drop).toEqual([]) // a2 was not unsent any more
    expect(r.info.unsentSidecars.map((u) => u.rev)).toEqual(['b2', 'a3'])
  })

  test('a conflict without its sidecar record is still an entry but stores nothing', () => {
    const r = recordInto(emptySync(), { conflicts: [conf(PA, 'a2')], sidecars: [] })
    expect(r.info.conflicts).toHaveLength(1)
    expect(r.store).toEqual([])
    expect(r.info.unsentSidecars).toEqual([])
  })
})

describe('log fields', () => {
  test('the rev is logged when it is a UUID, never anything else; no page id', () => {
    const u = '01926f3a-0000-7000-8000-000000000001'
    expect(conflictLogFields(NID, u)).toEqual({ noteId: NID, rev: u })
    expect(conflictLogFields(NID, 'a2')).toEqual({ noteId: NID })
  })
})
