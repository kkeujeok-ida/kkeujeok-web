import type { KeyboardEvent } from 'react'
import { useI18n, type Key } from '../../i18n'
import type { PageViewMode } from '../../storage/viewMode'

// spec/page-view.md "Icons": the same `d` strings as the Android client.
const D = {
  scroll: 'M6 3H18V21H6ZM15 6V12',
  turn: 'M6 3H14L18 7V21H6ZM14 3V7H18',
  vertical: 'M12 4V20M8 8L12 4L16 8M8 16L12 20L16 16',
  horizontal: 'M4 12H20M8 8L4 12L8 16M16 8L20 12L16 16',
  pages1: 'M7 4H17V20H7Z',
  pages2: 'M3 4H11V20H3ZM13 4H21V20H13Z',
}
const STROKE = { stroke: 'currentColor', strokeWidth: 1.75, fill: 'none', strokeLinejoin: 'round', strokeLinecap: 'round' } as const

/** The top-bar button icon: the current combination (pages, fold mark for turn, direction badge). */
export function ViewComboIcon({ mode }: { mode: PageViewMode }) {
  const two = mode.pages === 2
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" {...STROKE}>
      <path d={two ? D.pages2 : D.pages1} />
      {mode.pagination === 'turn' && <path d={two ? 'M17 4V8H21' : 'M13 4V8H17'} />}
      <path d="M11 11H23V23H11Z" fill="var(--components-editor-corner-background)" stroke="none" />
      <path d={D[mode.direction]} transform="translate(11 11) scale(0.5)" strokeWidth={3.5} />
    </svg>
  )
}

type Row = { label: Key; items: { d: string; key: Key; on: boolean; patch: Partial<PageViewMode> }[] }

/** Popover of three icon-only segmented rows; [mode] is the stored one, [phone] hides the pages row. */
export function ViewOptionsPopover({ mode, phone, onChange, onClose }: { mode: PageViewMode; phone: boolean; onChange: (p: Partial<PageViewMode>) => void; onClose: () => void }) {
  const { t } = useI18n()
  const rows: Row[] = [
    { label: 'editor.viewPagination', items: [
      { d: D.scroll, key: 'editor.viewScroll', on: mode.pagination === 'scroll', patch: { pagination: 'scroll' } },
      { d: D.turn, key: 'editor.viewTurn', on: mode.pagination === 'turn', patch: { pagination: 'turn' } },
    ] },
    { label: 'editor.viewDirection', items: [
      { d: D.vertical, key: 'editor.viewVertical', on: mode.direction === 'vertical', patch: { direction: 'vertical' } },
      { d: D.horizontal, key: 'editor.viewHorizontal', on: mode.direction === 'horizontal', patch: { direction: 'horizontal' } },
    ] },
    ...(phone ? [] : [{ label: 'editor.viewPagesRow' as Key, items: [
      { d: D.pages1, key: 'editor.viewPages1' as Key, on: mode.pages === 1, patch: { pages: 1 } as Partial<PageViewMode> },
      { d: D.pages2, key: 'editor.viewPages2' as Key, on: mode.pages === 2, patch: { pages: 2 } as Partial<PageViewMode> },
    ] }]),
  ]
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      return onClose()
    }
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    const btns = [...(e.target as HTMLElement).closest('[role="group"]')!.querySelectorAll<HTMLButtonElement>('button')]
    btns[(btns.indexOf(e.target as HTMLButtonElement) + step + btns.length) % btns.length]?.focus()
    e.preventDefault()
  }
  return (
    <div role="dialog" aria-label={t('editor.viewOptions')} className="editor-menu view-options" onKeyDown={onKey}>
      {rows.map((r) => (
        <div key={r.label} role="group" aria-label={t(r.label)} className="view-options-row">
          {r.items.map((i) => (
            <button key={i.key} type="button" className="toolbar-action" aria-label={t(i.key)} title={t(i.key)} aria-pressed={i.on} onClick={() => onChange(i.patch)}>
              <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" {...STROKE}>
                <path d={i.d} />
              </svg>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
