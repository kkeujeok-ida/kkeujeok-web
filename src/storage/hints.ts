// One-line hints (Story 10.6): a per-browser "seen" flag each (localStorage), not in the note and not synced.
export type Hint = 'firstNote' | 'penEdit'
const key = (h: Hint) => `kkeujeok.hint.${h}`

export function hintSeen(h: Hint, storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(key(h)) === '1'
  } catch {
    return false
  }
}

export function markHint(h: Hint, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(key(h), '1')
  } catch {
    // blocked storage: the hint shows again next time
  }
}
