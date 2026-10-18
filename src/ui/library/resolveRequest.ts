// "Open the conflict dialog of this note": [해결하기] of the banner, and a library card of a conflicted note, which
// opens the editor with the dialog already open (Story 3.22). A request is taken by the editor of that note.
const pending = new Set<string>()
const listeners = new Set<(noteId: string) => void>()

export function requestResolve(noteId: string): void {
  pending.add(noteId)
  listeners.forEach((f) => f(noteId))
}

/** True once per request. Every other pending request is dropped: a request never outlives the open it was made for. */
export function takeResolveRequest(noteId: string): boolean {
  const had = pending.delete(noteId)
  pending.clear()
  return had
}

export function onResolveRequest(fn: (noteId: string) => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}
