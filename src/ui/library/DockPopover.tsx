import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { useI18n } from '../../i18n'
import type { Dock } from '../../storage/toolbarPosition'
import { PopoverShell } from './PopoverShell'

const DOCKS = [
  { d: 'top', key: 'editor.dockTop', turn: 0 },
  { d: 'right', key: 'editor.dockRight', turn: 90 },
  { d: 'bottom', key: 'editor.dockBottom', turn: 180 },
  { d: 'left', key: 'editor.dockLeft', turn: 270 },
] as const satisfies readonly { d: Dock; key: string; turn: number }[]

/**
 * The handle's position bubble: four icon buttons (top, right, bottom, left; an edge bar plus two bars, as on Android) in a radiogroup.
 * Arrows move between them and stop at the ends. Modal like the other popovers; the owner puts focus back on the handle in onClose.
 */
export function DockPopover({ current, anchor, onPick, onClose }: {
  current: Dock | null
  anchor: HTMLElement | null
  onPick: (d: Dock) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const titleId = useId()
  const btns = useRef<(HTMLButtonElement | null)[]>([])
  const at = Math.max(0, DOCKS.findIndex((x) => x.d === current)) // floating: the first
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => btns.current[at]?.focus(), [])
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0
    if (step) {
      e.preventDefault()
      btns.current[i + step]?.focus()
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onPick(DOCKS[i]!.d)
    }
  }
  return (
    <PopoverShell anchor={anchor} tool=".toolbar-grip" onClose={onClose} labelledBy={titleId} className="pen-popover dock-popover">
      <h2 id={titleId} className="pen-popover-title">
        {t('editor.toolbarPosition')}
      </h2>
      <div className="pen-tool-switch" role="radiogroup" aria-label={t('editor.toolbarPosition')}>
        {DOCKS.map(({ d, key, turn }, i) => (
          <button
            key={d}
            ref={(el) => void (btns.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={current === d}
            aria-label={t(key)}
            title={t(key)}
            tabIndex={i === at ? 0 : -1}
            onClick={() => onPick(d)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path transform={`rotate(${turn} 12 12)`} d="M4 3h16v2H4zM6 7h5v13H6zM13 7h5v8h-5z" fill="currentColor" />
            </svg>
          </button>
        ))}
      </div>
    </PopoverShell>
  )
}
