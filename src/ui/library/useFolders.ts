// The folders the library shows (Story 7.6) and the address of the folder being looked at: `#/folder/<id>`,
// no folder in the hash = "모든 노트".
import { useEffect, useState } from 'react'
import { FolderView, type FolderService } from '../../library/folderService'
import { uploadsAllowed, type RootFolderStore } from '../../drive/rootFolderStore'
import type { NoteReceiver } from '../../sync/noteReceiver'

export function parseFolderRoute(hash: string): string | null {
  const m = /^#\/folder\/([^/]+)$/.exec(hash)
  if (!m) return null
  try {
    return decodeURIComponent(m[1]!)
  } catch {
    return null
  }
}
export const folderHref = (id: string | null) => (id === null ? '#/' : `#/folder/${encodeURIComponent(id)}`)

const EMPTY = new FolderView()

/** The view follows the service; Drive is read again on mount, when the connection is back, when the root is ready and after a receive. */
export function useFolders(
  service: FolderService | undefined,
  root?: Pick<RootFolderStore, 'getState' | 'subscribe'>,
  receiver?: Pick<NoteReceiver, 'subscribe' | 'getState'>,
): { view: FolderView; loaded: boolean } {
  const [state, setState] = useState({ view: EMPTY, loaded: false })
  useEffect(() => {
    if (!service) return
    let live = true
    // `loaded` waits for the first Drive read, so a deep link on an empty cache is not sent back to "모든 노트".
    let settled = false
    const show = () => void service.view().then((view) => live && setState({ view, loaded: settled }), () => {})
    const unsub = service.subscribe(show)
    show()
    const refresh = () => void service.refresh().catch(() => {}).finally(() => ((settled = true), show()))
    refresh()
    window.addEventListener('online', refresh)
    let ready = root ? uploadsAllowed(root) : false
    const unRoot = root?.subscribe(() => {
      const now = uploadsAllowed(root)
      if (now && !ready) refresh()
      ready = now
    })
    let version = receiver?.getState().version
    const unReceive = receiver?.subscribe(() => {
      const v = receiver.getState().version
      if (v !== version) ((version = v), refresh())
    })
    return () => {
      live = false
      unsub()
      unRoot?.()
      unReceive?.()
      window.removeEventListener('online', refresh)
    }
  }, [service, root, receiver])
  return state
}
