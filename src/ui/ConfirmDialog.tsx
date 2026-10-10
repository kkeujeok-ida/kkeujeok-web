import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'

interface Props {
  body: string
  confirmLabel: string
  cancelLabel: string
  destructive?: boolean
  busy?: boolean
  error?: ReactNode
  onConfirm: () => void
  onCancel: () => void
}

// Modal confirmation. Focus starts on Cancel, is trapped inside, Esc cancels.
// The caller puts focus back on the button that opened it.
export function ConfirmDialog({ body, confirmLabel, cancelLabel, destructive, busy, error, onConfirm, onCancel }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const bodyId = useId()
  useEffect(() => cancel.current?.focus(), [])
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (!busy) onCancel()
    } else if (e.key === 'Tab') {
      const items = [...box.current!.querySelectorAll<HTMLElement>('button')]
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length
      e.preventDefault()
      items[next]?.focus()
    }
  }
  // aria-disabled, not disabled: a disabled button would drop focus out of the trap.
  return (
    <div className="dialog-scrim" onKeyDown={onKeyDown}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-describedby={bodyId} aria-label={confirmLabel}>
        <p id={bodyId}>{body}</p>
        <div aria-live="polite" className="dialog-error">
          {error}
        </div>
        <div className="dialog-actions">
          <button ref={cancel} type="button" className="btn" aria-disabled={busy} onClick={() => !busy && onCancel()}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive ? 'btn btn-destructive' : 'btn'}
            aria-disabled={busy}
            aria-busy={busy}
            onClick={() => !busy && onConfirm()}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
