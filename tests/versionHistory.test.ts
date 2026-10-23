// @vitest-environment jsdom
// Story 3.25, the dialog itself: the states (loading, empty, offline, failed + retry, list), items newest first with
// time, device, tags and previews, the two-step restore, the failure words, keyboard and focus, the disabled restore
// of a read-only tab, ko + en, and no timer or state update after unmount. Real source over the fake Drive.
import 'fake-indexeddb/auto'
import { act, createElement } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DriveError } from '../src/drive/driveClient'
import { encodeKkj } from '../src/model/kkjCodec'
import type { Note } from '../src/model/note'
import { deleteNoteDatabase } from '../src/storage/noteDb'
import { type RestoreFailure, createVersionSource } from '../src/sync/versionHistory'
import type { VersionEntry } from '../src/sync/versionList'
import { PROBE_TIMEOUT_MS, VersionHistory } from '../src/ui/library/VersionHistory'
import { type Mounted, mountUi } from './syncUiHarness'
import { type Env, NID, PA, makeEnv, mkNote, withStroke } from './uploadHarness'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakePath {
  moveTo() {}
  lineTo() {}
  closePath() {}
}
;(globalThis as { Path2D?: unknown }).Path2D = FakePath
const drawn: string[] = []
const ctxProxy = new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? (...a: unknown[]) => void drawn.push(`${k}:${a.join(',')}`) : undefined), set: () => true })
HTMLCanvasElement.prototype.getContext = (() => ctxProxy) as never
HTMLCanvasElement.prototype.getBoundingClientRect = (() => ({ width: 60, height: 80, top: 0, left: 0, right: 60, bottom: 80, x: 0, y: 0, toJSON() {} })) as never

let m: Mounted | undefined
let env: Env | undefined
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  m?.unmount()
  m = undefined
  env?.close()
  env = undefined
  drawn.length = 0
  await deleteNoteDatabase()
})

const settle = (ms = 20) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
async function until(cond: () => boolean, what = 'condition') {
  for (let i = 0; i < 100; i++) {
    if (cond()) return
    await settle(10)
  }
  throw new Error(`timed out: ${what}`)
}

const edited = (n: Note, by: string): Note => {
  const c = structuredClone(n)
  for (const p of c.pages) p.editedBy = by
  return c
}

/** Three revisions on Drive: rev1 (empty page), rev2 (one stroke, "Pixel 8"), rev3 = head (two strokes). */
async function threeRevisions(e: Env) {
  await e.store.writeNote(mkNote())
  await e.uploader.upload(NID)
  const fileId = e.drive.byKkeujeokId(NID)[0]!.id
  e.drive.foreignRevision(fileId, await encodeKkj(edited(withStroke(mkNote(), PA, 'a2', 's1'), 'Pixel 8')))
  e.drive.foreignRevision(fileId, await encodeKkj(withStroke(withStroke(mkNote(), PA, 'a2', 's1'), PA, 'a3', 's2')))
  const revs = e.drive.revisions(fileId)
  return { fileId, ids: revs.map((r) => r.id) }
}

type Props = Partial<Parameters<typeof VersionHistory>[0]>
function open(e: Env, p: Props = {}, lang: 'ko' | 'en' = 'ko') {
  const onClose = vi.fn()
  const onRestore = vi.fn(p.onRestore ?? (async (): Promise<RestoreFailure | null> => null))
  const probe = vi.fn(p.probe ?? (async () => true))
  const readFileId = p.readFileId ?? (async () => e.drive.byKkeujeokId(NID)[0]?.id ?? null)
  m = mountUi(
    createElement(VersionHistory, {
      noteId: NID,
      source: createVersionSource(e.drive),
      restoreBlocked: false,
      now: () => '2026-10-20T00:00:00.000Z',
      ...p,
      probe,
      readFileId,
      onRestore,
      onClose,
    }),
    lang,
  )
  return { onClose, onRestore, probe }
}
const dlg = () => m!.q('[role="dialog"]')!
const items = () => m!.qa('[data-version-item]')
const restoreButtons = () => m!.qa<HTMLButtonElement>('[data-restore]')
const key = (k: string, init: KeyboardEventInit = {}) => act(() => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })))

describe('the states', () => {
  test('loading: placeholder rows with a status label while the probe waits', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    let go!: (v: boolean) => void
    open(e, { probe: () => new Promise<boolean>((r) => (go = r)) })
    expect(m!.q('[role="status"][aria-label="버전 기록을 불러오는 중이에요"]')).not.toBeNull()
    expect(m!.qa('.version-placeholder')).toHaveLength(3)
    expect(dlg().getAttribute('aria-busy')).toBe('true')
    await act(async () => go(true))
    await until(() => items().length > 0, 'the list')
    expect(m!.qa('.version-placeholder')).toHaveLength(0)
  })

  test('empty: only the head exists -> "현재 리비전만 있음", [새로고침] and no list', async () => {
    const e = (env = await makeEnv())
    await e.store.writeNote(mkNote())
    await e.uploader.upload(NID)
    open(e)
    await until(() => !!m!.q('.version-message'), 'the message')
    expect(m!.q('.version-message')!.textContent).toBe('아직 이전 버전이 없어요. 새로고침하면 다시 확인해요.새로고침')
    expect(m!.q('.version-message button')!.textContent).toBe('새로고침')
    expect(items()).toHaveLength(0)
  })

  test('empty: a sync that finishes reloads the list by itself', async () => {
    const e = (env = await makeEnv())
    await e.store.writeNote(mkNote())
    await e.uploader.upload(NID)
    const fileId = e.drive.byKkeujeokId(NID)[0]!.id
    open(e, {
      pendingSync: async () => {
        await new Promise((r) => setTimeout(r, 20))
        e.drive.foreignRevision(fileId, await encodeKkj(withStroke(mkNote(), PA, 'a2', 's1')))
      },
    })
    await until(() => items().length > 0, 'the list after the sync')
  })

  test('resolved on this device but not on Drive yet: listed, and restorable', async () => {
    const e = (env = await makeEnv())
    await e.store.writeNote(mkNote())
    await e.uploader.upload(NID)
    const page = mkNote().pages[0]!
    const pageId = '01926f3a-0000-7000-8000-0000000000d1'
    const rev = '01926f3a-0000-7000-8000-0000000000d2'
    const onRestore = vi.fn(async (): Promise<RestoreFailure | null> => null)
    open(e, {
      onRestore,
      readLocal: async () => [
        {
          props: { kkeujeokId: `sc:${NID}:${pageId}:${rev}`, kkjResolved: '2026-10-19T00:00:00.000Z', kkjEdited: '2026-10-18T00:00:00.000Z', kkjIndex: '0' },
          sidecar: { noteId: NID, pageId, rev, seq: 1, editedAt: '2026-10-18T00:00:00.000Z', editedBy: 'Pixel 8', kind: 'bothEdited', page },
        },
      ],
    })
    await until(() => items().length === 1, 'the local entry')
    expect(items()[0]!.textContent).toContain('Pixel 8')
    expect(restoreButtons()[0]!.getAttribute('aria-disabled')).toBe('false')
  })

  test('one revision with a bad time is left out, the rest stay', async () => {
    const e = (env = await makeEnv())
    const source = createVersionSource(e.drive)
    open(e, {
      readFileId: async () => 'f1',
      source: {
        ...source,
        load: async () => ({
          headRevisionId: 'r3',
          revisions: [
            { id: 'r1', modifiedTime: 'garbage' },
            { id: 'r2', modifiedTime: '2026-10-19T00:00:00.000Z' },
            { id: 'r3', modifiedTime: '2026-10-19T01:00:00.000Z' },
          ],
          sidecars: [],
        }),
      },
    })
    await until(() => items().length === 1, 'the valid older revision')
  })

  test('empty: a note that was never uploaded has no history and no Drive call is made', async () => {
    const e = (env = await makeEnv())
    open(e, { readFileId: async () => null })
    await until(() => !!m!.q('.version-message'), 'the message')
    expect(m!.q('.version-message')!.textContent).toBe('아직 이전 버전이 없어요. 새로고침하면 다시 확인해요.새로고침')
    expect(e.drive.calls).toEqual([])
  })

  test('offline: the probe says no -> the words, and no list call', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    const before = e.drive.calls.length
    open(e, { probe: async () => false })
    await until(() => !!m!.q('.version-message'), 'the message')
    expect(m!.q('.version-message')!.textContent).toBe('연결되면 버전 기록을 볼 수 있어요.')
    expect(e.drive.calls).toHaveLength(before)
  })

  test('offline: a probe that takes over 3 s counts as offline, and its timer is gone after unmount', async () => {
    const e = (env = await makeEnv())
    vi.useFakeTimers()
    open(e, { probe: () => new Promise<boolean>(() => {}) })
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await act(async () => void (await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1)))
    expect(m!.q('.version-message')!.textContent).toBe('연결되면 버전 기록을 볼 수 있어요.')
    m!.unmount()
    m = undefined
    expect(vi.getTimerCount()).toBe(0)
  })

  test('unmounted while loading: nothing is set afterwards (no console error)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const e = (env = await makeEnv())
    await threeRevisions(e)
    let go!: (v: boolean) => void
    open(e, { probe: () => new Promise<boolean>((r) => (go = r)) })
    m!.unmount()
    m = undefined
    await act(async () => go(true))
    await settle(30)
    expect(err).not.toHaveBeenCalled()
  })

  test('failed: the load fails -> message and [다시 시도]; retry loads', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    e.drive.clearFailures() // the counts start here
    e.drive.failAt('listRevisions', 1, new DriveError('http', 500, 'backendError'))
    open(e)
    await until(() => !!m!.q('.version-message button'), 'the retry button')
    expect(m!.q('.version-message p')!.textContent).toBe('버전 기록을 불러오지 못했어요.')
    act(() => void m!.q<HTMLButtonElement>('.version-message button')!.click())
    await until(() => items().length > 0, 'the list after retry')
  })
})

describe('the list', () => {
  test('newest first, the head is hidden, time + device + tags, the item label reads "time, device, tag"', async () => {
    const e = (env = await makeEnv())
    const { fileId, ids } = await threeRevisions(e)
    await e.drive.updateRevision(fileId, ids[0]!, { keepForever: true })
    open(e)
    await until(() => items().length === 2, 'two older versions')
    const bodies = items().map((i) => i.querySelector('.version-time')!.textContent)
    expect(bodies.every(Boolean)).toBe(true)
    // rev2 (newer) first, rev1 (the "복원 전" one) second; rev3 is the head and not listed
    await until(() => items()[0]!.querySelector('.version-device')?.textContent === 'Pixel 8', 'the device name')
    expect(items()[0]!.querySelector('.version-tags')).toBeNull()
    expect([...items()[1]!.querySelectorAll('.version-tag')].map((x) => x.textContent)).toEqual(['복원 전'])
    const label = items()[0]!.getAttribute('aria-label')!
    expect(label).toBe(`${bodies[0]}, Pixel 8`)
    expect(items()[1]!.getAttribute('aria-label')).toMatch(/, 복원 전$/)
    expect(items()[0]!.tagName).toBe('LI')
    expect(m!.q('ul')!.getAttribute('aria-label')).toBe('이전 버전 목록')
  })

  test('a resolved conflict sidecar is "충돌로 남긴 버전" (label ends with the tag)', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    const folder = await e.drive.create({ name: NID, mimeType: 'application/vnd.google-apps.folder', parents: ['ROOT'], appProperties: { kkeujeokId: `cf:${NID}` } })
    const rev = '01926f3a-0000-7000-8000-0000000000c2'
    const page = mkNote().pages[0]!
    await e.drive.uploadSimple({
      metadata: { name: 'x.json', parents: [folder.id], appProperties: { kkeujeokId: `sc:${NID}:${PA}:${rev}`, kkjEdited: '2026-10-19T00:00:00.000Z', kkjIndex: '0', kkjResolved: '2026-10-19T01:00:00.000Z' } },
      bytes: new TextEncoder().encode(JSON.stringify({ noteId: NID, pageId: PA, rev, seq: 2, editedAt: '2026-10-19T00:00:00.000Z', editedBy: 'Phone', kind: 'bothEdited', page: { ...page, rev } })),
    })
    open(e)
    await until(() => items().length === 3, 'three versions')
    const tagged = items().find((i) => i.querySelector('.version-tag')?.textContent === '충돌로 남긴 버전')!
    await until(() => tagged.querySelector('.version-device')?.textContent === 'Phone', 'the sidecar device')
    expect(tagged.getAttribute('aria-label')).toMatch(/, Phone, 충돌로 남긴 버전$/)
  })

  test('previews are drawn once downloaded', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    open(e)
    await until(() => items().length === 2)
    await until(() => m!.qa('.version-preview canvas').length === 2, 'two previews')
    expect(drawn.length).toBeGreaterThan(0)
    expect(m!.qa('.version-preview-empty')).toHaveLength(0)
  })

  test('purged between the list and the download: placeholder, restore disabled, nothing thrown', async () => {
    const e = (env = await makeEnv())
    const { fileId, ids } = await threeRevisions(e)
    e.drive.hooks.beforeCall = (method) => {
      if (method === 'downloadRevision') e.drive.purgeRevision(fileId, ids[0]!)
    }
    open(e)
    await until(() => items().length === 2)
    // newest first: ids[1] is listed before ids[0]; only the purged ids[0] (second) is unavailable
    await until(() => items()[1]!.querySelector('.version-preview-empty span') !== null, 'the placeholder words')
    expect(items()[1]!.querySelector('.version-preview-empty span')!.textContent).toBe('미리 볼 수 없어요')
    expect(restoreButtons()[1]!.getAttribute('aria-disabled')).toBe('true')
    await until(() => items()[0]!.querySelector('.version-preview canvas') !== null, 'the other preview')
    expect(restoreButtons()[0]!.getAttribute('aria-disabled')).toBe('false')
  })

  test('a download that fails on the network leaves the preview empty but the restore possible', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    e.drive.failAlways('downloadRevision', new DriveError('network'))
    open(e)
    await until(() => items().length === 2)
    await until(() => m!.qa('.version-preview-empty span').length === 2, 'both placeholders')
    expect(restoreButtons().every((b) => b.getAttribute('aria-disabled') === 'false')).toBe(true)
  })

  test('previews are downloaded three at a time', async () => {
    const e = (env = await makeEnv())
    await e.store.writeNote(mkNote())
    await e.uploader.upload(NID)
    const fileId = e.drive.byKkeujeokId(NID)[0]!.id
    for (let i = 0; i < 7; i++) e.drive.foreignRevision(fileId, await encodeKkj(mkNote()))
    let inFlight = 0
    let peak = 0
    const real = e.drive.downloadRevision
    e.drive.downloadRevision = async (...a: Parameters<typeof real>) => {
      peak = Math.max(peak, ++inFlight)
      try {
        await new Promise((r) => setTimeout(r, 15))
        return await real(...a)
      } finally {
        inFlight--
      }
    }
    open(e)
    await until(() => items().length === 7)
    await until(() => m!.qa('.version-preview canvas').length === 7, 'all previews')
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })
})

describe('the restore button', () => {
  test('two steps in place: the first press relabels, the second restores and closes', async () => {
    const e = (env = await makeEnv())
    const { fileId, ids } = await threeRevisions(e)
    const { onRestore, onClose } = open(e)
    await until(() => items().length === 2)
    expect(restoreButtons().map((b) => b.textContent)).toEqual(['이 버전으로 복원', '이 버전으로 복원'])
    act(() => void restoreButtons()[1]!.click())
    expect(onRestore).not.toHaveBeenCalled()
    expect(restoreButtons().map((b) => b.textContent)).toEqual(['이 버전으로 복원', '한 번 더 누르면 이 버전으로 바뀌어요'])
    expect(m!.qa('[role="status"]').some((x) => x.textContent === '한 번 더 누르면 이 버전으로 바뀌어요')).toBe(true)
    act(() => void restoreButtons()[1]!.click())
    await until(() => onClose.mock.calls.length > 0, 'closing')
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onRestore.mock.calls[0]![0]).toMatchObject({ kind: 'revision', revisionId: ids[0] })
    expect(onRestore.mock.calls[0]![1]).toBe(fileId)
    expect(onClose).toHaveBeenCalledWith(true)
  })

  test('arming one button takes the question back from another; a press elsewhere and Esc also reset it', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    const { onClose } = open(e)
    await until(() => items().length === 2)
    act(() => void restoreButtons()[0]!.click())
    act(() => void restoreButtons()[1]!.click())
    expect(restoreButtons().map((b) => b.textContent)).toEqual(['이 버전으로 복원', '한 번 더 누르면 이 버전으로 바뀌어요'])
    act(() => void m!.q('.dialog-title')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(restoreButtons().every((b) => b.textContent === '이 버전으로 복원')).toBe(true)
    act(() => void restoreButtons()[0]!.click())
    restoreButtons()[0]!.focus()
    key('Escape')
    expect(restoreButtons()[0]!.textContent).toBe('이 버전으로 복원')
    expect(onClose).not.toHaveBeenCalled() // the first Esc only takes the question back
    key('Escape')
    expect(onClose).toHaveBeenCalledWith(false)
  })

  const words: Record<RestoreFailure, string> = {
    unreadable: '이 버전을 읽을 수 없어요.',
    notSaved: '지금 상태를 Drive에 저장하지 못해서 복원하지 않았어요.',
    notPinned: '복원 전 버전을 표시하지 못해서 복원하지 않았어요.',
    notApplied: '복원하지 못했어요. 잠시 후 다시 시도해 주세요.',
    changed: '그사이 노트가 바뀌어서 복원하지 않았어요. 다시 눌러 주세요.',
    busy: '쓰는 중에는 복원할 수 없어요. 획을 끝내고 다시 눌러 주세요.',
  }
  for (const [failure, text] of Object.entries(words) as [RestoreFailure, string][]) {
    test(`failure ${failure}: its own words in an alert, the dialog stays and the button is usable again`, async () => {
      const e = (env = await makeEnv())
      await threeRevisions(e)
      const { onClose } = open(e, { onRestore: async () => failure })
      await until(() => items().length === 2)
      act(() => void restoreButtons()[0]!.click())
      act(() => void restoreButtons()[0]!.click())
      await until(() => m!.q('[role="alert"]')!.textContent !== '', 'the message')
      expect(m!.q('[role="alert"]')!.textContent).toBe(text)
      expect(onClose).not.toHaveBeenCalled()
      expect(restoreButtons()[0]!.textContent).toBe('이 버전으로 복원')
      expect(restoreButtons()[0]!.getAttribute('aria-disabled')).toBe('false')
    })
  }

  test('notSaved while offline says so', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    let online = true
    open(e, { onRestore: async () => ((online = false), 'notSaved'), probe: async () => online })
    await until(() => items().length === 2)
    act(() => void restoreButtons()[0]!.click())
    act(() => void restoreButtons()[0]!.click())
    await until(() => m!.q('[role="alert"]')!.textContent !== '')
    expect(m!.q('[role="alert"]')!.textContent).toBe('연결되면 복원할 수 있어요.')
  })

  test('a restore that throws is the generic failure', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    open(e, { onRestore: async () => Promise.reject(new Error('x')) })
    await until(() => items().length === 2)
    act(() => void restoreButtons()[0]!.click())
    act(() => void restoreButtons()[0]!.click())
    await until(() => m!.q('[role="alert"]')!.textContent !== '')
    expect(m!.q('[role="alert"]')!.textContent).toBe('복원하지 못했어요. 잠시 후 다시 시도해 주세요.')
  })

  test('while restoring: a polite "복원하는 중이에요", the other buttons and Esc do nothing', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    let done!: (f: RestoreFailure | null) => void
    const { onClose, onRestore } = open(e, { onRestore: () => new Promise((r) => (done = r)) })
    await until(() => items().length === 2)
    act(() => void restoreButtons()[0]!.click())
    act(() => void restoreButtons()[0]!.click())
    expect(m!.q('.version-message')!.textContent).toBe('복원하는 중이에요')
    act(() => void restoreButtons()[1]!.click())
    act(() => void restoreButtons()[1]!.click())
    key('Escape')
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => done('unreadable'))
  })

  test('a read-only tab / receiving: disabled with the tooltip, a press calls nothing and arms nothing', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    const { onRestore } = open(e, { restoreBlocked: true })
    await until(() => items().length === 2)
    for (const b of restoreButtons()) {
      expect(b.getAttribute('aria-disabled')).toBe('true')
      expect(b.getAttribute('title')).toBe('읽기 전용이에요')
    }
    const calls = e.drive.calls.length
    act(() => void restoreButtons()[0]!.click())
    act(() => void restoreButtons()[0]!.click())
    expect(restoreButtons()[0]!.textContent).toBe('이 버전으로 복원')
    expect(onRestore).not.toHaveBeenCalled()
    expect(e.drive.calls.length).toBe(calls)
  })
})

describe('robustness', () => {
  test('a list the rule refuses is a failed load with a retry, not an empty history', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    open(e, { now: () => 'not a time' })
    await until(() => !!m!.q('.version-message button'), 'the retry button')
    expect(m!.q('.version-message p')!.textContent).toBe('버전 기록을 불러오지 못했어요.')
    expect(items()).toHaveLength(0)
  })

  test('a sidecar file Drive lists without appProperties is skipped, the rest is listed', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    const folder = await e.drive.create({ name: NID, mimeType: 'application/vnd.google-apps.folder', parents: ['ROOT'], appProperties: { kkeujeokId: `cf:${NID}` } })
    await e.drive.uploadSimple({ metadata: { name: 'x.json', parents: [folder.id] }, bytes: new Uint8Array([1]) })
    const real = e.drive.list
    e.drive.list = async (...a: Parameters<typeof real>) => {
      const r = await real(...a)
      return { ...r, files: r.files.map((f) => ({ ...f, appProperties: undefined as never })) }
    }
    open(e)
    await until(() => items().length === 2, 'the revisions')
  })

  test('the armed question goes when focus leaves the button; the tooltip names the reason', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    open(e)
    await until(() => items().length === 2)
    restoreButtons()[0]!.focus()
    act(() => void restoreButtons()[0]!.click())
    expect(restoreButtons()[0]!.textContent).toBe('한 번 더 누르면 이 버전으로 바뀌어요')
    act(() => void restoreButtons()[0]!.blur())
    expect(restoreButtons()[0]!.textContent).toBe('이 버전으로 복원')
    m!.unmount()
    m = undefined
    open(e, { restoreBlocked: true, blockedTitle: '최신 내용 받는 중' })
    await until(() => items().length === 2)
    expect(restoreButtons()[0]!.getAttribute('title')).toBe('최신 내용 받는 중')
  })
})

describe('keyboard and focus', () => {
  test('focus starts on [닫기]; Tab stays inside; the list item is the one tab stop of the list', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    open(e)
    await until(() => items().length === 2)
    expect(document.activeElement).toBe(m!.q('.version-head button'))
    const stops = () => [...dlg().querySelectorAll<HTMLElement>('button:not([tabindex="-1"]), [tabindex="0"]')]
    expect(stops().map((x) => x.tagName + (x.hasAttribute('data-version-item') ? ':item' : x.hasAttribute('data-restore') ? ':restore' : ''))).toEqual(['BUTTON', 'LI:item', 'BUTTON:restore'])
    key('Tab')
    expect(document.activeElement).toBe(items()[0])
    key('Tab')
    expect(document.activeElement).toBe(restoreButtons()[0])
    key('Tab') // wraps to [닫기]
    expect(document.activeElement).toBe(m!.q('.version-head button'))
    key('Tab', { shiftKey: true }) // and back to the last stop
    expect(document.activeElement).toBe(restoreButtons()[0])
  })

  test('arrow keys move between items, Home / End jump, Enter reaches the restore button of the item', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    open(e)
    await until(() => items().length === 2)
    items()[0]!.focus()
    key('ArrowDown')
    expect(document.activeElement).toBe(items()[1])
    expect(items()[1]!.getAttribute('tabindex')).toBe('0')
    expect(items()[0]!.getAttribute('tabindex')).toBe('-1')
    key('ArrowDown') // stays on the last
    expect(document.activeElement).toBe(items()[1])
    key('ArrowUp')
    expect(document.activeElement).toBe(items()[0])
    key('End')
    expect(document.activeElement).toBe(items()[1])
    key('Home')
    expect(document.activeElement).toBe(items()[0])
    key('Enter')
    expect(document.activeElement).toBe(restoreButtons()[0])
    // the restore button keeps its own keys: the arrow does not leave it
    key('ArrowDown')
    expect(document.activeElement).toBe(restoreButtons()[0])
  })

  test('Esc and [닫기] close the dialog; the dialog is modal with its title as name', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    const { onClose } = open(e)
    await until(() => items().length === 2)
    expect(dlg().getAttribute('aria-modal')).toBe('true')
    expect(dlg().getAttribute('aria-labelledby')).toBe(m!.q('.dialog-title')!.id)
    expect(m!.q('.dialog-title')!.textContent).toBe('버전 기록')
    key('Escape')
    expect(onClose).toHaveBeenLastCalledWith(false)
    act(() => void m!.q<HTMLButtonElement>('.version-head button')!.click())
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('English', () => {
  test('the words', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    open(e, {}, 'en')
    await until(() => items().length === 2)
    expect(m!.q('.dialog-title')!.textContent).toBe('Version history')
    expect(restoreButtons()[0]!.textContent).toBe('Restore this version')
    act(() => void restoreButtons()[0]!.click())
    expect(restoreButtons()[0]!.textContent).toBe('Press again to switch to this version')
    expect(m!.q('.version-head button')!.textContent).toBe('Close')
  })

  test('offline and empty', async () => {
    const e = (env = await makeEnv())
    open(e, { probe: async () => false }, 'en')
    await until(() => !!m!.q('.version-message'))
    expect(m!.q('.version-message')!.textContent).toBe('Version history is available once you are connected.')
    m!.unmount()
    m = undefined
    open(e, { readFileId: async () => null }, 'en')
    await until(() => !!m!.q('.version-message'))
    expect(m!.q('.version-message')!.textContent).toBe('No earlier versions yet. Refresh to check again.Refresh')
  })
})

describe('entries', () => {
  test('the entry given to onRestore is a version.list entry', async () => {
    const e = (env = await makeEnv())
    await threeRevisions(e)
    const { onRestore } = open(e)
    await until(() => items().length === 2)
    act(() => void restoreButtons()[0]!.click())
    act(() => void restoreButtons()[0]!.click())
    await until(() => onRestore.mock.calls.length > 0)
    const entry = onRestore.mock.calls[0]![0] as VersionEntry
    expect(entry).toMatchObject({ kind: 'revision', current: false, restorable: true })
  })
})
