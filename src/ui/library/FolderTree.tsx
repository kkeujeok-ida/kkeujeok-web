// The folder tree of the sidebar (Story 7.6, 18.5): "모든 노트", the top level and the folders below it. A folder has a context menu
// (right-click, Shift+F10 / the menu key, long press: rename, move, delete), drag and drop to move, and an undo snackbar.
// Arrow keys move through the tree; there are no F2 / Delete keys here.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { fmt, useI18n } from '../../i18n'
import type { FolderResult, FolderService, FolderView } from '../../library/folderService'
import { ConfirmDialog } from '../ConfirmDialog'
import { FolderPicker } from './FolderPicker'
import { NameDialog } from './NameDialog'

/** The top level (the root folder); also the target of a move to the top level. */
const ALL = 'root'
/** The "모든 노트" row: every note, folders ignored. It is no folder and no move target. */
export const ALL_NOTES = 'all'
const LONG_PRESS_MS = 500
const UNDO_MS = 5000
/** The drag type of a note card (Story 7.8); its data is `{noteId, title}` as JSON. */
export const NOTE_DRAG = 'application/x-kkeujeok-note'

type Dialog = { kind: 'rename'; id: string } | { kind: 'move'; id: string }

const icon = (d: string) => (
  <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} stroke="currentColor" strokeWidth="1.5" fill="none" />
  </svg>
)
export const FOLDER_ICON = 'M2 4.5h4l1.5 1.5H14v6.5H2z'

export function FolderTree({
  view,
  service,
  current,
  onSelect,
}: {
  view: FolderView
  service: FolderService
  /** The row being looked at: `all` ("모든 노트"), `root` (the top level) or a folder id. */
  current: string
  onSelect: (id: string) => void
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [focusId, setFocusId] = useState(current)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; inverse?: FolderResult['inverse'] } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const toFocus = useRef<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const longPressed = useRef(false)

  // The folder being looked at is shown: its ancestors open.
  useEffect(() => {
    if (current === ALL || current === ALL_NOTES) return
    setExpanded((prev) => {
      const next = new Set(prev)
      for (let p = view.folder(current)?.parentId, n = 0; p && p !== ALL && n <= view.folders.length; n++) {
        next.add(p)
        p = view.folder(p)?.parentId
      }
      return next.size === prev.size ? prev : next
    })
  }, [current, view])

  useEffect(() => {
    if (!toFocus.current) return
    const id = toFocus.current
    root.current && [...root.current.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) => el.dataset.id === id)?.focus()
    toFocus.current = null
  })

  useEffect(() => {
    if (!note) return
    const id = setTimeout(() => setNote(null), UNDO_MS)
    return () => clearTimeout(id)
  }, [note])

  // The menu starts on its first item.
  useEffect(() => {
    if (menu) list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [menu?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // A menu closes when the pointer goes elsewhere.
  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.tree-menu')) setMenu(null)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [menu])

  const rows: { id: string; depth: number }[] = [{ id: ALL_NOTES, depth: 1 }, { id: ALL, depth: 1 }]
  const walk = (parent: string, depth: number) => {
    for (const f of view.childrenOf(parent)) {
      rows.push({ id: f.id, depth })
      if (expanded.has(f.id) && depth <= view.folders.length) walk(f.id, depth + 1)
    }
  }
  walk(ALL, 2)
  const active = rows.some((r) => r.id === focusId) ? focusId : current

  const focusRow = (id: string) => {
    toFocus.current = id
    setFocusId(id)
  }
  const toggle = (id: string, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  const select = (id: string) => onSelect(id)

  async function move(id: string, target: string) {
    const r = await service.moveFolder(id, target)
    if (r.error) return // a cycle or a vanished target: ignored
    if (r.inverse) setNote({ text: fmt(t('folder.moved'), { name: view.folder(id)?.name ?? '' }), inverse: r.inverse })
    if (target !== ALL) toggle(target, true)
  }

  /** A note card dropped on `target` (Story 7.8). */
  async function moveNote(noteId: string, title: string, target: string) {
    const r = await service.moveNote(noteId, target)
    if (r.error) return setNote({ text: t('folder.failed') })
    if (r.inverse) setNote({ text: fmt(t(target === ALL ? 'folder.noteMovedTop' : 'folder.noteMoved'), { name: title, folder: view.folder(target)?.name ?? '' }), inverse: r.inverse })
    if (target !== ALL) toggle(target, true)
  }

  function onKeyDown(e: KeyboardEvent) {
    const el = e.target as HTMLElement
    if (el.closest('[role="menu"]') || el.closest('.tree-menu') || !(el.getAttribute('role') === 'treeitem')) return
    const id = el.dataset.id!
    const i = rows.findIndex((r) => r.id === id)
    const kids = id === ALL_NOTES ? [] : view.childrenOf(id)
    const go = (n: number) => void (e.preventDefault(), focusRow(rows[Math.max(0, Math.min(rows.length - 1, n))]!.id))
    switch (e.key) {
      case 'ArrowDown':
        return go(i + 1)
      case 'ArrowUp':
        return go(i - 1)
      case 'Home':
        return go(0)
      case 'End':
        return go(rows.length - 1)
      case 'ArrowRight':
        e.preventDefault()
        if (kids.length === 0) return
        return id === ALL || expanded.has(id) ? focusRow(kids[0]!.id) : toggle(id, true)
      case 'ArrowLeft':
        e.preventDefault()
        if (id !== ALL && id !== ALL_NOTES && expanded.has(id) && kids.length > 0) return toggle(id, false)
        return void (id !== ALL && id !== ALL_NOTES && focusRow(view.folder(id)?.parentId ?? ALL))
      case 'Enter':
      case ' ':
        e.preventDefault()
        return select(id)
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) return
        e.preventDefault()
        if (id !== ALL && id !== ALL_NOTES) {
          const r = el.getBoundingClientRect()
          setMenu({ id, x: r.left + r.width / 2, y: r.bottom })
        }
    }
  }

  function renderRow(id: string, depth: number) {
    const folder = view.folder(id)
    const isAllNotes = id === ALL_NOTES
    const isTop = id === ALL
    const plain = isAllNotes || isTop // no folder: no menu, no dragging
    const label = isAllNotes ? t('folder.allNotes') : isTop ? t('folder.topLevel') : folder!.name
    const kids = isAllNotes ? [] : view.childrenOf(id)
    const open = isTop || expanded.has(id)
    const canDrop = !isAllNotes && dragId !== null && dragId !== id && !view.isInside(id, dragId)
    return (
      <li
        key={id}
        role="treeitem"
        data-id={id}
        aria-level={depth}
        aria-selected={current === id}
        aria-expanded={kids.length > 0 && !isAllNotes ? open : undefined}
        tabIndex={active === id ? 0 : -1}
        onFocus={(e) => e.target === e.currentTarget && setFocusId(id)}
      >
        <div
          className={`tree-row${current === id ? ' is-current' : ''}${over === id ? ' is-over' : ''}`}
          style={{ paddingInlineStart: `calc(var(--spacing-2) + ${depth - 1} * var(--spacing-4))` }}
          draggable={!plain}
          onClick={() => (longPressed.current ? (longPressed.current = false) : select(id))}
          onContextMenu={(e) => {
            if (plain) return
            e.preventDefault()
            setMenu({ id, x: e.clientX, y: e.clientY })
          }}
          onPointerDown={(e) => {
            if (plain || e.button !== 0) return
            const at = { x: e.clientX, y: e.clientY }
            clearTimeout(press.current?.timer)
            press.current = {
              ...at,
              timer: setTimeout(() => {
                press.current = null
                longPressed.current = true
                setMenu({ id, ...at })
              }, LONG_PRESS_MS),
            }
          }}
          onPointerMove={(e) => {
            const p = press.current
            if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) (clearTimeout(p.timer), (press.current = null))
          }}
          onPointerUp={() => (clearTimeout(press.current?.timer), (press.current = null))}
          onPointerCancel={() => (clearTimeout(press.current?.timer), (press.current = null))}
          onDragStart={(e) => {
            clearTimeout(press.current?.timer)
            press.current = null
            e.dataTransfer.setData('text/plain', id)
            e.dataTransfer.effectAllowed = 'move'
            setDragId(id)
          }}
          onDragEnd={() => (setDragId(null), setOver(null))}
          onDragOver={(e) => {
            if (!canDrop && !(!isAllNotes && dragId === null && e.dataTransfer.types.includes(NOTE_DRAG))) return
            e.preventDefault()
            setOver(id)
          }}
          onDragLeave={() => setOver((o) => (o === id ? null : o))}
          onDrop={(e) => {
            e.preventDefault()
            const raw = dragId === null ? e.dataTransfer.getData(NOTE_DRAG) : ''
            if (raw) {
              setOver(null)
              try {
                const n = JSON.parse(raw) as { noteId: string; title: string }
                void moveNote(n.noteId, n.title, id)
              } catch {
                // not one of ours
              }
              return
            }
            const from = dragId
            setDragId(null)
            setOver(null)
            if (from && canDrop) void move(from, id)
          }}
        >
          {kids.length > 0 && !plain ? (
            <button
              type="button"
              className="btn tree-toggle"
              tabIndex={-1}
              aria-hidden="true"
              onClick={(e) => (e.stopPropagation(), toggle(id, !open))}
            >
              {icon(open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4')}
            </button>
          ) : (
            <span className="tree-toggle" aria-hidden="true" />
          )}
          {icon(isAllNotes ? 'M2 3h12M2 8h12M2 13h12' : FOLDER_ICON)}
          <span className="tree-label">{label}</span>
        </div>
        {kids.length > 0 && open && <ul role="group">{kids.map((k) => renderRow(k.id, depth + 1))}</ul>}
      </li>
    )
  }

  function renderMenu(m: { id: string; x: number; y: number }) {
    const { id } = m
    const row = () => [...(root.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find((el) => el.dataset.id === id)
    const close = () => {
      setMenu(null)
      row()?.focus()
    }
    const pick = (d: Dialog) => {
      opener.current = row() ?? null
      setMenu(null)
      setDialog(d)
    }
    return (
      <div
        ref={list}
        role="menu"
        aria-label={fmt(t('folder.menu'), { name: view.folder(id)?.name ?? '' })}
        className="tree-menu tree-menu-list"
        style={{ position: 'fixed', top: m.y, left: m.x, right: 'auto' }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const items = [...list.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
            const at = items.indexOf(document.activeElement as HTMLElement)
            items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
          }
        }}
      >
        <button type="button" role="menuitem" className="btn" onClick={() => pick({ kind: 'rename', id })}>
          {t('folder.rename')}
        </button>
        <button type="button" role="menuitem" className="btn" onClick={() => pick({ kind: 'move', id })}>
          {t('folder.move')}
        </button>
        <button
          type="button"
          role="menuitem"
          className="btn"
          onClick={() => {
            opener.current = row() ?? null
            setMenu(null)
            setConfirming(id)
          }}
        >
          {t('folder.delete')}
        </button>
      </div>
    )
  }

  const closeDialog = () => {
    setDialog(null)
    requestAnimationFrame(() => (opener.current?.isConnected ? opener.current : root.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]'))?.focus())
  }
  const subtreeOf = (id: string) => new Set(view.folders.filter((f) => view.isInside(f.id, id)).map((f) => f.id))

  return (
    <div ref={root} className="folder-tree">
      <ul role="tree" aria-label={t('folder.tree')} onKeyDown={onKeyDown}>
        {renderRow(ALL_NOTES, 1)}
        {renderRow(ALL, 1)}
      </ul>
      {menu && renderMenu(menu)}
      {confirming && view.folder(confirming) && (
        <ConfirmDialog
          body={view.noteCount(confirming) === 0 ? t('folder.deleteBodyEmpty') : fmt(t('folder.deleteBody'), { n: view.noteCount(confirming) })}
          confirmLabel={t('folder.deleteConfirm')}
          cancelLabel={t('library.cancel')}
          destructive
          onCancel={() => {
            setConfirming(null)
            closeDialog()
          }}
          onConfirm={() => {
            const id = confirming
            setConfirming(null)
            closeDialog()
            void service.deleteFolder(id).then((r) => r.error && setNote({ text: t('folder.failed') }))
          }}
        />
      )}
      {dialog?.kind === 'rename' && view.folder(dialog.id) && (
        <NameDialog title={t('folder.rename')} initial={view.folder(dialog.id)!.name} onClose={closeDialog} onSave={async (name) => (await service.renameFolder(dialog.id, name)).error} />
      )}
      {dialog?.kind === 'move' && view.folder(dialog.id) && (
        <FolderPicker
          name={view.folder(dialog.id)!.name}
          view={view}
          disabled={subtreeOf(dialog.id)}
          selected={view.folder(dialog.id)!.parentId}
          onClose={closeDialog}
          onPick={(target) => {
            const id = dialog.id
            closeDialog()
            void move(id, target)
          }}
        />
      )}
      {note && (
        <div role="status" className="snackbar snackbar-action">
          <span>{note.text}</span>
          {note.inverse && (
            <button
              type="button"
              className="snackbar-button"
              onClick={() => {
                const inverse = note.inverse!
                setNote(null)
                void service.undo(inverse)
              }}
            >
              {t('folder.undo')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
