/** The library's note order, handed to the writing screen (Story 5.14). Module state: the library is gone while a note is open. */

export type OrderItem = { noteId: string; title: string | null; remote?: boolean; blocked?: boolean }

let published: OrderItem[] = []
export const publishNoteOrder = (list: OrderItem[]) => {
  published = list
}
export const readNoteOrder = () => published

export type Neighbours = { prev: string | null; next: string | null; n: number; total: number }

/** The openable notes around `noteId`; `n` is 0 when the note is not in the list. */
export function neighbours(list: OrderItem[], noteId: string, opts: { offline: boolean; skip?: (i: OrderItem) => boolean }): Neighbours {
  const open = list.filter((i) => i.noteId === noteId || (i.title !== null && !i.blocked && !(opts.offline && i.remote) && !opts.skip?.(i)))
  const at = open.findIndex((i) => i.noteId === noteId)
  if (at < 0) return { prev: null, next: null, n: 0, total: open.length }
  return { prev: open[at - 1]?.noteId ?? null, next: open[at + 1]?.noteId ?? null, n: at + 1, total: open.length }
}

export type Jump = { fromId: string; fromTitle: string; toId: string }
/** A jump whose target never opened must not tag a later, ordinary open of that note. */
const JUMP_TTL_MS = 15000
let pending: (Jump & { at: number }) | null = null
export const setPendingJump = (j: Jump) => {
  pending = { ...j, at: Date.now() }
}
/** The jump made to `noteId`, once; one made to another note is dropped. */
export function takeJump(noteId: string): Jump | null {
  const j = pending
  pending = null
  return j && j.toId === noteId && Date.now() - j.at <= JUMP_TTL_MS ? j : null
}
