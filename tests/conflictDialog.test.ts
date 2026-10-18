// @vitest-environment jsdom
// Story 3.22, the dialog itself: layout and words (ko + en), default focus, the deleted-page variant, the two-step
// "rest" buttons, Esc / [나중에 결정], ‹ › and the arrow keys, the focus trap, advance / close after a choice,
// the changed-element outline, "더 최근", and the pure helpers.
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { resources } from '../src/i18n'
import type { Page } from '../src/model/note'
import { changedRange } from '../src/render/changedRange'
import type { Conflict, Sidecar } from '../src/sync/merge'
import { OTHER_TIME_TIMEOUT_MS, createOtherTime } from '../src/sync/otherTime'
import { ConflictDialog, type ConflictItem, type ResolveOutcome, choiceFor } from '../src/ui/library/ConflictDialog'
import { type Mounted, mountUi, tick } from './syncUiHarness'
import { NID, PA, PB, mkNote, stroke } from './uploadHarness'

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
HTMLCanvasElement.prototype.getBoundingClientRect = (() => ({ width: 100, height: 140, top: 0, left: 0, right: 100, bottom: 140, x: 0, y: 0, toJSON() {} })) as never

let m: Mounted | undefined
afterEach(() => {
  m?.unmount()
  m = undefined
  drawn.length = 0
})

const page = (id: string, ids: string[], o: Partial<Page> = {}): Page => ({ ...mkNote().pages[0]!, id, elements: ids.map((s) => stroke(s)), ...o }) as Page
const entry = (pageId: string, kind: Conflict['kind'], originalIndex = 0): Conflict => ({
  pageId, kind, rev: `${pageId}-mine`, theirsRev: kind === 'remoteDeleted' ? null : 't1', detectedAt: '2026-10-12T04:20:00.000Z', originalIndex, resolvedAt: null,
})
function item(pageId: string, kind: Conflict['kind'] = 'bothEdited', o: { index?: number; mineAt?: string; theirsAt?: string; otherTime?: string | null } = {}): ConflictItem {
  const mine = page(pageId, ['m1', 'm2'], { editedAt: o.mineAt ?? '2026-10-11T04:20:00.000Z', editedBy: 'Phone' })
  const theirs = page(pageId, ['m1', 't1'], { editedAt: o.theirsAt ?? '2026-10-12T04:20:00.000Z', editedBy: 'Laptop' })
  const e = entry(pageId, kind, o.index ?? 0)
  const sidecar: Sidecar = { noteId: NID, pageId, rev: e.rev, seq: 2, editedAt: mine.editedAt, editedBy: 'Phone', kind, page: mine }
  return { entry: e, sidecar, current: kind === 'remoteDeleted' ? null : theirs, otherTime: o.otherTime ?? null }
}

type Props = { onResolve?: (c: [ConflictItem, string][]) => Promise<ResolveOutcome>; onClose?: (d: boolean) => void }
const settleAll = (c: [ConflictItem, string][]): Promise<ResolveOutcome> => Promise.resolve({ settled: new Set(c.map(([i]) => i.entry.pageId)), message: null })
function open(items: ConflictItem[], p: Props = {}, lang: 'ko' | 'en' = 'ko') {
  const onResolve = vi.fn(p.onResolve ?? settleAll)
  const onClose = vi.fn(p.onClose ?? (() => {}))
  m = mountUi(createElement(ConflictDialog, { items, onResolve, onClose }), lang)
  return { onResolve, onClose }
}
const dlg = () => m!.q('[role="dialog"]')!
const buttons = () => m!.qa<HTMLButtonElement>('button')
const label = (b: HTMLElement) => b.getAttribute('aria-label') ?? b.textContent
const byText = (text: string) => buttons().find((b) => b.textContent === text)!
const press = (text: string) => act(() => void byText(text).click())
const key = (k: string, init: KeyboardEventInit = {}) => act(() => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })))
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))))

describe('the layout and the words', () => {
  test('ko: modal dialog, title, progress, question, tags, who and when, buttons in the order of the spec', () => {
    open([item(PA, 'bothEdited', { index: 2 }), item(PB, 'bothEdited', { index: 4 })])
    expect(dlg().getAttribute('aria-modal')).toBe('true')
    expect(m!.q('.dialog-scrim')!.contains(dlg())).toBe(true)
    expect(m!.q('.dialog-title')!.textContent).toBe('두 기기에서 고친 페이지가 있어요')
    expect(dlg().getAttribute('aria-labelledby')).toBe(m!.q('.dialog-title')!.id)
    expect(m!.q('.conflict-progress span')!.textContent).toBe('3페이지 · 1/2')
    expect(m!.q('.conflict-question')!.textContent).toBe('어느 쪽을 남길까요?')
    expect(m!.qa('.conflict-tag').map((x) => x.textContent)).toEqual(['이 기기', '다른 기기'])
    expect(m!.qa('.conflict-when').map((x) => x.textContent)).toEqual([expect.stringContaining('Phone · '), expect.stringContaining('Laptop · ')])
    expect(buttons().map(label)).toEqual([
      '이전 충돌 페이지', '다음 충돌 페이지', '이 기기 버전', '다른 기기 버전', '둘 다 남기기',
      '나머지 모두 이 기기 버전', '나머지 모두 다른 기기 버전', '나중에 결정',
    ])
    expect(m!.q('.conflict-note')!.textContent).toBe('고르지 않은 버전은 30일 동안 버전 기록에서 되살릴 수 있어요.')
    // the left preview is this device, the right one the other device
    expect(m!.qa('.conflict-side').map((x) => x.getAttribute('data-side'))).toEqual(['this', 'other'])
    expect(m!.qa('canvas').map((c) => c.getAttribute('aria-label'))).toEqual(['3페이지 이 기기 버전', '3페이지 다른 기기 버전'])
  })

  test('en', () => {
    open([item(PA), item(PB)], {}, 'en')
    expect(m!.q('.dialog-title')!.textContent).toBe('Pages edited on both devices')
    expect(buttons().map(label)).toEqual([
      'Previous conflict page', 'Next conflict page', 'This device version', 'Other device version', 'Keep both',
      'Rest: all this device version', 'Rest: all other device version', 'Decide later',
    ])
  })

  test('default focus is [둘 다 남기기]; one conflict has no "rest" buttons', () => {
    open([item(PA)])
    expect(document.activeElement).toBe(byText('둘 다 남기기'))
    expect(buttons().map((b) => b.textContent)).not.toContain('나머지 모두 이 기기 버전')
  })

  test('"더 최근" goes to the later side only; the other device time is the revision time when there is one', () => {
    open([item(PA, 'bothEdited', { mineAt: '2026-10-11T04:20:00.000Z', theirsAt: '2026-10-10T04:20:00.000Z', otherTime: null })])
    expect(m!.qa('.conflict-newer').map((x) => x.closest('.conflict-side')!.getAttribute('data-side'))).toEqual(['this'])
    m!.unmount()
    // the revision time wins over the page's editedAt
    open([item(PA, 'bothEdited', { mineAt: '2026-10-11T04:20:00.000Z', theirsAt: '2026-10-10T04:20:00.000Z', otherTime: '2026-10-12T00:00:00.000Z' })])
    expect(m!.qa('.conflict-newer').map((x) => x.closest('.conflict-side')!.getAttribute('data-side'))).toEqual(['other'])
    m!.unmount()
    open([item(PA, 'bothEdited', { mineAt: '2026-10-11T04:20:00.000Z', theirsAt: '2026-10-11T04:20:00.000Z' })])
    expect(m!.qa('.conflict-newer')).toHaveLength(0)
  })

  test('buttons wrap and nothing clips: the stylesheet lets the rows wrap and the labels break', () => {
    const css = readFileSync('src/ui/app.css', 'utf8')
    for (const sel of ['.conflict-sides', '.conflict-rest', '.conflict-progress']) {
      expect(css).toMatch(new RegExp(`${sel.replace('.', '\\.')} \\{[^}]*flex-wrap: wrap`))
    }
    expect(css).toMatch(/\.conflict-sheet \.btn \{[^}]*white-space: normal/)
    expect(css).toMatch(/\.dialog\.conflict-sheet \{[^}]*overflow-y: auto/)
    // the colors come from the conflict-sheet tokens
    for (const t of ['scrim', 'background', 'tag-background', 'primary-background', 'version-button-border']) expect(css).toContain(`--components-conflict-sheet-${t}`)
  })

  test('every string exists in ko and en with equal key sets', () => {
    const keys = Object.keys(resources.ko).filter((k) => k.startsWith('conflict.'))
    expect(keys.length).toBeGreaterThan(25)
    for (const k of keys) expect(resources.en[k as keyof typeof resources.en]).toBeTruthy()
    expect(Object.keys(resources.en).sort()).toEqual(Object.keys(resources.ko).sort())
  })
})

describe('choosing', () => {
  test('the three buttons apply mine / theirs / both to the shown page', async () => {
    const a = item(PA)
    const { onResolve } = open([a, item(PB)])
    press('이 기기 버전')
    press('다른 기기 버전')
    press('둘 다 남기기')
    expect(onResolve.mock.calls.map((c) => [c[0][0]![0].entry.pageId, c[0][0]![1]])).toEqual([[PA, 'mine']])
    await settle()
  })

  test('after a choice the dialog goes to the next conflict page and focuses the primary button; the last one closes it', async () => {
    const { onClose } = open([item(PA, 'bothEdited', { index: 0 }), item(PB, 'bothEdited', { index: 1 })])
    press('둘 다 남기기')
    await settle()
    expect(m!.q('.conflict-progress span')!.textContent).toBe('2페이지 · 1/1')
    expect(document.activeElement).toBe(byText('둘 다 남기기'))
    expect(onClose).not.toHaveBeenCalled()
    press('둘 다 남기기')
    await settle()
    expect(onClose).toHaveBeenCalledWith(true)
  })

  test('the polite words of the editor are announced inside the dialog', async () => {
    open([item(PA), item(PB)], { onResolve: async (c) => ({ settled: new Set([c[0]![0].entry.pageId]), message: '1페이지: 둘 다 남겼어요' }) })
    press('둘 다 남기기')
    await settle()
    const polite = m!.q('[role="status"][aria-live="polite"]')!
    expect(polite.textContent).toBe('1페이지: 둘 다 남겼어요')
  })

  test('nothing settled: the dialog stays on the page, says so (assertive) and nothing else changes', async () => {
    const { onClose } = open([item(PA), item(PB)], { onResolve: async () => ({ settled: new Set(), message: null }) })
    press('이 기기 버전')
    await settle()
    expect(m!.q('[role="alert"]')!.textContent).toBe('정하지 못했어요. 다시 시도해 주세요.')
    expect(m!.q('.conflict-progress span')!.textContent).toBe('1페이지 · 1/2')
    expect(onClose).not.toHaveBeenCalled()
    // and the person can try again
    press('이 기기 버전')
    await settle()
  })

  test('a resolver that throws counts as nothing settled', async () => {
    open([item(PA)], { onResolve: async () => Promise.reject(new Error('x')) })
    press('둘 다 남기기')
    await settle()
    expect(m!.q('[role="alert"]')!.textContent).not.toBe('')
  })

  test('while busy a second press and Esc are ignored', async () => {
    let release: (o: ResolveOutcome) => void = () => {}
    const { onResolve, onClose } = open([item(PA)], { onResolve: () => new Promise((r) => (release = r)) })
    press('둘 다 남기기')
    press('둘 다 남기기')
    key('Escape')
    expect(onResolve).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(dlg().getAttribute('aria-busy')).toBe('true')
    release({ settled: new Set([PA]), message: null })
    await settle()
    expect(onClose).toHaveBeenCalledWith(true)
  })
})

describe('the deleted-page variants', () => {
  test('the other device deleted it: placeholder on the right, [이 버전 남기기] is primary and focused, [페이지 지우기] beside it', async () => {
    const { onResolve } = open([item(PA, 'remoteDeleted')])
    expect(m!.q('[data-side="other"] .conflict-deleted')!.textContent).toBe('다른 기기에서 지운 페이지')
    expect(m!.q('[data-side="this"] canvas')).not.toBeNull()
    expect(buttons().map((b) => b.textContent)).not.toContain('둘 다 남기기')
    const keep = byText('이 버전 남기기')
    expect(document.activeElement).toBe(keep)
    expect(keep.classList.contains('conflict-primary')).toBe(true)
    expect(byText('페이지 지우기').classList.contains('conflict-version')).toBe(true)
    expect(m!.q('[data-side="this"]')!.contains(keep)).toBe(true) // the side that still has the page keeps it
    press('페이지 지우기')
    expect(onResolve.mock.calls[0]![0][0]![1]).toBe('remove')
    await settle()
  })

  test('this device deleted it: placeholder on the left, keep on the right and focused', () => {
    open([item(PA, 'localDeleted')])
    expect(m!.q('[data-side="this"] .conflict-deleted')!.textContent).toBe('이 기기에서 지운 페이지')
    expect(m!.q('[data-side="other"]')!.contains(byText('이 버전 남기기'))).toBe(true)
    expect(document.activeElement).toBe(byText('이 버전 남기기'))
    expect(m!.q('[data-side="this"]')!.contains(byText('페이지 지우기'))).toBe(true)
  })

  test('no "더 최근" on a deleted page; English words', () => {
    open([item(PA, 'remoteDeleted')], {}, 'en')
    expect(m!.q('.conflict-newer')).toBeNull()
    expect(m!.q('.conflict-deleted')!.textContent).toBe('Page deleted on another device')
    expect(buttons().map((b) => b.textContent)).toEqual(expect.arrayContaining(['Keep this version', 'Delete page']))
  })

  test('choiceFor follows the side pointed at', () => {
    const a = item(PA)
    const r = item(PA, 'remoteDeleted')
    const l = item(PA, 'localDeleted')
    expect([choiceFor(a, true), choiceFor(a, false)]).toEqual(['mine', 'theirs'])
    expect([choiceFor(r, true), choiceFor(r, false)]).toEqual(['keep', 'remove'])
    expect([choiceFor(l, true), choiceFor(l, false)]).toEqual(['remove', 'keep'])
  })
})

describe('"rest" buttons (two steps in place)', () => {
  const three = () => [item(PA), item(PB, 'remoteDeleted', { index: 1 }), item('p3', 'localDeleted', { index: 2 })]

  test('the first press relabels the button, the second applies the pointed side to every remaining conflict', async () => {
    const { onResolve } = open(three())
    press('나머지 모두 이 기기 버전')
    expect(onResolve).not.toHaveBeenCalled()
    expect(buttons().map((b) => b.textContent)).toContain('한 번 더 누르면 3페이지에 적용돼요')
    expect(m!.q('[role="status"][aria-live="polite"]')!.textContent).toBe('한 번 더 누르면 3페이지에 적용돼요')
    press('한 번 더 누르면 3페이지에 적용돼요')
    expect(onResolve).toHaveBeenCalledTimes(1)
    expect(onResolve.mock.calls[0]![0].map(([i, c]) => [i.entry.pageId, c])).toEqual([[PA, 'mine'], [PB, 'keep'], ['p3', 'remove']])
    await settle()
  })

  test('"다른 기기 버전": a page the other device deleted is deleted', async () => {
    const { onResolve } = open(three())
    press('나머지 모두 다른 기기 버전')
    press('한 번 더 누르면 3페이지에 적용돼요')
    expect(onResolve.mock.calls[0]![0].map(([, c]) => c)).toEqual(['theirs', 'remove', 'keep'])
    await settle()
  })

  test('pressing the other "rest" button arms that one instead; a press elsewhere takes the question back', () => {
    const { onResolve } = open(three())
    press('나머지 모두 이 기기 버전')
    press('나머지 모두 다른 기기 버전')
    expect(onResolve).not.toHaveBeenCalled()
    expect(buttons().filter((b) => b.textContent === '한 번 더 누르면 3페이지에 적용돼요')).toHaveLength(1)
    act(() => void dlg().querySelector('.conflict-question')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(buttons().map((b) => b.textContent)).toEqual(expect.arrayContaining(['나머지 모두 이 기기 버전', '나머지 모두 다른 기기 버전']))
    expect(onResolve).not.toHaveBeenCalled()
  })

  test('moving to another conflict page takes the question back', () => {
    open(three())
    press('나머지 모두 이 기기 버전')
    act(() => void m!.q<HTMLButtonElement>('button[aria-label="다음 충돌 페이지"]')!.click())
    expect(buttons().map((b) => b.textContent)).toContain('나머지 모두 이 기기 버전')
  })

  test('English words', () => {
    open(three(), {}, 'en')
    press('Rest: all this device version')
    expect(buttons().map((b) => b.textContent)).toContain('Press again to apply to 3 pages')
  })
})

describe('keyboard', () => {
  test('Esc and [나중에 결정] close without choosing', () => {
    const { onResolve, onClose } = open([item(PA)])
    key('Escape')
    expect(onClose).toHaveBeenLastCalledWith(false)
    press('나중에 결정')
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(onResolve).not.toHaveBeenCalled()
  })

  test('‹ › and the arrow keys move between conflict pages; the ends do nothing', () => {
    open([item(PA, 'bothEdited', { index: 0 }), item(PB, 'bothEdited', { index: 5 })])
    const progress = () => m!.q('.conflict-progress span')!.textContent
    expect(m!.q('button[aria-label="이전 충돌 페이지"]')!.getAttribute('aria-disabled')).toBe('true')
    key('ArrowLeft')
    expect(progress()).toBe('1페이지 · 1/2')
    key('ArrowRight')
    expect(progress()).toBe('6페이지 · 2/2')
    expect(document.activeElement).toBe(byText('둘 다 남기기'))
    key('ArrowRight')
    expect(progress()).toBe('6페이지 · 2/2')
    act(() => void m!.q<HTMLButtonElement>('button[aria-label="이전 충돌 페이지"]')!.click())
    expect(progress()).toBe('1페이지 · 1/2')
    act(() => void m!.q<HTMLButtonElement>('button[aria-label="다음 충돌 페이지"]')!.click())
    expect(progress()).toBe('6페이지 · 2/2')
  })

  test('Tab stays inside the dialog both ways', () => {
    open([item(PA)])
    const all = buttons()
    all.at(-1)!.focus()
    key('Tab')
    expect(document.activeElement).toBe(all[0])
    key('Tab', { shiftKey: true })
    expect(document.activeElement).toBe(all.at(-1))
  })

  test('buttons are aria-disabled, not disabled, so focus never leaves the trap', async () => {
    open([item(PA)], { onResolve: () => new Promise(() => {}) })
    press('둘 다 남기기')
    expect(buttons().every((b) => !b.disabled)).toBe(true)
    expect(byText('둘 다 남기기').getAttribute('aria-disabled')).toBe('true')
  })
})

describe('the previews', () => {
  test('the elements the other version lacks are outlined on each side (status-warning outline token)', () => {
    open([item(PA)])
    // mine has m2, theirs has t1: one outline per preview
    expect(drawn.filter((d) => d.startsWith('strokeRect:'))).toHaveLength(2)
  })

  test('identical element sets draw no outline', () => {
    const same = item(PA)
    same.current = { ...same.sidecar.page, rev: 'other' }
    open([same])
    expect(drawn.filter((d) => d.startsWith('strokeRect:'))).toHaveLength(0)
  })

  test('changedRange is the box around the strokes the other page lacks (half the width around each point)', () => {
    const a = page(PA, ['x', 'y'])
    const b = page(PA, ['x'])
    expect(changedRange(a, b)).toEqual({ x: 0, y: 1, w: 2, h: 2 }) // stroke() has one point (1,2) of width 2
    expect(changedRange(a, a)).toBeNull()
    expect(changedRange(a, null)).not.toBeNull()
    expect(changedRange({ ...a, elements: [{ id: 'z', type: 'image' }] } as never, b)).toBeNull()
  })
})

describe('the other device time', () => {
  const rev = (...times: string[]) => async () => times.map((t, i) => ({ id: `r${i}`, modifiedTime: t }))
  test('the latest revision time of the file', async () => {
    const f = createOtherTime({ drive: { listRevisions: rev('2026-10-10T00:00:00.000Z', '2026-10-12T00:00:00.000Z', '2026-10-11T00:00:00.000Z') }, online: () => true })
    expect(await f('file')).toBe('2026-10-12T00:00:00.000Z')
  })
  test('offline, no file, an error: null, and no request offline', async () => {
    const listRevisions = vi.fn(rev('2026-10-10T00:00:00.000Z'))
    expect(await createOtherTime({ drive: { listRevisions }, online: () => false })('file')).toBeNull()
    expect(listRevisions).not.toHaveBeenCalled()
    expect(await createOtherTime({ drive: { listRevisions }, online: () => true })(null)).toBeNull()
    expect(await createOtherTime({ drive: { listRevisions: async () => Promise.reject(new Error('x')) }, online: () => true })('file')).toBeNull()
  })
  test('a slow answer is given up after 3 s and no timer is left', async () => {
    vi.useFakeTimers()
    try {
      const f = createOtherTime({ drive: { listRevisions: () => new Promise(() => {}) }, online: () => true })
      const p = f('file')
      await vi.advanceTimersByTimeAsync(OTHER_TIME_TIMEOUT_MS)
      expect(await p).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    await tick()
  })
})
