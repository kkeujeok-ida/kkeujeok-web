import { v7 } from 'uuid'

/** A new lowercase UUIDv7 for notes, pages, strokes and revs. */
export const newId = (): string => v7().toLowerCase()
