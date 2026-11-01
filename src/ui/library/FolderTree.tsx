// The folder tree of the sidebar (Story 7.6): "모든 노트" and the folders below it, with the ⋯ menu of a folder
// (new subfolder, rename, move, delete), drag and drop to move, and an undo snackbar. Everything works by keyboard too.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { fmt, useI18n } from '../../i18n'
import type { FolderResult, FolderService, FolderView } from '../../library/folderService'
import { libraryFolderName } from '../../library/libraryRules'
import { FolderPicker } from './FolderPicker'

const ALL = 'root'
const UNDO_MS = 5000

type Dialog = { kind: 'new'; parentId: string } | { kind: 'rename'; id: string } | { kind: 'move'; id: string }

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
  /** The folder being looked at; null = "모든 노트". */
  current: string | null
  onSelect: (id: string | null) => void
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [focusId, setFocusId] = useState(current ?? ALL)
  const [menu, setMenu] = useState<{ id: string; confirm: boolean } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; inverse?: FolderResult['inverse'] } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const toFocus = useRef<string | null>(null)
  // Only one menu is open at a time: its pieces are kept here, not in a component of their own.
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const list = useRef<HTMLDivElement>(null)
  const del = useRef<HTMLButtonElement>(null)

  // The folder being looked at is shown: its ancestors open.
  useEffect(() => {
    if (current === null) return
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

  // Entering the confirm step puts focus on [취소]; the menu itself starts on its first item.
  useEffect(() => {
    if (menu) list.current?.querySelector<HTMLElement>(menu.confirm ? '[data-cancel]' : '[role="menuitem"]')?.focus()
  }, [menu?.id, menu?.confirm]) // eslint-disable-line react-hooks/exhaustive-deps

  // A menu closes when the pointer goes elsewhere.
  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.tree-menu')) setMenu(null)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [menu])

  const rows: { id: string; depth: number }[] = [{ id: ALL, depth: 0 }]
  const walk = (parent: string, depth: number) => {
    for (const f of view.childrenOf(parent)) {
      rows.push({ id: f.id, depth })
      if (expanded.has(f.id) && depth <= view.folders.length) walk(f.id, depth + 1)
    }
  }
  walk(ALL, 2)
  const active = rows.some((r) => r.id === focusId) ? focusId : ALL

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
  const select = (id: string) => onSelect(id === ALL ? null : id)

  async function move(id: string, target: string) {
    const r = await service.moveFolder(id, target)
    if (r.error) return // a cycle or a vanished target: ignored
    if (r.inverse) setNote({ text: fmt(t('folder.moved'), { name: view.folder(id)?.name ?? '' }), inverse: r.inverse })
    if (target !== ALL) toggle(target, true)
  }

  function onKeyDown(e: KeyboardEvent) {
    const el = e.target as HTMLElement
    if (el.closest('[role="menu"]') || el.closest('.tree-menu') || !(el.getAttribute('role') === 'treeitem')) return
    const id = el.dataset.id!
    const i = rows.findIndex((r) => r.id === id)
    const kids = view.childrenOf(id)
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
        if (id !== ALL && expanded.has(id) && kids.length > 0) return toggle(id, false)
        return void (id !== ALL && focusRow(view.folder(id)?.parentId ?? ALL))
      case 'Enter':
      case ' ':
        e.preventDefault()
        return select(id)
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) return
        e.preventDefault()
        if (id !== ALL) setMenu({ id, confirm: false })
    }
  }

  function renderRow(id: string, depth: number) {
    const folder = view.folder(id)
    const isAll = id === ALL
    const label = isAll ? t('folder.allNotes') : folder!.name
    const kids = view.childrenOf(id)
    const open = isAll || expanded.has(id)
    const canDrop = dragId !== null && dragId !== id && !view.isInside(id, dragId)
    return (
      <li
        key={id}
        role="treeitem"
        data-id={id}
        aria-level={depth}
        aria-selected={(current ?? ALL) === id}
        aria-expanded={kids.length > 0 ? open : undefined}
        tabIndex={active === id ? 0 : -1}
        onFocus={(e) => e.target === e.currentTarget && setFocusId(id)}
      >
        <div
          className={`tree-row${(current ?? ALL) === id ? ' is-current' : ''}${over === id ? ' is-over' : ''}`}
          style={{ paddingInlineStart: `calc(var(--spacing-2) + ${depth - 1} * var(--spacing-4))` }}
          draggable={!isAll}
          onClick={() => select(id)}
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', id)
            e.dataTransfer.effectAllowed = 'move'
            setDragId(id)
          }}
          onDragEnd={() => (setDragId(null), setOver(null))}
          onDragOver={(e) => {
            if (!canDrop) return
            e.preventDefault()
            setOver(id)
          }}
          onDragLeave={() => setOver((o) => (o === id ? null : o))}
          onDrop={(e) => {
            e.preventDefault()
            const from = dragId
            setDragId(null)
            setOver(null)
            if (from && canDrop) void move(from, id)
          }}
        >
          {kids.length > 0 && !isAll ? (
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
          {icon(isAll ? 'M2 3h12M2 8h12M2 13h12' : FOLDER_ICON)}
          <span className="tree-label">{label}</span>
          {!isAll && renderMenu(id, label)}
        </div>
        {kids.length > 0 && open && <ul role="group">{kids.map((k) => renderRow(k.id, depth + 1))}</ul>}
      </li>
    )
  }

  function renderMenu(id: string, name: string) {
    const shown = menu?.id === id
    const confirm = shown && menu!.confirm
    const close = () => {
      setMenu(null)
      buttons.current.get(id)?.focus()
    }
    const back = () => {
      setMenu({ id, confirm: false })
      requestAnimationFrame(() => del.current?.focus())
    }
    const pick = (d: Dialog) => {
      opener.current = buttons.current.get(id) ?? null
      setMenu(null)
      setDialog(d)
    }
    const n = view.noteCount(id)
    return (
      <span
        className="tree-menu"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (!shown) return
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            if (confirm) back()
            else close()
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const items = [...list.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
            const at = items.indexOf(document.activeElement as HTMLElement)
            items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
          }
        }}
      >
        <button
          ref={(el) => void (el ? buttons.current.set(id, el) : buttons.current.delete(id))}
          type="button"
          className="btn tree-menu-button"
          tabIndex={-1}
          aria-label={fmt(t('folder.menu'), { name })}
          aria-haspopup="menu"
          aria-expanded={shown}
          onClick={() => setMenu(shown ? null : { id, confirm: false })}
        >
          ⋯
        </button>
        {shown && (
          <div ref={list} role="menu" className="tree-menu-list">
            {confirm ? (
              <>
                <p role="alert" className="tree-confirm">
                  {n === 0 ? t('folder.deleteBodyEmpty') : fmt(t('folder.deleteBody'), { n })}
                </p>
                <button
                  type="button"
                  role="menuitem"
                  className="btn btn-destructive"
                  onClick={() => {
                    setMenu(null)
                    void service.deleteFolder(id).then((r) => r.error && setNote({ text: t('folder.failed') }))
                  }}
                >
                  {t('folder.deleteConfirm')}
                </button>
                <button type="button" role="menuitem" className="btn" data-cancel onClick={back}>
                  {t('library.cancel')}
                </button>
              </>
            ) : (
              <>
                <button type="button" role="menuitem" className="btn" onClick={() => pick({ kind: 'new', parentId: id })}>
                  {t('folder.newSub')}
                </button>
                <button type="button" role="menuitem" className="btn" onClick={() => pick({ kind: 'rename', id })}>
                  {t('folder.rename')}
                </button>
                <button type="button" role="menuitem" className="btn" onClick={() => pick({ kind: 'move', id })}>
                  {t('folder.move')}
                </button>
                <button ref={del} type="button" role="menuitem" className="btn" onClick={() => setMenu({ id, confirm: true })}>
                  {t('folder.delete')}
                </button>
              </>
            )}
          </div>
        )}
      </span>
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
        {renderRow(ALL, 1)}
      </ul>
      <button
        type="button"
        className="btn side-item folder-add"
        onClick={(e) => {
          opener.current = e.currentTarget
          setDialog({ kind: 'new', parentId: ALL })
        }}
      >
        {icon('M8 3v10M3 8h10')}
        <span>{t('folder.add')}</span>
      </button>
      {dialog?.kind === 'new' && (
        <NameDialog
          title={dialog.parentId === ALL ? t('folder.add') : t('folder.newSub')}
          initial=""
          onClose={closeDialog}
          onSave={async (name) => {
            const r = await service.createFolder(name, dialog.parentId)
            if (!r.error && dialog.parentId !== ALL) toggle(dialog.parentId, true)
            return r.error
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

/** A folder name: [저장] stays off while the name is empty; a too long name is refused with a message. */
function NameDialog({ title, initial, onSave, onClose }: { title: string; initial: string; onSave: (name: string) => Promise<string | undefined>; onClose: () => void }) {
  const { t } = useI18n()
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.select(), [])
  const check = libraryFolderName({ name: value })
  const submit = async () => {
    if (busy) return
    if (!check.ok) return setError(check.reason === 'nameTooLong' ? t('folder.nameTooLong') : null)
    setBusy(true)
    const code = await onSave(check.name)
    setBusy(false)
    if (code) setError(t('folder.failed'))
    else onClose()
  }
  return (
    <div
      className="dialog-scrim"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <form className="dialog" role="dialog" aria-modal="true" aria-label={title} onSubmit={(e) => (e.preventDefault(), void submit())}>
        <h2 className="dialog-title">{title}</h2>
        <label className="field">
          <span>{t('folder.nameLabel')}</span>
          <input ref={input} className="field-input" value={value} autoComplete="off" onChange={(e) => (setValue(e.target.value), setError(null))} />
        </label>
        <div aria-live="polite" className="dialog-error">
          {error}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('library.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" aria-disabled={!check.ok || busy}>
            {t('folder.save')}
          </button>
        </div>
      </form>
    </div>
  )
}
