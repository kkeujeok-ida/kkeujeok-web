// Spec rules of spec/custom.md: custom.accept, custom.coverId. Pure (port of the Android lib/model/custom_rules.dart).
export const CUSTOM_MAX_BYTES = 2_097_152
export const CUSTOM_SIDE_MIN = 64
export const CUSTOM_SIDE_MAX = 4096
/** At most this many user covers and this many user papers. */
export const CUSTOM_LIMIT = 20
export const USER_COVER_PREFIX = 'cover:user-'
export type CustomError = 'unsupported' | 'tooLarge' | 'tooSmall' | 'tooManyPixels' | 'limitReached'

/** `custom.accept`: `head` is the first 12 bytes as lowercase hex; `count` the user images of this kind already stored. */
export function customAccept(i: { head: string; size: number; width: number; height: number; count: number }): { ext: 'jpg' | 'png' } | { error: CustomError } {
  const ext = i.head.startsWith('ffd8ff') ? 'jpg' : i.head.startsWith('89504e470d0a1a0a') ? 'png' : null
  if (!ext) return { error: 'unsupported' }
  if (i.size > CUSTOM_MAX_BYTES) return { error: 'tooLarge' }
  if (i.width < CUSTOM_SIDE_MIN || i.height < CUSTOM_SIDE_MIN) return { error: 'tooSmall' }
  if (i.width > CUSTOM_SIDE_MAX || i.height > CUSTOM_SIDE_MAX) return { error: 'tooManyPixels' }
  if (i.count >= CUSTOM_LIMIT) return { error: 'limitReached' }
  return { ext }
}

/** `custom.coverId`: the asset hash of a `cover:user-<sha256>` id, else null. */
export function userCoverAsset(coverId: unknown): string | null {
  if (typeof coverId !== 'string' || !coverId.startsWith(USER_COVER_PREFIX)) return null
  const h = coverId.slice(USER_COVER_PREFIX.length)
  return /^[0-9a-f]{64}$/.test(h) ? h : null
}
