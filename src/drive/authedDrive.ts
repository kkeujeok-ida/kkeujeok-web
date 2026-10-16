// The Drive client of this page session: the signed-in token, and what each answer
// says about the session (a 401 expires the token, a network failure is "offline").
import type { Auth } from './auth'
import { connectivity, type Connectivity } from './connectivity'
import { createHttpDriveClient } from './driveClient'

export function createAuthedDrive(auth: Pick<Auth, 'getAccessToken'> & Partial<Pick<Auth, 'markExpired'>>, net: Pick<Connectivity, 'networkFailed' | 'networkOk'> = connectivity()) {
  return createHttpDriveClient({
    token: () => auth.getAccessToken(),
    onOutcome(o) {
      if (o.kind === 'unauthorized') auth.markExpired?.(o.token)
      else if (o.kind === 'network') net.networkFailed()
      else net.networkOk()
    },
  })
}
