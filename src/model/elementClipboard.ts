// The tab's element clipboard (Story 4.7): deep-copied element JSON in page order. Memory only, module wide, so it
// outlives the editor and its note. Never the system clipboard, never storage: another browser tab or a reload starts empty.
import type { El } from './select'

let items: El[] = []
// The window lost focus since the last copy: the system clipboard may hold something newer (Story 4.10).
let blurred = false
globalThis.addEventListener?.('blur', () => (blurred = true))

export const elementClipboard = {
  get: (): El[] => structuredClone(items),
  set: (els: readonly El[]): void => {
    items = structuredClone([...els])
    blurred = false
  },
  get size(): number {
    return items.length
  },
  /** The elements were copied in this tab and the window has not lost focus since. */
  get fresh(): boolean {
    return items.length > 0 && !blurred
  },
}
