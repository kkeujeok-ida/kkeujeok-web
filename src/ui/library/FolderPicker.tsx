// Asks for a folder: the top level or one of `view` (Story 7.6; Story 7.8 reuses it to move a note).
// Folders in `disabled` are shown but cannot be chosen (a folder and its subfolders when moving it).
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { fmt, useI18n } from '../../i18n'
import type { FolderView, LibraryFolder } from '../../library/folderService'

/** The folders of `view` depth first, each with its depth (0 = top level). */
export function flattenFolders(view: FolderView): { folder: LibraryFolder; depth: number }[] {
  const out: { folder: LibraryFolder; depth: number }[] = []
  const walk = (parent: string, depth: number) => {
    for (const folder of view.childrenOf(parent)) {
      out.push({ folder, depth })
      if (depth <= view.folders.length) walk(folder.id, depth + 1)
    }
  }
  walk('root', 0)
  return out
}

export function FolderPicker({
  name,
  title: given,
  view,
  disabled = new Set(),
  selected,
  onPick,
  onClose,
}: {
  /** The name of what moves, for the title. */
  name: string
  /** Replaces the title built from `name` (a move of several items). */
  title?: string
  view: FolderView
  disabled?: ReadonlySet<string>
  /** The current place (`root` = top level). */
  selected?: string
  /** `root` for the top level. */
  onPick: (id: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button:not([aria-disabled="true"])')?.focus()
  }, [])
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab') {
      const items = [...box.current!.querySelectorAll<HTMLElement>('button:not([aria-disabled="true"])')]
      const i = items.indexOf(document.activeElement as HTMLElement)
      const step = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1
      e.preventDefault()
      items[(i + step + items.length) % items.length]?.focus()
    }
  }
  const rows = [{ id: 'root', label: t('folder.topLevel'), depth: 0 }, ...flattenFolders(view).map(({ folder, depth }) => ({ id: folder.id, label: folder.name, depth: depth + 1 }))]
  const title = given ?? fmt(t('folder.moveTitle'), { name })
  return (
    <div className="dialog-scrim" onKeyDown={onKeyDown}>
      <div ref={box} className="dialog folder-picker" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="folder-picker-title">{title}</h2>
        <ul className="folder-picker-list">
          {rows.map((r) => {
            const off = disabled.has(r.id)
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className="btn folder-picker-item"
                  style={{ paddingInlineStart: `calc(var(--spacing-3) + ${r.depth} * var(--spacing-4))` }}
                  aria-disabled={off || undefined}
                  aria-current={selected === r.id ? 'true' : undefined}
                  onClick={() => !off && onPick(r.id)}
                >
                  {r.label}
                </button>
              </li>
            )
          })}
        </ul>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('library.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
