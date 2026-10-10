import type { Auth } from '../src/drive/auth'

// An already signed-in auth, for tests of the shell behind the sign-in gate.
const state = { token: 't', notice: null, busy: false }
export const signedIn = {
  getState: () => state,
  subscribe: () => () => {},
  preload: () => {},
  getAccessToken: () => 't',
  signIn: async () => 'granted',
  signOut: () => {},
  disconnect: async () => 'revoked',
} as Auth
