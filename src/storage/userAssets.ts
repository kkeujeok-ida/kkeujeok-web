// The user covers and papers this browser lists (spec custom.md). Only the list is kept here (localStorage, not synced:
// the note file and Drive carry the images a note uses); the bytes are ordinary assets. Removing from the list never
// deletes the bytes or the Drive file: notes that use the image keep drawing it.
import { customAccept, type CustomError } from '../model/customRules'
import { isAssetHash } from '../model/imageRules'
import { sha256Hex } from '../util/sha256'
import type { AssetStore } from './assetStore'

export type UserKind = 'cover' | 'paper'
export type UserAsset = { hash: string; ext: 'jpg' | 'png' }
type Lists = Record<UserKind, UserAsset[]>

export const USER_ASSETS_KEY = 'kkeujeok.userAssets'
const KINDS: UserKind[] = ['cover', 'paper']

function load(): Lists {
  const out: Lists = { cover: [], paper: [] }
  try {
    const j = JSON.parse(globalThis.localStorage?.getItem(USER_ASSETS_KEY) ?? 'null') as Record<string, unknown> | null
    for (const k of KINDS) {
      for (const e of Array.isArray(j?.[k]) ? (j![k] as { hash?: unknown; ext?: unknown }[]) : []) {
        if (e && isAssetHash(e.hash) && (e.ext === 'jpg' || e.ext === 'png')) out[k].push({ hash: e.hash, ext: e.ext })
      }
    }
  } catch {
    // missing, blocked or unreadable: an empty list
  }
  return out
}

let lists: Lists | null = null
const listeners = new Set<() => void>()
const state = () => (lists ??= load())
function save(next: Lists) {
  lists = next // this session keeps it even when storing fails
  try {
    globalThis.localStorage?.setItem(USER_ASSETS_KEY, JSON.stringify(next))
  } catch {
    // session-only
  }
  listeners.forEach((f) => f())
}

export const userAssets = {
  /** A stable array until the list changes (for useSyncExternalStore). */
  list: (kind: UserKind): readonly UserAsset[] => state()[kind],
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => void listeners.delete(fn)
  },
  remove(kind: UserKind, hash: string) {
    const s = state()
    save({ ...s, [kind]: s[kind].filter((a) => a.hash !== hash) })
  },
  /** Checks the file with `custom.accept` and stores it as an ordinary asset; the same image twice is one entry. */
  async add(kind: UserKind, file: Blob, store: AssetStore): Promise<{ asset: UserAsset } | { error: CustomError }> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const head = [...bytes.subarray(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const mine = state()[kind]
    const hash = await sha256Hex(bytes)
    const same = mine.find((a) => a.hash === hash)
    if (same) return { asset: same }
    let width = 0, height = 0
    try {
      const bmp = await createImageBitmap(file)
      ;[width, height] = [bmp.width, bmp.height]
      bmp.close()
    } catch {
      return { error: 'unsupported' } // not decodable
    }
    const r = customAccept({ head, size: bytes.length, width, height, count: mine.length })
    if ('error' in r) return r
    await store.put(hash, r.ext, bytes)
    const asset: UserAsset = { hash, ext: r.ext }
    save({ ...state(), [kind]: [...mine, asset] })
    return { asset }
  },
}
