import { describe, expect, it } from 'vitest'
import { ERROR_MESSAGE_MAX, ERROR_MESSAGE_ELLIPSIS } from '../../src/diagnostics.js'
import { projectMessageFailure } from '../../src/tools.js'

/**
 * `projectMessageFailure` is the ONE place the wire's `failure` object becomes
 * caller-facing, so its shape rules are pinned here: what is relayed, what is
 * dropped, and what a malformed payload does (it must never lose the message's
 * text — the projection is an annotation, not the content).
 */
describe('projectMessageFailure', () => {
  it('returns undefined when the peer attached no failure', () => {
    expect(projectMessageFailure({ messageId: 'm-1', status: 'success' })).toBeUndefined()
    expect(projectMessageFailure({ failure: null })).toBeUndefined()
    expect(projectMessageFailure({ failure: 'nope' })).toBeUndefined()
  })

  it('projects the verdict and drops the raw context the caller does not need', () => {
    const projected = projectMessageFailure({
      failure: {
        message: 'Provider said no',
        retryable: true,
        failure: {
          version: 1,
          reasonCode: 'provider_unavailable',
          source: { layer: 'provider', name: 'openai', code: 'sk-live-SENTINEL' },
          context: { statusCode: 503, responseBody: 'sk-live-SENTINEL' },
        },
      },
    })
    expect(projected).toEqual({
      reasonCode: 'provider_unavailable',
      retryable: true,
      message: 'Provider said no',
    })
    // The projection is a fresh object built field by field: nothing from
    // `source`/`context` can ride along by reference.
    expect(JSON.stringify(projected)).not.toContain('SENTINEL')
    expect(JSON.stringify(projected)).not.toContain('503')
  })

  it('keeps an unfamiliar but well-formed reasonCode verbatim', () => {
    // The vocabulary is the PEER's and grows with it. Relabelling a new code
    // `'unknown'` would hide a real cause behind a value that means "the peer
    // could not classify".
    expect(
      projectMessageFailure({ failure: { failure: { reasonCode: 'tool_budget_exhausted' } } }),
    ).toMatchObject({ reasonCode: 'tool_budget_exhausted' })
  })

  it('falls back to unknown when the reasonCode is absent or not an identifier', () => {
    for (const reasonCode of [undefined, '', 'Rate Limited', 'rate-limit', 7, null]) {
      expect(projectMessageFailure({ failure: { failure: { reasonCode } } })).toMatchObject({
        reasonCode: 'unknown',
      })
    }
  })

  it('bounds the message and marks the cut inside the cap', () => {
    const projected = projectMessageFailure({ failure: { message: 'x'.repeat(5000) } })!
    expect(projected.message).toHaveLength(ERROR_MESSAGE_MAX)
    expect(projected.message.endsWith(ERROR_MESSAGE_ELLIPSIS)).toBe(true)
  })

  it('is tolerant of a failure without the nested record, and of a non-string message', () => {
    expect(projectMessageFailure({ failure: { retryable: false } })).toEqual({
      reasonCode: 'unknown',
      retryable: false,
      message: '',
    })
    expect(projectMessageFailure({ failure: { message: 42 } })).toMatchObject({ message: '' })
  })

  it('projects a degenerate record the peer DID attach, and only an absent one as undefined', () => {
    // "Present exactly when the peer sent a failure": an empty object or array
    // is still an attached verdict, so it projects with defaults rather than
    // pretending the peer said nothing.
    for (const failure of [{}, []]) {
      expect(projectMessageFailure({ failure })).toEqual({
        reasonCode: 'unknown',
        retryable: false,
        message: '',
      })
    }
  })

  it('defaults retryable to false unless it is literally true', () => {
    for (const retryable of [undefined, 0, 1, 'true', {}]) {
      expect(projectMessageFailure({ failure: { retryable } })).toMatchObject({ retryable: false })
    }
  })

  it('bounds an over-long reasonCode to unknown instead of relaying it', () => {
    expect(
      projectMessageFailure({ failure: { failure: { reasonCode: 'x'.repeat(65) } } }),
    ).toMatchObject({ reasonCode: 'unknown' })
  })

  it('projects a failure regardless of the message status (presence decides, not status)', () => {
    // The peer only sends `failure` on errors, but the projection is
    // presence-based: a status this client does not expect must not make it
    // silently drop a verdict the peer did attach.
    expect(projectMessageFailure({ status: 'success', failure: { message: 'odd' } })).toMatchObject({
      message: 'odd',
    })
  })
})
