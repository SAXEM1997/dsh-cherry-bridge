import { describe, expect, it } from 'vitest'
import { JsonRpcRequestError } from '../../src/rpc/jsonRpcClient.js'
import { withRateLimitHint } from '../../src/tools.js'

/**
 * `withRateLimitHint` is the ONE place a command's `RATE_LIMITED` refusal grows
 * the actionable half (issue #109), so its limits are pinned here: WHICH
 * failures get it, what it adds, and — just as load-bearing — that nothing else
 * about the error moves.
 *
 * The tool path itself is proven by `tests/integration/toolsInteract.test.ts` ⑰
 * (a refused `cherry_send` through the real engine). These cases cover the
 * branches a peer cannot easily be told to produce: an absent or unusable
 * `retryAfterMs`, another reason code, a non-Error, and a second application.
 */
describe('withRateLimitHint', () => {
  const refusal = (data: unknown): JsonRpcRequestError =>
    new JsonRpcRequestError(-32000, 'Request rate exceeded', data)

  it('appends the not-applied fact, the wait and the cause, keeping prefix, identity and data', () => {
    const error = refusal({ reason: 'RATE_LIMITED', retryAfterMs: 250 })
    const data = error.data
    const result = withRateLimitHint(error)

    // The SAME object, like the IDEMPOTENCY_CONFLICT hint beside it: a rewrap
    // would cost the prototype and with it every `instanceof` and
    // `data.reason` branch downstream.
    expect(result).toBe(error)
    expect(error.data).toBe(data)
    expect((error.data as { reason: string }).reason).toBe('RATE_LIMITED')
    // The peer's own text stays a PREFIX: prose is appended, never substituted.
    expect(error.message).toMatch(/^Request rate exceeded — /)
    expect(error.message).toContain('this attempt was not applied')
    expect(error.message).toContain('SAME commandId')
    expect(error.message).toContain('Wait about 250 ms')
    expect(error.message).toContain('rateBudgetPerSecond')
  })

  it('names no wait when the peer sent no USABLE retryAfterMs', () => {
    // A number the caller can act on, or nothing: inventing a delay would be a
    // promise the peer never made, and printing the raw value would hand the
    // model `undefined`, `NaN` or `soon` as though it were milliseconds.
    for (const data of [
      { reason: 'RATE_LIMITED' },
      { reason: 'RATE_LIMITED', retryAfterMs: 'soon' },
      { reason: 'RATE_LIMITED', retryAfterMs: -1 },
      { reason: 'RATE_LIMITED', retryAfterMs: 0 },
      { reason: 'RATE_LIMITED', retryAfterMs: Number.NaN },
      { reason: 'RATE_LIMITED', retryAfterMs: null },
    ]) {
      const error = withRateLimitHint(refusal(data)) as JsonRpcRequestError
      expect(error.message).toContain('this attempt was not applied')
      expect(error.message).not.toContain('Wait about')
      expect(error.message).not.toContain('undefined')
      expect(error.message).not.toContain('NaN')
      expect(error.message).not.toContain('soon')
    }
  })

  it('rounds a fractional retryAfterMs UP, never down', () => {
    // The desktop hands back a wall-clock remainder, which is fractional in
    // practice. Truncating it would name a delay SHORTER than the one we were
    // asked for, i.e. advise a retry that the same window refuses again.
    const error = withRateLimitHint(refusal({ reason: 'RATE_LIMITED', retryAfterMs: 250.4 })) as JsonRpcRequestError
    expect(error.message).toContain('Wait about 251 ms')
  })

  it('leaves every other failure untouched, reason-shaped data or not', () => {
    for (const data of [{ reason: 'NOT_FOUND' }, { reason: 'CONFLICT' }, { reason: 'RATE_LIMITED_DETAIL' }, null, 'nope', {}, []]) {
      const error = refusal(data)
      const before = error.message
      expect(withRateLimitHint(error)).toBe(error)
      expect(error.message).toBe(before)
    }
  })

  it('passes a non-Error through untouched', () => {
    expect(withRateLimitHint('boom')).toBe('boom')
    expect(withRateLimitHint(undefined)).toBeUndefined()
  })

  it('is idempotent: a caller that hints twice reads it once', () => {
    const error = refusal({ reason: 'RATE_LIMITED', retryAfterMs: 5 })
    withRateLimitHint(error)
    const once = error.message
    withRateLimitHint(error)
    expect(error.message).toBe(once)
    expect(error.message.match(/refuses BEFORE dispatch/g)).toHaveLength(1)
  })
})
