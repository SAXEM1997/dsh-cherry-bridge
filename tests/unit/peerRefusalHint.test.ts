import { describe, expect, it } from 'vitest'
import { JsonRpcRequestError } from '../../src/rpc/jsonRpcClient.js'
import { withPeerRefusalHint } from '../../src/tools.js'

/**
 * Issue #105 ⑰: a `RESOURCE_EXHAUSTED` refusal carrying
 * `details: { kind: 'ITEM_TOO_LARGE', …, retryable: false }` (the desktop's
 * per-item byte budget, `PAGE_ITEM_BYTES` = 62,279) is a PERMANENT verdict on
 * that request. The official app's trap is to mark it retryable and re-ask at
 * the same page size forever; the surfaced sentence must say the opposite, and
 * every other refusal's text must stay exactly as it was.
 *
 * Numbering note: ⑰ here is LOCAL to this file; the ⑰a–i in
 * `tests/integration/toolsRead.test.ts` is the unrelated list-token series.
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

  it('⑰d the two permanent shapes get OPPOSITE advice (review P3-3 on PR #129)', () => {
    // ITEM_TOO_LARGE means ONE item alone exceeds the per-item budget: no
    // page size fits it (the upstream #21951 dead-end), so the message must
    // NOT recommend a smaller limit — a model following that advice burns
    // round trips and learns nothing.
    const item = refusal(TOO_LARGE)
    const itemResult = withPeerRefusalHint(item) as JsonRpcRequestError
    expect(itemResult.message).toMatch(/no page size or request shape can fetch it/)
    expect(itemResult.message).not.toMatch(/FEWER items/)

    // A permanent refusal WITHOUT the ITEM_TOO_LARGE kind may still be a page
    // that cannot fit — there the smaller-limit advice is the honest remedy.
    const page = refusal({ reason: 'RESOURCE_EXHAUSTED', details: { retryable: false } })
    const pageResult = withPeerRefusalHint(page) as JsonRpcRequestError
    expect(pageResult.message).toMatch(/FEWER items per page/)
    expect(pageResult.message).not.toMatch(/no page size or request shape/)
  })
})
