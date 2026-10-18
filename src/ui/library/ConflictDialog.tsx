// The conflict resolve dialog (Story 3.22, UX-DR43): the two versions of a page side by side, one choice per page.
// Modal: focus starts on the primary button and stays inside, Esc is [나중에 결정]. It only asks; the editor applies
// the choices (`onResolve`) and says which pages are settled.
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { fmt, useI18n, type Key } from '../../i18n'
import type { Page } from '../../model/note'
import { changedRange } from '../../render/changedRange'
import { StrokePathCache, fitViewport, paintPage } from '../../render/pagePainter'
import type { Conflict, Sidecar } from '../../sync/merge'

/** One unresolved conflict as the dialog shows it. */
export type ConflictItem = {
  /** The `sync.json` entry. */
  entry: Conflict
  /** This device's version: `sidecar.page`. */
  sidecar: Sidecar
  /** The page of the note now (the other device's version); null when the note has none (`remoteDeleted`). */
  current: Page | null
  /** When the other device's version was uploaded (ISO); null offline, then the page's `editedAt` stands in. */
  otherTime: string | null
}

export const pageNo = (i: ConflictItem) => i.entry.originalIndex + 1
export const isDeleted = (i: ConflictItem) => i.entry.kind !== 'bothEdited'

/** The `resolveConflict` choice for "this device" / "the other device"; a deleted page follows the side pointed at. */
export function choiceFor(i: ConflictItem, thisDevice: boolean): string {
  if (i.entry.kind === 'bothEdited') return thisDevice ? 'mine' : 'theirs'
  if (i.entry.kind === 'remoteDeleted') return thisDevice ? 'keep' : 'remove'
  return thisDevice ? 'remove' : 'keep'
}

/** What the editor answers: the pages that are settled (by page id) and the polite words for them. */
export type ResolveOutcome = { settled: ReadonlySet<string>; message: string | null }

const RESULT_KEY: Record<string, Key> = {
  mine: 'conflict.resolvedThis',
  theirs: 'conflict.resolvedOther',
  both: 'conflict.resolvedBoth',
  remove: 'conflict.resolvedRemove',
  keep: 'conflict.resolvedKeep',
}
export const resultKey = (choice: string): Key => RESULT_KEY[choice] ?? 'conflict.resolvedKeep'

const ratioOf = (w: number, h: number) => {
  const r = w / h
  return Number.isFinite(r) && r > 0 ? Math.min(2.5, Math.max(0.4, r)) : 1
}

/** A page fitted into its box, with the thin outline around what the other version lacks. */
function Preview({ page, other, label }: { page: Page; other: Page | null; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const cache = new StrokePathCache()
    const draw = () => {
      try {
        const r = c.getBoundingClientRect()
        if (!(r.width > 0 && r.height > 0)) return // not laid out yet; the observer calls again
        const dpr = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
        c.width = Math.max(1, Math.round(r.width * dpr))
        c.height = Math.max(1, Math.round(r.height * dpr))
        const ctx = c.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const vp = fitViewport(r.width, r.height, page.width, page.height)
        paintPage(ctx, page, vp, cache)
        const range = changedRange(page, other)
        if (!range) return
        ctx.save()
        ctx.translate(vp.offsetX, vp.offsetY)
        ctx.scale(vp.scale, vp.scale)
        const css = getComputedStyle(c).getPropertyValue('--components-conflict-sheet-change-outline').trim()
        ctx.strokeStyle = css || 'currentColor'
        ctx.lineWidth = 1.5 / vp.scale
        ctx.strokeRect(range.x - 4, range.y - 4, range.w + 8, range.h + 8)
        ctx.restore()
      } catch {
        // an empty preview
      }
    }
    draw()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null
    ro?.observe(c)
    return () => ro?.disconnect()
  }, [page, other])
  const k = ratioOf(page.width, page.height)
  return (
    <div className="conflict-preview" style={{ aspectRatio: String(k), width: `min(100%, calc(var(--spacing-cover-column-min) * ${1.5 * k}))` }}>
      <canvas ref={ref} role="img" aria-label={label} />
    </div>
  )
}

export function ConflictDialog({
  items,
  skipped = 0,
  onResolve,
  onClose,
}: {
  items: readonly ConflictItem[]
  /** Unresolved conflicts that could not be shown (no sidecar or page): they remain after these are settled. */
  skipped?: number
  /** Settles the choices in order; the first failure stops the rest. */
  onResolve: (choices: [ConflictItem, string][]) => Promise<ResolveOutcome>
  /** `done`: every conflict is settled. Otherwise [나중에 결정] / Esc. */
  onClose: (done: boolean) => void
}) {
  const { t, locale } = useI18n()
  const [list, setList] = useState<ConflictItem[]>(() => [...items])
  const [pos, setPos] = useState(0)
  const [busy, setBusy] = useState(false)
  // The "rest" button pressed once: true = this device, false = the other device.
  const [confirm, setConfirm] = useState<boolean | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const primary = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  const titleId = useId()
  const n = list.length
  const item = list[Math.min(pos, n - 1)]

  useEffect(() => {
    mounted.current = true
    return () => void (mounted.current = false)
  }, [])
  // The primary button has focus when the dialog opens and whenever another conflict page comes up.
  const key = item ? `${item.entry.pageId}:${item.entry.rev}` : ''
  useEffect(() => {
    primary.current?.focus()
  }, [key])

  if (!item) return null

  const go = (to: number) => {
    if (busy || to < 0 || to >= n) return
    setPos(to)
    setConfirm(null)
  }

  async function apply(choices: [ConflictItem, string][]) {
    if (busy) return
    setBusy(true)
    setConfirm(null)
    setError('')
    let out: ResolveOutcome = { settled: new Set(), message: null }
    try {
      out = await onResolve(choices)
    } catch {
      // nothing settled
    }
    if (!mounted.current) return
    setBusy(false)
    const left = list.filter((i) => !out.settled.has(i.entry.pageId))
    setList(left)
    setPos((p) => Math.max(0, Math.min(p, left.length - 1)))
    if (out.message) setStatus(out.message)
    if (out.settled.size < choices.length) setError(t('conflict.resolveFailed'))
    else if (left.length === 0) onClose(true)
  }

  const pick = (choice: string) => void apply([[item, choice]])
  const rest = (thisDevice: boolean) => {
    if (busy) return
    if (confirm !== thisDevice) return setConfirm(thisDevice)
    void apply(list.map((i): [ConflictItem, string] => [i, choiceFor(i, thisDevice)]))
  }

  const onKeyDown = (e: ReactKeyEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (!busy) onClose(false)
    } else if (e.key === 'Tab') {
      const els = [...box.current!.querySelectorAll<HTMLElement>('button')]
      const i = els.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i + 1) % els.length
      e.preventDefault()
      els[next]?.focus()
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      go(pos + (e.key === 'ArrowLeft' ? -1 : 1))
    }
  }

  // A press anywhere but on a "rest" button takes the question back.
  const onPointerDown = (e: ReactPointerEvent) => {
    if (confirm !== null && !(e.target as HTMLElement).closest('[data-rest]')) setConfirm(null)
  }

  const fmtTime = (iso: string | null | undefined) => {
    const d = iso ? new Date(iso) : null
    if (!d || Number.isNaN(d.getTime())) return ''
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d)
    } catch {
      return ''
    }
  }

  const deleted = isDeleted(item)
  const mine = item.entry.kind === 'localDeleted' ? null : item.sidecar.page
  const theirs = item.entry.kind === 'remoteDeleted' ? null : item.current
  const mineAt = item.sidecar.editedAt
  const theirsAt = item.otherTime ?? item.current?.editedAt ?? null
  const newer = (thisDevice: boolean) => {
    if (deleted) return false
    const a = Date.parse(mineAt)
    const b = Date.parse(theirsAt ?? '')
    if (Number.isNaN(a) || Number.isNaN(b)) return false
    return thisDevice ? a > b : b > a
  }

  const side = (thisDevice: boolean, button: ReactNode) => {
    const page = thisDevice ? mine : theirs
    const tag = t(thisDevice ? 'conflict.tagThis' : 'conflict.tagOther')
    const by = thisDevice ? item.sidecar.editedBy : item.current?.editedBy
    const at = fmtTime(thisDevice ? mineAt : theirsAt)
    return (
      <div className="conflict-side" data-side={thisDevice ? 'this' : 'other'}>
        <span className="conflict-tag">{tag}</span>
        {page ? (
          <Preview page={page} other={thisDevice ? theirs : mine} label={fmt(t('conflict.previewLabel'), { n: pageNo(item), tag })} />
        ) : (
          <div
            className="conflict-deleted"
            style={{ aspectRatio: String(ratioOf((item.current ?? item.sidecar.page).width, (item.current ?? item.sidecar.page).height)) }}
          >
            {t(thisDevice ? 'conflict.deletedHere' : 'conflict.deletedOther')}
          </div>
        )}
        {page && (by || at) && (
          <span className="conflict-when">{by && at ? fmt(t('conflict.editedAt'), { device: by, time: at }) : by || at}</span>
        )}
        {newer(thisDevice) && <span className="conflict-newer">{t('conflict.moreRecent')}</span>}
        {button}
      </div>
    )
  }

  // aria-disabled, not disabled: a disabled button would drop focus out of the trap.
  const version = (text: string, f: () => void) => (
    <button type="button" className="btn conflict-version" aria-disabled={busy} onClick={() => !busy && f()}>
      {text}
    </button>
  )
  const main = (text: string, f: () => void) => (
    <button ref={primary} type="button" className="btn conflict-primary" aria-disabled={busy} onClick={() => !busy && f()}>
      {text}
    </button>
  )
  let left: ReactNode
  let right: ReactNode
  if (!deleted) {
    left = side(true, version(t('conflict.keepThis'), () => pick('mine')))
    right = side(false, version(t('conflict.keepOther'), () => pick('theirs')))
  } else {
    // The side that still has the page keeps it (primary); the side that deleted it offers to delete.
    const keepThis = item.entry.kind === 'remoteDeleted'
    const keep = () => main(t('conflict.keepVersion'), () => pick('keep'))
    const remove = () => version(t('conflict.removePage'), () => pick('remove'))
    left = side(true, keepThis ? keep() : remove())
    right = side(false, keepThis ? remove() : keep())
  }

  const restButton = (thisDevice: boolean) => {
    const armed = confirm === thisDevice
    return (
      <button type="button" data-rest="" className="btn conflict-rest-button" aria-disabled={busy} onClick={() => rest(thisDevice)}>
        {armed ? fmt(t('conflict.restAllConfirm'), { n }) : t(thisDevice ? 'conflict.restAllThis' : 'conflict.restAllOther')}
      </button>
    )
  }

  return (
    <div className="dialog-scrim conflict-scrim" onKeyDown={onKeyDown} onPointerDown={onPointerDown}>
      <div ref={box} className="dialog conflict-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy}>
        <p id={titleId} className="dialog-title">
          {t('conflict.title')}
        </p>
        <div className="conflict-progress">
          <span>{fmt(t('conflict.progress'), { page: pageNo(item), i: Math.min(pos, n - 1) + 1, total: n })}</span>
          <span className="conflict-nav">
            <button type="button" className="btn" aria-label={t('conflict.prev')} title={t('conflict.prev')} aria-disabled={busy || pos === 0} onClick={() => go(pos - 1)}>
              <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.75" fill="none" />
              </svg>
            </button>
            <button type="button" className="btn" aria-label={t('conflict.next')} title={t('conflict.next')} aria-disabled={busy || pos >= n - 1} onClick={() => go(pos + 1)}>
              <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.75" fill="none" />
              </svg>
            </button>
          </span>
        </div>
        <p className="conflict-question">{t('conflict.question')}</p>
        <div className="conflict-sides">
          {left}
          {right}
        </div>
        {!deleted && main(t('conflict.keepBoth'), () => pick('both'))}
        {n >= 2 && (
          <div className="conflict-rest">
            {restButton(true)}
            {restButton(false)}
          </div>
        )}
        <p className="conflict-note">{t('conflict.recoverNote')}</p>
        {skipped > 0 && <p className="conflict-note">{fmt(t('conflict.skipped'), { n: skipped })}</p>}
        <div role="alert" className="dialog-error">
          {error}
        </div>
        <button type="button" className="btn conflict-later" aria-disabled={busy} onClick={() => !busy && onClose(false)}>
          {t('conflict.later')}
        </button>
        <div role="status" aria-live="polite" className="sr-only">
          {confirm !== null ? fmt(t('conflict.restAllConfirm'), { n }) : status}
        </div>
      </div>
    </div>
  )
}
