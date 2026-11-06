// Story 14.3: the app trash screen (`#/trash`) and the read-only view of a trashed note.
// Mirrors kkeujeok-client lib/ui/trash_screen.dart. A trashed note has no device copy: it is
// downloaded by file id and shown from memory.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useI18n } from '../i18n'
import type { Note } from '../model/note'
import { StrokePathCache, paintPage } from '../render/pagePainter'
import type { TrashEntry, TrashOutcome, TrashService } from '../library/trashService'
import { SNACKBAR_MS } from './snackbar'

export const TRASH_HREF = '#/trash'

function useDate() {
  const { locale } = useI18n()
  return (iso: string) => {
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return ''
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(ms))
    } catch {
      return ''
    }
  }
}

function PageCanvas({ page, label }: { page: Note['pages'][number]; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    try {
      const dpr = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
      c.width = Math.max(1, Math.round(page.width * dpr))
      c.height = Math.max(1, Math.round(page.height * dpr))
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paintPage(ctx, page, { scale: 1, offsetX: 0, offsetY: 0 }, new StrokePathCache())
    } catch {
      // an empty page; images are not fetched here
    }
  }, [page])
  return <canvas ref={ref} role="img" aria-label={label} className="trash-page" style={{ aspectRatio: `${page.width} / ${page.height}` }} />
}

function TrashNoteView({ entry, service, onBack, onRestore }: { entry: TrashEntry; service: TrashService; onBack: () => void; onRestore: (e: TrashEntry) => Promise<boolean> }) {
  const { t } = useI18n()
  const [state, setState] = useState<'loading' | 'failed' | 'unreadable' | Note>('loading')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    service.open(entry.fileId).then(
      (r) => live && setState(r.result === 'ok' && r.note ? r.note : 'unreadable'),
      () => live && setState('failed'),
    )
    return () => {
      live = false
    }
  }, [service, entry.fileId])
  const restore = () => {
    setBusy(true)
    void onRestore(entry).then((ok) => (ok ? onBack() : setBusy(false)))
  }
  return (
    <section className="trash-view" aria-label={entry.title}>
      <div className="editor-banner trash-banner" role="status">
        <span>{t('trash.noteBanner')}</span>
        <button type="button" className="btn" disabled={busy} onClick={restore}>
          {t('trash.restore')}
        </button>
      </div>
      <div className="library-toolbar">
        <button type="button" className="btn" onClick={onBack}>
          {t('trash.back')}
        </button>
        <h1 className="library-heading">{entry.title}</h1>
      </div>
      {state === 'loading' ? null : typeof state === 'string' ? (
        <p role="alert">{state === 'failed' ? t('trash.loadFailed') : t('trash.cannotOpen')}</p>
      ) : (
        <div className="trash-pages">
          {state.pages.map((p, i) => (
            <PageCanvas key={p.id} page={p} label={t('trash.pageLabel').replace('{n}', String(i + 1))} />
          ))}
        </div>
      )}
    </section>
  )
}

export function Trash({ service, onChanged }: { service: TrashService; onChanged?: () => void }) {
  const { t } = useI18n()
  const date = useDate()
  const [entries, setEntries] = useState<TrashEntry[] | null>(null)
  const [error, setError] = useState(false)
  const [viewing, setViewing] = useState<TrashEntry | null>(null)
  // The id of the row asking for the second press, or 'all'.
  const [armed, setArmed] = useState<string | null>(null)
  const [toast, setToast] = useState('')

  const load = useCallback(async () => {
    try {
      setEntries(await service.list())
      setError(false)
    } catch {
      setEntries(null) // no stale rows after a failed load
      setError(true)
    }
  }, [service])
  useEffect(() => void load(), [load])
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(''), SNACKBAR_MS)
    return () => clearTimeout(id)
  }, [toast])

  const say = (r: TrashOutcome, e?: TrashEntry) =>
    setToast(r === 'done' ? `${e?.title ?? ''} ${t('trash.restored')}`.trim() : r === 'rootFallback' ? t('trash.restoredRoot') : r === 'gone' ? t('trash.gone') : t('trash.failed'))

  /** True when the item is back (or gone). */
  async function restore(e: TrashEntry): Promise<boolean> {
    let r: TrashOutcome
    try {
      r = await service.restore(e)
    } catch {
      r = 'failed'
    }
    say(r, e)
    if (r === 'failed') return false
    onChanged?.()
    await load()
    return true
  }

  async function purge(e: TrashEntry) {
    setArmed(null)
    let r: TrashOutcome
    try {
      r = await service.purge(e)
    } catch {
      r = 'failed'
    }
    if (r !== 'done') say(r, e)
    await load()
  }

  async function empty() {
    setArmed(null)
    const left = await service.empty(entries ?? [])
    if (left.length > 0) setToast(t('trash.failed'))
    await load()
  }

  if (viewing) return <TrashNoteView entry={viewing} service={service} onBack={() => setViewing(null)} onRestore={restore} />

  const onKey = (e: KeyboardEvent, entry: TrashEntry) => {
    if (e.key === 'Delete') {
      e.preventDefault()
      setArmed(entry.id)
    } else if (e.key === 'Escape' && armed) {
      e.preventDefault()
      setArmed(null)
    }
  }

  return (
    <section className="trash" aria-labelledby="trash-title">
      <div className="library-toolbar">
        <h1 id="trash-title" className="library-heading">
          {t('trash.title')}
        </h1>
        {entries && entries.length > 0 &&
          (armed === 'all' ? (
            <>
              <button type="button" className="btn btn-destructive" autoFocus onClick={() => void empty()}>
                {t('trash.emptyConfirm')}
              </button>
              <button type="button" className="btn" onClick={() => setArmed(null)}>
                {t('trash.cancel')}
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => setArmed('all')}>
              {t('trash.emptyAction')}
            </button>
          ))}
      </div>
      {error && <p role="alert">{t('trash.loadFailed')}</p>}
      {entries && entries.length === 0 && <p>{t('trash.empty')}</p>}
      {entries && entries.length > 0 && (
        <ul className="trash-list">
          {entries.map((e) => {
            const kind = t(e.isFolder ? 'trash.kindFolder' : 'trash.kindNote')
            const label = t('trash.itemLabel').replace('{name}', e.title).replace('{kind}', kind).replace('{date}', date(e.trashedAt))
            return (
              <li key={e.id} className="trash-item" onKeyDown={(ev) => onKey(ev, e)}>
                {e.isFolder ? (
                  <div className="trash-main" tabIndex={0} role="group" aria-label={label}>
                    <span className="trash-title">{e.title}</span>
                    <span className="trash-meta">
                      {t('trash.notes').replace('{n}', String(e.noteCount))} · {date(e.trashedAt)}
                    </span>
                  </div>
                ) : (
                  <button type="button" className="trash-main" aria-label={label} onClick={() => setViewing(e)}>
                    <span className="trash-title">{e.title}</span>
                    <span className="trash-meta">
                      {kind} · {date(e.trashedAt)}
                    </span>
                  </button>
                )}
                <button type="button" className="btn" onClick={() => void restore(e)}>
                  {t('trash.restore')}
                </button>
                {armed === e.id ? (
                  <>
                    <button type="button" className="btn btn-destructive" autoFocus onClick={() => void purge(e)}>
                      {t('trash.purgeConfirm')}
                    </button>
                    <button type="button" className="btn" onClick={() => setArmed(null)}>
                      {t('trash.cancel')}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn" onClick={() => setArmed(e.id)}>
                    {t('trash.purge')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {toast && (
        <div role="status" className="snackbar snackbar-toast">
          {toast}
        </div>
      )}
    </section>
  )
}
