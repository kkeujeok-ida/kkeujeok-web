// One chain per note id for the whole page session: an upload and a receive of the
// same note never run at the same time (the work of different notes does).
const chains = new Map<string, Promise<void>>()

export function chained<T>(noteId: string, body: () => Promise<T>): Promise<T> {
  const run = (chains.get(noteId) ?? Promise.resolve()).then(body)
  const done = run.then(
    () => {},
    () => {},
  )
  chains.set(noteId, done)
  void done.then(() => {
    if (chains.get(noteId) === done) chains.delete(noteId)
  })
  return run
}
