import { type Note, type NoteReadResult, toWritableJson, validateNote } from './note'

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const writer = stream.writable.getWriter()
  // Errors surface through the readable side below.
  writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => {})
  writer.close().catch(() => {})
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

/** `.kkj` bytes: gzip of UTF-8 JSON, defined numbers rounded. */
export const encodeKkj = (note: Note): Promise<Uint8Array> =>
  pipe(new TextEncoder().encode(JSON.stringify(toWritableJson(note))), new CompressionStream('gzip'))

/** Spec `note.formatVersion`; never throws. */
export async function decodeKkj(bytes: Uint8Array): Promise<NoteReadResult> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      await pipe(bytes, new DecompressionStream('gzip')),
    )
    return validateNote(JSON.parse(text))
  } catch {
    return { result: 'unreadable', writable: false }
  }
}
