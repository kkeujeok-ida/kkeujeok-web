// "다른 기기에서 지운 노트에 보내지 않은 변경이 있어 되살렸어요." (UX-DR68): once for each note the
// receiver restored, for a few seconds. The live region is always there so a screen reader hears the text.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useI18n } from '../../i18n'
import { useSyncUi } from './syncUi'

export const REVIVE_SNACKBAR_MS = 4000
const NONE = { subscribe: () => () => {}, getState: () => ({ revived: 0 }) as { revived?: number } }

export function ReviveSnackbar() {
  const { t } = useI18n()
  const rx = useSyncUi()?.receiver ?? NONE
  const revived = useSyncExternalStore(rx.subscribe, () => rx.getState().revived ?? 0, () => 0)
  const seen = useRef(revived)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (revived === seen.current) return
    seen.current = revived
    setShown(true)
    const id = setTimeout(() => setShown(false), REVIVE_SNACKBAR_MS)
    return () => clearTimeout(id)
  }, [revived])
  return (
    <div role="status" className="snackbar revive-snackbar">
      {shown ? t('sync.revived') : ''}
    </div>
  )
}
