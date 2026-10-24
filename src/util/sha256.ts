// SHA-256 of bytes as 64 lowercase hex (SubtleCrypto; the image asset name, spec image.md).
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
