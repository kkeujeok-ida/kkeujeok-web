// Web sign-in via Google Identity Services token model (AD-13). The access
// token lives in this module's memory only: no storage, no refresh token.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const GIS_URL = 'https://accounts.google.com/gsi/client'

// The token request also asks for the account identity (`sub`, e-mail); only
// the Drive scope is checked as granted.
const TOKEN_SCOPE = `${DRIVE_SCOPE} openid email`
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

export type Account = { sub: string; email: string }

/** The signed-in account from Google's userinfo endpoint; null on any failure. */
export async function fetchUserinfo(token: string): Promise<Account | null> {
  try {
    const r = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { sub?: unknown; email?: unknown }
    return typeof j.sub === 'string' && j.sub !== '' ? { sub: j.sub, email: typeof j.email === 'string' ? j.email : '' } : null
  } catch {
    return null
  }
}

// Story 11.8: the only thing kept across a reload is "this browser signed in before"
// (account sub + e-mail as the login hint). Never a token. Cleared on sign-out and disconnect.
export const SIGNED_IN_KEY = 'kkeujeok.signedIn'
const readMark = (): Account | null => {
  try {
    const j = JSON.parse(localStorage.getItem(SIGNED_IN_KEY) ?? 'null') as { sub?: unknown; email?: unknown } | null
    return typeof j?.sub === 'string' && j.sub !== '' ? { sub: j.sub, email: typeof j.email === 'string' ? j.email : '' } : null
  } catch {
    return null
  }
}
const writeMark = (a: Account | null) => {
  try {
    if (a) localStorage.setItem(SIGNED_IN_KEY, JSON.stringify(a))
    else localStorage.removeItem(SIGNED_IN_KEY)
  } catch {
    // no storage: the next reload asks for a sign-in
  }
}

export type Outcome ='granted' | 'denied' | 'cancelled' | 'network' | 'unconfigured'
export type Notice = 'denied' | 'network' | 'unconfigured' | null
export interface AuthState {
  token: string | null
  /** Who the token belongs to; null until known (or when the lookup failed). */
  account: Account | null
  notice: Notice
  busy: boolean
  /** A Drive call was refused for the current token (401): it needs a new one (Story 3.16). */
  expired: boolean
  /** A silent sign-in after a reload is running: neither the shell nor the sign-in screen shows yet. */
  restoring: boolean
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
    prompt?: string
    hint?: string
    callback: (r: TokenResponse) => void
    error_callback: (e: { type?: string }) => void
  }): { requestAccessToken(): void }
  hasGrantedAllScopes(r: TokenResponse, scope: string): boolean
  revoke?(token: string, done: (r?: { successful?: boolean; error?: string }) => void): void
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
  /** How long to wait for Google to answer a revoke before calling it failed. */
  revokeTimeoutMs?: number
  /** Looks the account up after a granted sign-in. Absent: the account stays unknown. */
  fetchAccount?: (token: string) => Promise<Account | null>
  /** How long the silent sign-in may take before it counts as failed. */
  restoreTimeoutMs?: number
}

export function createAuth({ clientId, loadScript, revokeTimeoutMs = 10_000, fetchAccount, restoreTimeoutMs = 10_000 }: Env) {
  let state: AuthState = { token: null, account: null, notice: null, busy: false, expired: false, restoring: !!clientId?.trim() && readMark() !== null }
  let restoreFlight = false
  const listeners = new Set<() => void>()
  // After a disconnect the next sign-in must show the consent screen again.
  let reconsent = false
  let reauthing = false
  const set = (patch: Partial<AuthState>) => {
    state = { ...state, ...patch }
    listeners.forEach((fn) => fn())
  }

  // The account of the token just granted; sign-in waits for it, a failure only leaves it null.
  async function lookUpAccount(token: string) {
    try {
      const account = (await fetchAccount?.(token)) ?? null
      if (state.token === token) {
        // not after a sign-out
        set({ account })
        if (account) writeMark(account)
      }
    } catch {
      // unknown account: no tag, sign-in still works
    }
  }

  function request(oauth2: GoogleOAuth2, hint?: string): Promise<Outcome> {
    return new Promise((resolve) => {
      oauth2
        .initTokenClient({
          client_id: clientId!.trim(),
          scope: TOKEN_SCOPE,
          prompt: reconsent ? 'consent' : '',
          ...(hint && { hint }),
          callback: (r) => {
            if (r.error || !r.access_token) resolve(r.error === 'access_denied' ? 'denied' : 'network')
            else if (!oauth2.hasGrantedAllScopes(r, DRIVE_SCOPE)) {
              // Drive was left unticked: drop the grant Google just issued.
              oauth2.revoke?.(r.access_token, () => {})
              resolve('denied')
            }
            else {
              reconsent = false
              set({ token: r.access_token, expired: false })
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
        if (outcome === 'granted') await lookUpAccount(state.token!)
      } catch {
        outcome = 'network'
      }
      set({ busy: false, notice: outcome === 'denied' || outcome === 'network' ? outcome : null })
      return outcome
    },
    // Drop the in-memory token; the gate then shows the sign-in screen.
    signOut() {
      writeMark(null)
      set({ token: null, account: null, notice: null, expired: false, restoring: false })
    },
    // After a reload: a new token without a click (`prompt: ''` + the stored hint). If the browser
    // does not allow it, the state is "expired" with no token: the shell opens with [다시 로그인].
    async restore(): Promise<void> {
      const mark = readMark()
      if (restoreFlight || state.token || !mark || !clientId?.trim()) return set({ restoring: false })
      restoreFlight = true
      set({ restoring: true })
      let outcome: Outcome
      try {
        await loadScript()
        const oauth2 = gis()
        const timeout = new Promise<Outcome>((res) => setTimeout(() => res('network'), restoreTimeoutMs))
        outcome = oauth2 ? await Promise.race([request(oauth2, mark.email || undefined), timeout]) : 'network'
      } catch {
        outcome = 'network'
      }
      restoreFlight = false
      if (outcome === 'granted') await lookUpAccount(state.token!)
      // The hint stands for the account when the lookup failed or nothing was granted.
      set({ restoring: false, ...(state.account === null && { account: mark }), ...(outcome !== 'granted' && { expired: true }) })
    },
    // A Drive call was refused (401) for `token`. Only the token in use counts: a late answer
    // for an older token must not expire the new one.
    markExpired(token: string | null) {
      if (token !== null && token === state.token && !state.expired) set({ expired: true })
    },
    // [다시 로그인]: a new token inside the click. Unlike signIn it never sets `busy`, so the
    // shell and the open note stay where they are; a failure leaves everything as it was.
    async reauth(): Promise<Outcome> {
      if (reauthing || state.busy || (!state.token && !state.expired)) return 'cancelled'
      reauthing = true
      try {
        await loadScript()
        const oauth2 = gis()
        if (!oauth2 || !clientId?.trim()) return 'network'
        const outcome = await request(oauth2, state.account?.email || undefined)
        if (outcome === 'granted') {
          const before = state.account
          await lookUpAccount(state.token!)
          // The lookup failed: it is the account the hint named, as far as anyone knows.
          if (state.account === null && before !== null) set({ account: before })
        }
        return outcome
      } catch {
        return 'network'
      } finally {
        reauthing = false
      }
    },
    // Revoke the Drive grant at Google. Only 'revoked' means it is gone.
    async disconnect(): Promise<'revoked' | 'failed'> {
      const token = state.token
      if (!token) return 'failed'
      try {
        await loadScript()
        const oauth2 = gis()
        if (!oauth2?.revoke) return 'failed'
        // No answer (offline, blocked request) must not leave the dialog busy forever.
        const ok = await new Promise<boolean>((res) => {
          const timer = setTimeout(() => res(false), revokeTimeoutMs)
          oauth2.revoke!(token, (r) => {
            clearTimeout(timer)
            res(r?.successful === true && !r.error)
          })
        })
        if (ok) {
          reconsent = true
          writeMark(null)
          set({ account: null })
        }
        return ok ? 'revoked' : 'failed'
      } catch {
        return 'failed'
      }
    },
  }
}
export type Auth = ReturnType<typeof createAuth>

export const auth = createAuth({
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID,
  loadScript: loadGisScript,
  fetchAccount: fetchUserinfo,
})
export const getAccessToken = () => auth.getAccessToken()
