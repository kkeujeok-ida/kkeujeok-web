import { useEffect, useMemo, type ComponentProps, useRef, useState, useSyncExternalStore } from 'react'
import { useI18n } from '../i18n'
import { PrivacyPolicy, isPrivacyPath } from './PrivacyPolicy'
import { Settings } from './Settings'
import { AccountGate, type GateDeps } from './AccountGate'
import { SignIn } from './SignIn'
import { Library } from './library/Library'
import { NoteEditor, parseNoteRoute } from './library/NoteEditor'
import { auth as defaultAuth, type Auth } from '../drive/auth'
import { defaultRootFolder, type RootFolderStore } from '../drive/rootFolderStore'
import type { UploadCoordinator } from '../sync/uploadCoordinator'
import type { NoteReceiver } from '../sync/noteReceiver'
import { defaultReceiver, useReceiveTriggers } from '../sync/receiveWiring'
import { defaultUploadCoordinator, useUploadTriggers } from '../sync/uploadWiring'
import { ReviveSnackbar } from './sync/ReviveSnackbar'
import { SyncUiProvider } from './sync/syncUi'

export const SIDEBAR_EXPANDED_MIN_WIDTH = 840
export const isSidebarExpanded = (width: number) => width >= SIDEBAR_EXPANDED_MIN_WIDTH

function useSidebarExpanded(): boolean {
  return useSyncExternalStore(
    (fn) => {
      window.addEventListener('resize', fn)
      return () => window.removeEventListener('resize', fn)
    },
    () => isSidebarExpanded(window.innerWidth),
    () => true,
  )
}

function useHash(): string {
  return useSyncExternalStore(
    (fn) => {
      window.addEventListener('hashchange', fn)
      return () => window.removeEventListener('hashchange', fn)
    },
    () => window.location.hash,
    () => '',
  )
}

// No router library: the path alone picks the static policy page or the shell.
export type SyncUiProps = Pick<ComponentProps<typeof SyncUiProvider>, 'status' | 'net' | 'exportLog'>

export function App({ auth = defaultAuth, root, uploads, receiver, gate, unsentIds, syncUi }: { auth?: Auth; root?: RootFolderStore; uploads?: UploadCoordinator; receiver?: NoteReceiver; gate?: GateDeps; unsentIds?: () => Promise<string[] | null>; syncUi?: SyncUiProps }) {
  const { token, notice, busy } = useSyncExternalStore(auth.subscribe, auth.getState, auth.getState)
  if (isPrivacyPath(globalThis.location?.pathname ?? '/')) return <PrivacyPolicy />
  // While the sign-in runs (busy) the account is not known yet: no shell, so nothing syncs before the gate decides.
  return token && !busy ? (
    <AccountGate auth={auth} {...(gate && { deps: gate })}>
      <Shell auth={auth} root={root} uploads={uploads} receiver={receiver} {...(unsentIds && { unsentIds })} {...(syncUi && { syncUi })} />
    </AccountGate>
  ) : (
    <SignIn auth={auth} notice={notice} />
  )
}

function Shell({ auth, root: rootProp, uploads: uploadsProp, receiver: receiverProp, unsentIds, syncUi }: { auth: Auth; root?: RootFolderStore; uploads?: UploadCoordinator; receiver?: NoteReceiver; unsentIds?: () => Promise<string[] | null>; syncUi?: SyncUiProps }) {
  const root = useMemo(() => rootProp ?? defaultRootFolder(auth), [rootProp, auth])
  // Uploads run on the real Drive only with the default root; a given root (tests) needs a given coordinator.
  const uploads = useMemo(
    () => uploadsProp ?? (rootProp ? undefined : defaultUploadCoordinator(auth, root)),
    [uploadsProp, rootProp, auth, root],
  )
  useUploadTriggers(uploads, root)
  // Same rule for receiving remote changes (Story 3.14).
  const receiver = useMemo(
    () => receiverProp ?? (rootProp ? undefined : defaultReceiver(auth, root)),
    [receiverProp, rootProp, auth, root],
  )
  useReceiveTriggers(receiver, root)
  const { t } = useI18n()
  const expanded = useSidebarExpanded()
  const noteId = parseNoteRoute(useHash())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  // Closing Settings unmounts the button that had focus; hand focus back to the
  // entry that opened it, so a keyboard user keeps their place.
  useEffect(() => {
    if (wasOpen.current && !settingsOpen) settingsButton.current?.focus()
    wasOpen.current = settingsOpen
  }, [settingsOpen])
  // Collapsed: labels stay in the accessibility tree, only the icon shows.
  const hidden = expanded ? undefined : 'sr-only'

  return (
    <SyncUiProvider auth={auth} uploads={uploads} receiver={receiver} {...syncUi}>
    <div className="shell">
      {/* The writing screen covers the window; the sidebar is not reachable behind it. */}
      <nav
        className={expanded ? 'sidebar' : 'sidebar collapsed'}
        aria-label={t('sidebar.label')}
        inert={noteId !== null && !settingsOpen}
      >
        <div className={hidden ? `brand ${hidden}` : 'brand'}>{t('app.name')}</div>
        <div className="library-slot" />
        <button
          ref={settingsButton}
          type="button"
          className="btn side-item"
          aria-current={settingsOpen ? 'page' : undefined}
          onClick={() => setSettingsOpen(true)}
        >
          <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
          <span className={hidden}>{t('sidebar.settings')}</span>
        </button>
      </nav>
      <main className="content">
        {settingsOpen ? (
          <Settings auth={auth} onClose={() => setSettingsOpen(false)} {...(unsentIds && { unsentIds })} />
        ) : noteId ? (
          <NoteEditor key={noteId} noteId={noteId} uploads={uploads} receiver={receiver} />
        ) : (
          <Library root={root} signOut={auth.signOut} receiver={receiver} />
        )}
      </main>
    </div>
    <ReviveSnackbar />
    </SyncUiProvider>
  )
}
