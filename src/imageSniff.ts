/**
 * Identify a raster image from its own first bytes (#396).
 *
 * The peer types an attachment from its NAME, so a file with no extension — or
 * one whose extension the desktop does not map — arrives as
 * `application/octet-stream` even when the bytes are a perfectly good PNG. The
 * image face used to take that label at its word and drop the picture silently.
 *
 * This reads a prefix and nothing else: no decode, no pixel validation, no
 * allocation beyond the slice it was handed. A format it does not know is
 * `undefined`, which callers must treat as "no claim", never as "not an image".
 *
 * The list is deliberately short — the formats a desktop actually uploads and a
 * host store accepts. Adding one is a line here plus a case in the unit test.
 */
export function imageMediaTypeFromHeader(bytes: Uint8Array): string | undefined {
  // PNG: the 8-byte signature, chosen to survive a 7-bit transport.
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  // JPEG: SOI then the first marker prefix. The third byte rules out a bare
  // 0xFFD8 that is not a JPEG stream.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF: "GIF87a" or "GIF89a".
  if (
    startsWith(bytes, 0, [0x47, 0x49, 0x46, 0x38]) &&
    bytes.length >= 6 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif'
  }
  // WebP: a RIFF container whose form type is "WEBP".
  if (
    startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'image/webp'
  }
  // BMP: "BM", the weakest of the signatures, kept last so nothing above it
  // depends on two bytes agreeing.
  if (startsWith(bytes, 0, [0x42, 0x4d])) return 'image/bmp'
  return undefined
}

function startsWith(bytes: Uint8Array, at: number, magic: readonly number[]): boolean {
  if (bytes.length < at + magic.length) return false
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[at + index] !== magic[index]) return false
  }
  return true
}
