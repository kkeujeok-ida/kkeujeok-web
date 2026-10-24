// The tab's element clipboard (Story 4.7): deep-copied element JSON in page order. Memory only, module wide, so it
// outlives the editor and its note. Never the system clipboard, never storage: another browser tab or a reload starts empty.
import type { El } from './select'

let items: El[] = []

export const elementClipboard = {
  get: (): El[] => structuredClone(items),
  set: (els: readonly El[]): void => {
    items = structuredClone([...els])
  },
  get size(): number {
    return items.length
  },
}
