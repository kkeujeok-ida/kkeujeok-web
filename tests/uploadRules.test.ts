// Edge cases of the six upload rules beyond the shared fixtures.
import { describe, expect, test } from 'vitest'
import { driveFileNameRule, listSummaryRule } from '../src/drive/noteSummary'
import { backoffRule, stateMachineRule, transition, uploadKindRule, verifyPlanRule } from '../src/sync/syncRules'

describe('rules never throw', () => {
  const junk: unknown[] = [undefined, null, 0, 'x', [], {}, { op: 'write' }, { op: 'write', note: null }, { op: 'read' }, { op: 'read', file: [] }]
  test.each([
    ['uploadKind', uploadKindRule],
    ['verifyPlan', verifyPlanRule],
    ['backoff', backoffRule],
    ['stateMachine', stateMachineRule],
    ['fileName', driveFileNameRule],
    ['listSummary', listSummaryRule],
  ])('%s', (_n, rule) => {
    for (const j of junk) expect(() => rule(j)).not.toThrow()
  })

  test('listSummary with a page without width does not throw', () => {
    const note = { noteId: 'n', meta: { title: 't' }, pages: [{ id: 'p', width: 0, height: 5, editedAt: 'x' }] }
    expect(listSummaryRule({ op: 'write', note, md5: '0'.repeat(32) })).toEqual({ error: 'invalidInput' })
  })
})

test('uploadKind switches exactly above 5 MiB', () => {
  expect(uploadKindRule({ size: 5_242_880 })).toEqual({ kind: 'simple' })
  expect(uploadKindRule({ size: 5_242_881 })).toEqual({ kind: 'resumable' })
})

test('transition returns null for an illegal pair', () => {
  expect(transition('synced', 'upload')).toBeNull()
  expect(transition('syncing', 'verified', { unresolved: 0, unsent: true })).toBe('pending')
})
