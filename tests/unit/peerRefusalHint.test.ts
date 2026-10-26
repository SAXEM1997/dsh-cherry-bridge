import { describe, expect, it } from 'vitest'
import { JsonRpcRequestError } from '../../src/rpc/jsonRpcClient.js'
import { withPeerRefusalHint } from '../../src/tools.js'

/**
 * Issue #105 ⑰: a `RESOURCE_EXHAUSTED` refusal carrying
 * `details: { kind: 'ITEM_TOO_LARGE', …, retryable: false }` (the desktop's
 * per-item byte budget, `PAGE_ITEM_BYTES` = 62 279) is a PERMANENT verdict on
 * that request. The official app's trap is to mark it retryable and re-ask at
 * the same page size forever; the surfaced sentence must say the opposite, and
 * every other refusal's text must stay exactly as it was.
 */

function refusal(data: Record<string, unknown>, message = 'Page item exceeds the response byte budget'): JsonRpcRequestError {
  return new JsonRpcRequestError(1000, message, data)
}

const TOO_LARGE = {
  reason: 'RESOURCE_EXHAUSTED',
  details: { kind: 'ITEM_TOO_LARGE', itemBytes: 70_000, budgetBytes: 62_279, retryable: false },
}

describe('withPeerRefusalHint', () => {
  it('⑰a names non-retryability for an ITEM_TOO_LARGE refusal with retryable: false', () => {
    const error = refusal(TOO_LARGE)
    const result = withPeerRefusalHint(error) as JsonRpcRequestError
    expect(result.message).toMatch(/retrying the same request cannot help/i)
    // NON-VACUOUS: the sentence names the condition that makes it true.
    expect(result.message).toMatch(/ITEM_TOO_LARGE|byte budget/)
    // The error object is the peer's own — reason, data and identity survive.
    expect(result).toBe(error)
    expect(result.data).toEqual(TOO_LARGE)
    expect(result.name).toBe('JsonRpcRequestError')
  })

  it('⑰b leaves every other refusal untouched', () => {
    const others = [
      refusal({ reason: 'RESOURCE_EXHAUSTED' }, 'Upload window exceeded'),
      refusal({ reason: 'RESOURCE_EXHAUSTED', details: { retryable: true } }, 'Busy'),
      refusal({ reason: 'RESOURCE_EXHAUSTED', details: { kind: 'ITEM_TOO_LARGE' } }, 'Legacy shape'),
      refusal({ reason: 'NOT_FOUND' }, 'Resource not found'),
      // NOT a `JsonRpcRequestError` (no `data`, no protocol identity) must pass
      // through even when its message mentions the shape — only the peer's own
      // refusal carries the structured details this hint reads.
      new JsonRpcRequestError(1000, 'RESOURCE_EXHAUSTED ITEM_TOO_LARGE retryable: false', undefined),
      new Error('a local failure'),
      'not an error',
    ]
    for (const error of others) {
      expect(withPeerRefusalHint(error)).toBe(error)
      if (error instanceof Error) expect(error.message).not.toMatch(/retrying the same request cannot help/i)
    }
  })

  it('⑰c is idempotent — applying it twice reads once', () => {
    const error = refusal(TOO_LARGE)
    withPeerRefusalHint(error)
    const once = error.message
    withPeerRefusalHint(error)
    expect(error.message).toBe(once)
  })
})
