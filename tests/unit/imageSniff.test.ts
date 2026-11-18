import { describe, expect, it } from 'vitest'
import { imageMediaTypeFromHeader } from '../../src/imageSniff.js'

/** A magic prefix padded with bytes that belong to no signature. */
function bytes(magic: readonly number[], pad = 16): Uint8Array {
  const out = new Uint8Array(magic.length + pad)
  out.set(magic, 0)
  for (let index = magic.length; index < out.length; index += 1) out[index] = 0x7f
  return out
}

describe('issue #396: imageMediaTypeFromHeader', () => {
  it('names each format the face accepts', () => {
    expect(imageMediaTypeFromHeader(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    )
    expect(imageMediaTypeFromHeader(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(imageMediaTypeFromHeader(bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    expect(imageMediaTypeFromHeader(bytes([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe('image/gif')
    expect(
      imageMediaTypeFromHeader(
        bytes([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe('image/webp')
    expect(imageMediaTypeFromHeader(bytes([0x42, 0x4d]))).toBe('image/bmp')
  })

  it('claims nothing for bytes that name no format', () => {
    expect(imageMediaTypeFromHeader(new TextEncoder().encode('this is not a picture'))).toBeUndefined()
    expect(imageMediaTypeFromHeader(new Uint8Array(0))).toBeUndefined()
    // A RIFF container that is not WebP (e.g. a WAV) is not an image.
    expect(
      imageMediaTypeFromHeader(
        bytes([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]),
      ),
    ).toBeUndefined()
  })

  it('does not throw on a prefix shorter than the signature it is testing', () => {
    // Every one of these is the START of a real signature, cut short.
    expect(imageMediaTypeFromHeader(new Uint8Array([0x89, 0x50]))).toBeUndefined()
    expect(imageMediaTypeFromHeader(new Uint8Array([0xff, 0xd8]))).toBeUndefined()
    expect(imageMediaTypeFromHeader(new Uint8Array([0x47, 0x49, 0x46]))).toBeUndefined()
    expect(imageMediaTypeFromHeader(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00]))).toBeUndefined()
    // A two-byte prefix is enough for BMP, and that is the format's real test.
    expect(imageMediaTypeFromHeader(new Uint8Array([0x42, 0x4d]))).toBe('image/bmp')
  })
})
