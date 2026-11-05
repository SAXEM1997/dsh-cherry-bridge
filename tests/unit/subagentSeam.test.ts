import { describe, expect, it } from 'vitest'
import {
  NO_START_CAPABILITIES,
  SUBAGENT_DIAGNOSTIC_MAX_BYTES,
  createCherryProvider,
  externalRunHandle,
  matchRoute,
  settleRunResult,
  textPrompt,
} from '../../src/subagent.js'
import type {
  CherrySubagentRoute,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from '../../src/subagent.js'

/**
 * Issue #229 — the transcription arm.
 *
 * This repository declares NO `@deepseek-ai/*` runtime dependency on purpose
 * (`src/tools.ts:46`, "Structural types, deliberately narrow"), so the subagent
 * seam is not imported from the host: the provider shape, `settleRunResult`'s
 * three-way settlement, `dispose()`'s idempotence and `matchRoute` are all
 * transcribed here. That transcription is the whole risk surface — the host can
 * change these semantics and nothing in this repo would notice.
 *
 * So every claim the transcription makes about the host is pinned by a test in
 * this file, against `@deepseek-ai/dsh-subagent@0.2.2-rc.1`'s published
 * behaviour (`lib/index.js:2803-2910` for the two helpers, `lib/types/types.d.ts`
 * for the provider contract).
 *
 * WHAT THIS DOES NOT PIN: nothing here re-reads the host at test time. A future
 * host that changes `settleRunResult`'s precedence, or adds a fifth capability,
 * drifts past these tests silently. Re-verify by reading the installed package
 * before trusting them against a new host minor.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const START = new AbortController()

/** A prompt the seam would hand a provider: text blocks only. */
const TEXT_PROMPT = [{ type: 'text' as const, text: 'do the thing' }]

/** The minimal request `provider.start` receives, for shape assertions. */
function startRequest(): SubagentStartRequest {
  return {
    cwd: '/workspace/dsh',
    prompt: TEXT_PROMPT,
    parent: {} as SubagentStartRequest['parent'],
    signal: START.signal,
  }
}

/** A settled child result, the shape `attempt()` resolves. */
function completedResult(text = 'done'): SubagentResult {
  return { output: [{ type: 'text', text }], stopReason: 'completed' }
}

/**
 * An abort signal plus the listener handle `settleRunResult` must remove.
 *
 * The listener COUNTS, and `abort()` fires the signal, so "was it removed?" is
 * observable behaviourally — an `AbortSignal` exposes no listener introspection,
 * and `settleRunResult`'s docblock promises removal on EVERY path, including the
 * ones that leave through a throw.
 */
function abortWiring(): {
  signal: AbortSignal
  onAbort: () => void
  abort: () => void
  aborts: () => number
} {
  const controller = new AbortController()
  let aborts = 0
  const onAbort = (): void => {
    aborts += 1
  }
  controller.signal.addEventListener('abort', onAbort)
  return { signal: controller.signal, onAbort, abort: () => controller.abort(), aborts: () => aborts }
}

// ---------------------------------------------------------------------------
// The capability advertisement (SUB-05, §7.1)
// ---------------------------------------------------------------------------

describe('#229 the provider advertises NO start capabilities', () => {
  it('publishes exactly the four keys, all false, frozen', () => {
    // The host rejects a start request needing any capability a provider lacks
    // (`assertCapabilities`). A provider that ADVERTISED one it cannot honour
    // would accept the request and then ignore it — the seam's docblock calls
    // that out as the thing NO_START_CAPABILITIES exists to prevent.
    expect(Object.keys(NO_START_CAPABILITIES).sort()).toEqual([
      'agentOptions',
      'agentPreset',
      'depthLimit',
      'outputSchema',
    ])
    expect(Object.values(NO_START_CAPABILITIES)).toEqual([false, false, false, false])
    expect(Object.isFrozen(NO_START_CAPABILITIES)).toBe(true)
  })

  it('registers a provider whose shape the manager accepts', () => {
    const provider = createCherryProvider({
      run: async () => ({ status: 'completed', text: 'x' }),
    })
    // `registerProvider` rejects a provider with neither execution method
    // (UNSUPPORTED_CAPABILITY), so `start` being a function is a precondition,
    // not a detail.
    expect(provider.name).toBe('cherry')
    expect(typeof provider.start).toBe('function')
    expect(provider.inheritsParentContext).toBe(false)
    expect(provider.capabilities).toEqual(NO_START_CAPABILITIES)
    // A one-shot external provider must NOT expose prepareContinuable: its
    // presence selects the local activation path, which needs a child Agent
    // this plugin does not own.
    expect('prepareContinuable' in provider).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// settleRunResult (SUB-27, §7.1)
// ---------------------------------------------------------------------------

describe('#229 settleRunResult settles three ways and never rejects', () => {
  it('passes a completed attempt through', async () => {
    const wiring = abortWiring()
    const settled = await settleRunResult({
      attempt: async () => completedResult('answer'),
      collectOutput: () => [],
      cancelled: () => false,
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('completed')
    expect(settled.output).toEqual([{ type: 'text', text: 'answer' }])
  })

  it('reports aborted when cancellation already settled, even if the attempt finished', async () => {
    // This is the arm that makes local cancellation WIN the race: the child may
    // well have produced an answer after we stopped listening, and reporting
    // that answer as `completed` would tell the parent a cancelled run succeeded.
    const wiring = abortWiring()
    const settled = await settleRunResult({
      attempt: async () => completedResult('late answer'),
      collectOutput: () => [{ type: 'text', text: 'partial' }],
      cancelled: () => true,
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('aborted')
    expect(settled.output).toEqual([{ type: 'text', text: 'partial' }])
  })

  it('flattens a rejection to error instead of rejecting', async () => {
    const wiring = abortWiring()
    const errors: string[] = []
    const settled = await settleRunResult({
      attempt: async () => {
        throw new Error('peer exploded')
      },
      collectOutput: () => [],
      cancelled: () => false,
      onError: (error) => errors.push(error.message),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('error')
    expect(errors).toEqual(['peer exploded'])
  })

  it('does NOT report an error when the failure is our own cancellation', async () => {
    // A cancelled run whose child then throws must not surface as `error`: the
    // parent asked for the cancellation, and an error would read as "the child
    // broke".
    const wiring = abortWiring()
    const errors: string[] = []
    const settled = await settleRunResult({
      attempt: async () => {
        throw new Error('aborted by transport')
      },
      collectOutput: () => [],
      cancelled: () => true,
      onError: (error) => errors.push(error.message),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('aborted')
    expect(errors).toEqual([])
  })

  it('stays non-rejecting even when the diagnostic sink throws', async () => {
    const wiring = abortWiring()
    const settled = await settleRunResult({
      attempt: async () => {
        throw new Error('boom')
      },
      collectOutput: () => [],
      cancelled: () => false,
      onError: () => {
        throw new Error('sink is broken too')
      },
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('error')
  })

  // The two COLLECTORS are the last thing that can break the never-rejecting
  // contract: `onError` is contained, but `collectOutput()` and
  // `collectDiagnostic?.()` were not, and `externalRunHandle` passes the result
  // promise straight through with no `.catch` of its own. A provider reads live
  // backend state in both, so a throw is a real possibility. Each call site gets
  // its own case, because a single test cannot pin four separate guards.
  it('does not reject when collectOutput throws on the CANCELLED success path', async () => {
    const wiring = abortWiring()
    const reported: string[] = []
    // A `cancelled()` that is true exactly ONCE, which is what SEPARATES this
    // path's guard from the catch's. Without the guard the throw escapes into
    // the catch, which re-reads `cancelled()`, finds false, and settles the run
    // as `error` — flipping a verdict the parent already caused. With the guard
    // the catch is never reached at all, so `cancelled()` is read exactly once.
    //
    // A plain `() => true` here would make the two guards INDISTINGUISHABLE
    // (both settle `aborted` with `[]`), and the guard would be untested — the
    // mutation that deletes it survived against exactly that shape.
    let reads = 0
    const settled = await settleRunResult({
      attempt: async () => completedResult('late answer nobody is listening for'),
      collectOutput: () => {
        throw new Error('snapshot unavailable')
      },
      cancelled: () => reads++ === 0,
      onError: (error) => reported.push(error.message),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(reads).toBe(1)
    expect(settled.stopReason).toBe('aborted')
    expect(settled.output).toEqual([])
    // The throw is REPORTED, not swallowed: an empty output from a broken
    // collector and an empty output from a child that produced nothing are
    // different facts, and this sink is the only place left to distinguish them.
    expect(reported).toEqual(['collectOutput() failed: snapshot unavailable'])
  })

  it('does not reject when collectOutput throws on the CANCELLED failure path', async () => {
    const wiring = abortWiring()
    const reported: string[] = []
    const settled = await settleRunResult({
      attempt: async () => {
        throw new Error('aborted by transport')
      },
      collectOutput: () => {
        throw new Error('snapshot unavailable')
      },
      cancelled: () => true,
      onError: (error) => reported.push(error.message),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('aborted')
    expect(settled.output).toEqual([])
    // The attempt's own failure stays SILENT here (we cancelled it), so the
    // collector failure is the only thing the sink hears about.
    expect(reported).toEqual(['collectOutput() failed: snapshot unavailable'])
  })

  it('does not reject when collectOutput throws on the error path', async () => {
    const wiring = abortWiring()
    const reported: string[] = []
    const settled = await settleRunResult({
      attempt: async () => {
        throw new Error('peer exploded')
      },
      collectOutput: () => {
        throw new Error('snapshot unavailable')
      },
      cancelled: () => false,
      onError: (error) => reported.push(error.message),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('error')
    expect(settled.output).toEqual([])
    expect(reported).toEqual(['peer exploded', 'collectOutput() failed: snapshot unavailable'])
  })

  it('does not reject when collectDiagnostic throws on the error path', async () => {
    const wiring = abortWiring()
    const reported: string[] = []
    const settled = await settleRunResult({
      attempt: async () => {
        throw new Error('peer exploded')
      },
      collectOutput: () => [],
      collectDiagnostic: () => {
        throw new Error('no session to read')
      },
      cancelled: () => false,
      onError: (error) => reported.push(error.message),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('error')
    // Absent, not an empty string: "there is no diagnostic" and "the diagnostic
    // is blank" are different, and the seam's ceiling applies to the former.
    expect(settled.diagnostic).toBeUndefined()
    expect(reported).toEqual(['peer exploded', 'collectDiagnostic() failed: no session to read'])
  })

  it('never reads collectDiagnostic when the run was cancelled', async () => {
    // The diagnostic describes a FAILURE. A run we cancelled did not fail, and a
    // cancelled child is exactly the case where the backend read behind that
    // diagnostic is most likely to fail too (the session may already be gone), so
    // consulting it would buy a second exception for information nothing reports.
    // Both cancelled arms are driven: the success one and the throwing one.
    for (const attempt of [
      async (): Promise<SubagentResult> => completedResult('late answer'),
      async (): Promise<SubagentResult> => {
        throw new Error('aborted by transport')
      },
    ]) {
      const wiring = abortWiring()
      let diagnosticReads = 0
      const settled = await settleRunResult({
        attempt,
        collectOutput: () => [],
        collectDiagnostic: () => {
          diagnosticReads += 1
          return 'never reported'
        },
        cancelled: () => true,
        signal: wiring.signal,
        onAbort: wiring.onAbort,
      })
      expect(settled.stopReason).toBe('aborted')
      expect(settled.diagnostic).toBeUndefined()
      expect(diagnosticReads).toBe(0)
    }
  })

  it('removes the abort listener even when a collector throws', async () => {
    // The `finally` is the one guard a collector's throw cannot skip — but only
    // if it is actually reached, and only if nothing between the throw and it
    // leaves the function early. Firing the signal afterwards is the only
    // behavioural way to see it: a still-attached listener would count.
    const wiring = abortWiring()
    const settled = await settleRunResult({
      attempt: async () => {
        throw new Error('peer exploded')
      },
      collectOutput: () => {
        throw new Error('snapshot unavailable')
      },
      cancelled: () => false,
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('error')
    wiring.abort()
    expect(wiring.aborts()).toBe(0)
  })

  it('clips a provider diagnostic to the seam byte ceiling without splitting a character', async () => {
    // The host caps `diagnostic` at 4096 UTF-8 BYTES. A Chinese character is
    // three bytes, so a character-count clip would overshoot by 3x — and a
    // byte-slice would cut one in half. 3000 CJK chars is 9000 bytes.
    const wiring = abortWiring()
    const settled = await settleRunResult({
      attempt: async () => {
        throw new Error('x')
      },
      collectOutput: () => [],
      collectDiagnostic: () => '诊'.repeat(3_000),
      cancelled: () => false,
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    const diagnostic = settled.diagnostic ?? ''
    expect(new TextEncoder().encode(diagnostic).byteLength).toBeLessThanOrEqual(SUBAGENT_DIAGNOSTIC_MAX_BYTES)
    expect(diagnostic.length).toBeGreaterThan(0)
    // No U+FFFD: a half-cut code point would decode to a replacement character.
    expect(diagnostic).not.toContain('\uFFFD')
  })
})

// ---------------------------------------------------------------------------
// externalRunHandle (§7.1)
// ---------------------------------------------------------------------------

describe('#229 externalRunHandle disposes exactly once', () => {
  it('memoizes teardown and settles cancellation on the first dispose', async () => {
    const wiring = abortWiring()
    let teardowns = 0
    let cancels = 0
    const run: SubagentRun = externalRunHandle({
      id: 'run-1',
      result: Promise.resolve(completedResult()),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
      requestCancel: () => {
        cancels += 1
      },
      teardown: async () => {
        teardowns += 1
      },
    })
    const first = run.dispose()
    const second = run.dispose()
    // Identity, not just equality: the seam's `dispose()` is documented as
    // idempotent, and a second teardown would double-release the child.
    expect(second).toBe(first)
    await first
    expect(teardowns).toBe(1)
    // `requestCancel` runs BEFORE teardown, and only once: it is what makes the
    // result settle without assuming the child cooperates.
    expect(cancels).toBe(1)
  })

  it('keeps the run id and result on the handle', async () => {
    const wiring = abortWiring()
    const result = Promise.resolve(completedResult('kept'))
    const run = externalRunHandle({
      id: 'run-2',
      result,
      signal: wiring.signal,
      onAbort: wiring.onAbort,
      requestCancel: () => {},
      teardown: async () => {},
    })
    expect(run.id).toBe('run-2')
    expect(run.result).toBe(result)
  })
})

// ---------------------------------------------------------------------------
// matchRoute (SUB-10..14)
// ---------------------------------------------------------------------------

const DEFAULT_ROUTE: CherrySubagentRoute = { cwdPrefix: '/nowhere', workspaceId: 'default-ws' }

describe('#229 matchRoute picks the first declared prefix at a path boundary', () => {
  it('takes the FIRST declared match, not the longest (SUB-10)', () => {
    const routes: CherrySubagentRoute[] = [
      { cwdPrefix: '/workspace', workspaceId: 'outer' },
      { cwdPrefix: '/workspace/dsh', workspaceId: 'inner' },
    ]
    expect(matchRoute(routes, '/workspace/dsh/src')?.workspaceId).toBe('outer')
  })

  it('does not match a sibling that merely shares a string prefix (SUB-10)', () => {
    // `/workspace/dsh2` starts with `/workspace/dsh` as a STRING but is not
    // inside it. Matching it would silently route a delegation into the wrong
    // Cherry workspace.
    const routes: CherrySubagentRoute[] = [{ cwdPrefix: '/workspace/dsh', workspaceId: 'dsh' }]
    expect(matchRoute(routes, '/workspace/dsh2/project')).toBeUndefined()
    expect(matchRoute(routes, '/workspace/dsh')).toBeDefined()
  })

  it('accepts a route that overrides only the workspace (SUB-11)', () => {
    const routes: CherrySubagentRoute[] = [{ cwdPrefix: '/workspace/dsh', workspaceId: 'only-ws' }]
    const matched = matchRoute(routes, '/workspace/dsh')
    expect(matched?.workspaceId).toBe('only-ws')
    expect(matched?.device).toBeUndefined()
  })

  it('returns undefined when nothing matches, so the caller falls back (SUB-12)', () => {
    expect(matchRoute([DEFAULT_ROUTE], '/workspace/dsh')).toBeUndefined()
  })

  it('tolerates an absent or empty route table (SUB-13)', () => {
    expect(matchRoute(undefined, '/workspace/dsh')).toBeUndefined()
    expect(matchRoute([], '/workspace/dsh')).toBeUndefined()
  })

  it('normalizes both sides before comparing, and stays case-sensitive (SUB-14)', () => {
    const routes: CherrySubagentRoute[] = [{ cwdPrefix: '/workspace/dsh/', workspaceId: 'dsh' }]
    // Trailing slash on the prefix, `..` in the cwd, redundant separators.
    expect(matchRoute(routes, '/workspace/./dsh/src')?.workspaceId).toBe('dsh')
    expect(matchRoute(routes, '/workspace/other/../dsh')?.workspaceId).toBe('dsh')
    expect(matchRoute(routes, '//workspace//dsh//src')?.workspaceId).toBe('dsh')
    // Case differs ⇒ no match. A case-insensitive compare would route on a
    // filesystem that is not the one the user declared.
    expect(matchRoute(routes, '/Workspace/DSH')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// textPrompt (SUB-20, SUB-21)
// ---------------------------------------------------------------------------

describe('#229 textPrompt refuses anything the seam cannot carry', () => {
  it('joins multiple text blocks in order', () => {
    expect(
      textPrompt([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('firstsecond')
  })

  it('rejects a non-text block', () => {
    // The provider runs BEFORE creating anything on the Cherry side, so this
    // must throw rather than degrade: an image block cannot be carried, and
    // silently dropping it would hand the child a different task.
    expect(() => textPrompt([{ type: 'image', source: 'x' } as never])).toThrow(/text/)
  })

  it('rejects an empty prompt', () => {
    expect(() => textPrompt([])).toThrow()
  })

  it('rejects a prompt that is only whitespace', () => {
    expect(() => textPrompt([{ type: 'text', text: '  \n\t ' }])).toThrow()
  })
})

// ---------------------------------------------------------------------------
// start(): the pre-wire skeleton's two guarantees (SUB-20/21 hold end to end)
// ---------------------------------------------------------------------------

describe('#229 start rejects an unusable prompt before it builds anything', () => {
  it('throws on a non-text prompt without invoking the runner', async () => {
    let ran = 0
    const provider = createCherryProvider({
      run: async () => {
        ran += 1
        return { status: 'completed', text: 'x' }
      },
    })
    await expect(
      provider.start({ ...startRequest(), prompt: [{ type: 'image', source: 'x' } as never] }),
    ).rejects.toThrow(/text/)
    expect(ran).toBe(0)
  })

  it('throws on an aborted request without invoking the runner', async () => {
    let ran = 0
    const provider = createCherryProvider({
      run: async () => {
        ran += 1
        return { status: 'completed', text: 'x' }
      },
    })
    const aborted = new AbortController()
    aborted.abort()
    // The MESSAGE is the assertion, not merely "it throws": while the run seam
    // is unwired every path ends in the same placeholder error, so a bare
    // `.toThrow()` passes with the aborted guard deleted (found by mutation).
    await expect(provider.start({ ...startRequest(), signal: aborted.signal })).rejects.toThrow(/aborted/)
    expect(ran).toBe(0)
  })
})
