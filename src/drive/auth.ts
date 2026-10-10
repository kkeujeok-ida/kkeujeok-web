// Web sign-in via Google Identity Services token model (AD-13). The access
// token lives in this module's memory only: no storage, no refresh token.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const GIS_URL = 'https://accounts.google.com/gsi/client'

export type Outcome = 'granted' | 'denied' | 'cancelled' | 'network' | 'unconfigured'
export type Notice = 'denied' | 'network' | 'unconfigured' | null
export interface AuthState {
  token: string | null
  notice: Notice
  busy: boolean
}

// Only the slice of google.accounts.oauth2 that is used.
interface TokenResponse {
  access_token?: string
  error?: string
}
interface GoogleOAuth2 {
  initTokenClient(cfg: {
    client_id: string
    scope: string
    callback: (r: TokenResponse) => void
    error_callback: (e: { type?: string }) => void
  }): { requestAccessToken(): void }
  hasGrantedAllScopes(r: TokenResponse, scope: string): boolean
  revoke?(token: string, done: () => void): void
}
const gis = () => (globalThis as { google?: { accounts?: { oauth2?: GoogleOAuth2 } } }).google?.accounts?.oauth2

let pending: Promise<void> | undefined
export function loadGisScript(): Promise<void> {
  // A failed load is forgotten so a retry fetches the script again.
  pending ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = GIS_URL
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      s.remove() // a failed tag must not pile up across retries
      reject(new Error('gis load failed'))
    }
    document.head.append(s)
  }).catch((e) => {
    pending = undefined
    throw e
  })
  return pending
}

export interface Env {
  clientId: string | undefined
  loadScript: () => Promise<void>
}

export function createAuth({ clientId, loadScript }: Env) {
  let state: AuthState = { token: null, notice: null, busy: false }
  const listeners = new Set<() => void>()
  const set = (patch: Partial<AuthState>) => {
    state = { ...state, ...patch }
    listeners.forEach((fn) => fn())
  }

  function request(oauth2: GoogleOAuth2): Promise<Outcome> {
    return new Promise((resolve) => {
      oauth2
        .initTokenClient({
          client_id: clientId!.trim(),
          scope: DRIVE_SCOPE,
          callback: (r) => {
            if (r.error || !r.access_token) resolve(r.error === 'access_denied' ? 'denied' : 'network')
            else if (!oauth2.hasGrantedAllScopes(r, DRIVE_SCOPE)) {
              // Drive was left unticked: drop the grant Google just issued.
              oauth2.revoke?.(r.access_token, () => {})
              resolve('denied')
            }
            else {
              set({ token: r.access_token })
              resolve('granted')
            }
          },
          error_callback: (e) => resolve(e.type === 'popup_closed' ? 'cancelled' : 'network'),
        })
        .requestAccessToken()
    })
  }

  return {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    getAccessToken: () => state.token,
    // Load the GIS script ahead of the click, so the popup opens inside the
    // user gesture instead of after a slow download.
    preload: () => {
      if (clientId?.trim()) void loadScript().catch(() => {})
    },
    // Call from a user gesture (the popup would be blocked otherwise).
    async signIn(): Promise<Outcome> {
      if (state.busy) return 'cancelled'
      if (!clientId?.trim()) {
        set({ notice: 'unconfigured' })
        return 'unconfigured'
      }
      set({ busy: true, notice: null })
      let outcome: Outcome
      try {
        await loadScript()
        const oauth2 = gis()
        outcome = oauth2 ? await request(oauth2) : 'network'
      } catch {
        outcome = 'network'
      }
      set({ busy: false, notice: outcome === 'denied' || outcome === 'network' ? outcome : null })
      return outcome
    },
  }
}
export type Auth = ReturnType<typeof createAuth>

export const auth = createAuth({
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
  loadScript: loadGisScript,
})
export const getAccessToken = () => auth.getAccessToken()
