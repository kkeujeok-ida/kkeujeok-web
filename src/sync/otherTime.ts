// When the other device's version of a conflicted page was uploaded, for "더 최근" and the time under the preview.
// shortcut: the head revision of the note file, not the exact revision that holds the page; fix when the theirs
// revision id is recorded at merge. Best effort: offline, a slow answer (3 s with the probe) or any error is null
// and the page's own `editedAt` stands in.
import type { DriveClient } from '../drive/driveClient'

export const OTHER_TIME_TIMEOUT_MS = 3000

export function createOtherTime(d: {
  drive: Pick<DriveClient, 'listRevisions'>
  online: () => boolean
  timeoutMs?: number
}): (fileId: string | null) => Promise<string | null> {
  return async (fileId) => {
    if (fileId === null || !d.online()) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), d.timeoutMs ?? OTHER_TIME_TIMEOUT_MS)
    })
    try {
      const work = d.drive.listRevisions(fileId).then((revs) => {
        let latest: string | null = null
        // Canonical timestamps compare as text.
        for (const r of revs) if (latest === null || r.modifiedTime > latest) latest = r.modifiedTime
        return latest
      })
      work.catch(() => {}) // a late failure after the timeout is not an unhandled rejection
      return await Promise.race([work, late])
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
