// "내 이미지": the user covers or papers this browser lists, as radios, with [추가] and a confirmed [삭제] (spec custom.md).
import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { fmt, useI18n, type Key } from '../../i18n'
import type { ImageHost } from '../../render/imageHost'
import { userAssets, type UserKind } from '../../storage/userAssets'
import { ConfirmDialog } from '../ConfirmDialog'

export type UserHost = Partial<Pick<ImageHost, 'addUser' | 'userUrl' | 'subscribe'>> | undefined

const ERROR_KEY = {
  unsupported: 'custom.unsupported',
  tooLarge: 'custom.tooLarge',
  tooSmall: 'custom.tooSmall',
  tooManyPixels: 'custom.tooManyPixels',
  limitReached: 'custom.limitReached',
  storeFailed: 'custom.storeFailed',
} as const satisfies Record<string, Key>

/** The list of `kind`, kept current; repaints when a picture of the host arrives. */
export function useUserList(kind: UserKind, images: UserHost) {
  const list = useSyncExternalStore(userAssets.subscribe, () => userAssets.list(kind), () => userAssets.list(kind))
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => images?.subscribe?.(tick), [images])
  return list
}

type Props = {
  kind: UserKind
  images: UserHost
  /** The radio group these tiles join. */
  name: string
  disabled?: boolean
  isSelected: (hash: string) => boolean
  onPick: (hash: string) => void
  /** An image was removed from the list. */
  onRemoved?: (hash: string) => void
}

export function UserImageTiles({ kind, images, name, disabled, isSelected, onPick, onRemoved }: Props) {
  const { t } = useI18n()
  const list = useUserList(kind, images)
  const file = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  if (!images?.addUser || !images.userUrl) return null
  const add = async (f: File | undefined) => {
    if (!f) return
    const r = await images.addUser!(kind, f)
    if ('error' in r) setError(t(ERROR_KEY[r.error]))
    else (setError(''), onPick(r.hash))
  }
  return (
    <>
      {list.map((a, i) => {
        const url = images.userUrl!(a.hash)
        const label = fmt(t('custom.imageName'), { n: i + 1 })
        return (
          <span key={a.hash} className="user-tile">
            <label className="option option-tile">
              <input type="radio" name={name} value={a.hash} checked={isSelected(a.hash)} disabled={disabled} onChange={() => onPick(a.hash)} />
              {url ? <img className="cover-option-art" src={url} alt="" draggable={false} /> : <span className="cover-option-art cover-option-none" aria-hidden="true" />}
              {label}
            </label>
            <button type="button" className="btn" aria-label={`${t('custom.delete')}: ${label}`} aria-disabled={disabled} onClick={() => !disabled && setRemoving(a.hash)}>
              {t('custom.delete')}
            </button>
          </span>
        )
      })}
      <input ref={file} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => (void add(e.target.files?.[0]), (e.target.value = ''))} />
      <button type="button" className="btn" aria-disabled={disabled} onClick={() => !disabled && file.current?.click()}>
        {t(kind === 'cover' ? 'custom.addCover' : 'custom.addPaper')}
      </button>
      <div aria-live="polite" className="dialog-error">
        {error}
      </div>
      {removing && (
        // Keys are for this confirmation only: Esc must not also close the sheet underneath.
        <div onKeyDown={(e) => e.stopPropagation()}>
          <ConfirmDialog
            body={`${t('custom.deleteTitle')} ${t('custom.deleteBody')}`}
            confirmLabel={t('custom.delete')}
            cancelLabel={t('dialog.cancel')}
            destructive
            onCancel={() => setRemoving(null)}
            onConfirm={() => {
              userAssets.remove(kind, removing)
              onRemoved?.(removing)
              setRemoving(null)
            }}
          />
        </div>
      )}
    </>
  )
}
