// Saving the note being written: one serial, coalescing queue per note. Only
// the newest snapshot waits behind a running write; a failed snapshot is kept
// and written once more when the editor is left.
import type { Note } from '../model/note'
import type { NoteStore } from './noteStore'

export class SaveQueue {
  private latest: Note | null = null
  private failed: Note | null = null
  private running: Promise<void> | null = null

  constructor(
    private store: Pick<NoteStore, 'writeNote'>,
    private onFail: () => void = () => {},
  ) {}

  /** A snapshot is waiting, being written, or failed and not written yet. */
  get pending(): boolean {
    return this.running !== null || this.latest !== null || this.failed !== null
  }

  /** Queues `note`; the writes run one at a time and skip superseded snapshots. */
  commit(note: Note): void {
    this.latest = note
    // The loop clears `running` in the same turn it sees `latest` empty, so a
    // commit never finds a finished drain still marked as running.
    this.running ??= this.drain()
  }

  private async drain(): Promise<void> {
    try {
      while (this.latest) {
        const n = this.latest
        this.latest = null
        try {
          await this.store.writeNote(n)
          this.failed = null
        } catch {
          // The stroke stays; the next commit holds the whole note again.
          this.failed = n
          this.onFail()
        }
      }
    } finally {
      this.running = null
    }
  }

  /** Waits for the queue, then tries a failed snapshot once more. Never rejects; false = still unsaved. */
  async flush(): Promise<boolean> {
    while (this.running) await this.running
    const f = this.failed
    if (!f) return true
    try {
      await this.store.writeNote(f)
      this.failed = null
      return true
    } catch {
      return false // leaving anyway
    }
  }
}

// Saves that outlive their editor: the browser's back button unmounts it. The
// library waits for these before it lists notes again.
const pending = new Set<Promise<unknown>>()

export function trackSave<T>(p: Promise<T>): Promise<T> {
  pending.add(p)
  const done = () => void pending.delete(p)
  p.then(done, done)
  return p
}

/** Resolves once no tracked save is running, or after `timeoutMs` when given. */
export async function savesSettled(timeoutMs?: number): Promise<void> {
  const all = (async () => {
    while (pending.size > 0) await Promise.allSettled([...pending])
  })()
  if (timeoutMs === undefined) return all
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([all, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))])
  clearTimeout(timer)
}

// Set when a note was left with strokes that could not be saved; the library
// tells the user once.
let unsaved = false
export const markUnsaved = () => void (unsaved = true)
export function takeUnsaved(): boolean {
  const v = unsaved
  unsaved = false
  return v
}
