import { describe, expect, it } from 'vitest'
import { MESSAGE_TEXT_MAX_CHARS } from '../../src/defaults.js'
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
  CherryProviderDeps,
  CherrySubagentRoute,
  CherrySubagentRunOutcome,
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
      onError: (error, stopReason) => reported.push(`${stopReason}: ${error.message}`),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(reads).toBe(1)
    expect(settled.stopReason).toBe('aborted')
    expect(settled.output).toEqual([])
    // The throw is REPORTED, not swallowed: an empty output from a broken
    // collector and an empty output from a child that produced nothing are
    // different facts, and this sink is the only place left to distinguish them.
    expect(reported).toEqual(['aborted: collectOutput() failed: snapshot unavailable'])
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
      onError: (error, stopReason) => reported.push(`${stopReason}: ${error.message}`),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('aborted')
    expect(settled.output).toEqual([])
    // The attempt's own failure stays SILENT here (we cancelled it), so the
    // collector failure is the only thing the sink hears about.
    expect(reported).toEqual(['aborted: collectOutput() failed: snapshot unavailable'])
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
      onError: (error, stopReason) => reported.push(`${stopReason}: ${error.message}`),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('error')
    expect(settled.output).toEqual([])
    expect(reported).toEqual(['error: peer exploded', 'error: collectOutput() failed: snapshot unavailable'])
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
      onError: (error, stopReason) => reported.push(`${stopReason}: ${error.message}`),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('error')
    // Absent, not an empty string: "there is no diagnostic" and "the diagnostic
    // is blank" are different, and the seam's ceiling applies to the former.
    expect(settled.diagnostic).toBeUndefined()
    expect(reported).toEqual(['error: peer exploded', 'error: collectDiagnostic() failed: no session to read'])
  })

  it('does not reject when the sink throws while reporting a collector failure', async () => {
    // Two containments in a row: the collector throws, and the sink told about it
    // throws too. The second is the one this pins — the report runs inside the
    // collector's own catch, so a bare sink call there would escape from it and
    // turn a settled failure into a rejection.
    const wiring = abortWiring()
    const seen: Array<{ message: string; cause: unknown }> = []
    const settled = await settleRunResult({
      attempt: async () => {
        throw new Error('peer exploded')
      },
      collectOutput: () => {
        throw new Error('snapshot unavailable')
      },
      cancelled: () => false,
      onError: (error) => {
        seen.push({ message: error.message, cause: error.cause })
        throw new Error('sink is broken too')
      },
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('error')
    expect(settled.output).toEqual([])
    expect(seen.map((entry) => entry.message)).toEqual([
      'peer exploded',
      'collectOutput() failed: snapshot unavailable',
    ])
    // The re-wrap keeps the original as `cause`: this path reads live backend
    // state, so it is the path an operator will need to investigate, and a
    // message alone would throw away the stack that says where.
    expect((seen[1]?.cause as Error).message).toBe('snapshot unavailable')
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

  it('clips a diagnostic the ATTEMPT returned on the success arm too', async () => {
    // `settleRunResult` clips in two places: the collected diagnostic on the
    // failure arm, and one the provider put on a SUCCESSFUL result. Only the
    // first was covered — deleting the second left all 29 seam cases green.
    // A provider may legitimately finish `completed` and still explain itself
    // (a child that declined the task), so this arm is reachable, not dead.
    const wiring = abortWiring()
    const settled = await settleRunResult({
      attempt: async () => ({
        output: [{ type: 'text', text: 'done' }],
        stopReason: 'completed' as const,
        diagnostic: '诊'.repeat(3_000),
      }),
      collectOutput: () => [],
      cancelled: () => false,
      signal: wiring.signal,
      onAbort: wiring.onAbort,
    })
    expect(settled.stopReason).toBe('completed')
    const diagnostic = settled.diagnostic ?? ''
    expect(new TextEncoder().encode(diagnostic).byteLength).toBeLessThanOrEqual(SUBAGENT_DIAGNOSTIC_MAX_BYTES)
    expect(diagnostic.length).toBeGreaterThan(0)
    expect(diagnostic).not.toContain('\uFFFD')
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
    // The SEQUENCE, not two counters. Counting alone cannot tell
    // `requestCancel()`-then-`teardown()` from the reverse, and the order IS the
    // contract: local cancellation has to settle `result` BEFORE teardown is
    // awaited, because there is no assumption the child cooperates — a teardown
    // that waits for a child which is waiting for us is a deadlock. A coverage
    // review found this case green with the two lines swapped.
    const calls: string[] = []
    const run: SubagentRun = externalRunHandle({
      id: 'run-1',
      result: Promise.resolve(completedResult()),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
      requestCancel: () => {
        calls.push('cancel')
      },
      teardown: async () => {
        calls.push('teardown')
      },
    })
    const first = run.dispose()
    const second = run.dispose()
    // Identity, not just equality: the seam's `dispose()` is documented as
    // idempotent, and a second teardown would double-release the child.
    expect(second).toBe(first)
    await first
    expect(calls).toEqual(['cancel', 'teardown'])
  })

  it('awaits teardown — dispose settles only once the child is down', async () => {
    // The seam's third contract is "runs until the child has ACTUALLY stopped".
    // A fire-and-forget `disposal = parts.teardown()` satisfies every counting
    // assertion above while returning before the child is down, so the await is
    // pinned on its own.
    const wiring = abortWiring()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = externalRunHandle({
      id: 'run-3',
      result: Promise.resolve(completedResult()),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
      requestCancel: () => {},
      teardown: () => gate,
    })
    let disposed = false
    const disposal = run.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await disposal
    expect(disposed).toBe(true)
  })

  it('a teardown that throws SYNCHRONOUSLY is memoized too, not re-run', async () => {
    // Assigning `parts.teardown()` bare leaves the memo undefined when the call
    // throws before returning a promise, so a second `dispose()` runs a second
    // teardown against a child the first may have half-released.
    const wiring = abortWiring()
    let teardowns = 0
    const run = externalRunHandle({
      id: 'run-5',
      result: Promise.resolve(completedResult()),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
      requestCancel: () => {},
      teardown: (() => {
        teardowns += 1
        throw new Error('teardown threw before returning')
      }) as () => Promise<void>,
    })
    await expect(run.dispose()).rejects.toThrow('teardown threw before returning')
    await expect(run.dispose()).rejects.toThrow('teardown threw before returning')
    expect(teardowns).toBe(1)
  })

  it('a teardown that rejects rejects dispose, and a second call does not retry', async () => {
    // Memoizing the promise means the failure is delivered to every caller
    // rather than re-attempted: a retry would run a second teardown against a
    // child the first one may have half-released.
    const wiring = abortWiring()
    let teardowns = 0
    const run = externalRunHandle({
      id: 'run-4',
      result: Promise.resolve(completedResult()),
      signal: wiring.signal,
      onAbort: wiring.onAbort,
      requestCancel: () => {},
      teardown: async () => {
        teardowns += 1
        throw new Error('teardown blew up')
      },
    })
    await expect(run.dispose()).rejects.toThrow('teardown blew up')
    await expect(run.dispose()).rejects.toThrow('teardown blew up')
    expect(teardowns).toBe(1)
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
  it('returns the whole route, so a device override reaches the caller (SUB-11)', () => {
    // `matchRoute` hands back the DECLARED object; the delegation reads
    // `route.device` and `route.workspaceId` off it. A route carrying only a
    // device must not lose it on the way out.
    const routes: CherrySubagentRoute[] = [{ cwdPrefix: '/w/dsh', device: 'desk-2' }]
    expect(matchRoute(routes, '/w/dsh/src')?.device).toBe('desk-2')
  })

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

// ---------------------------------------------------------------------------
// The wired provider (#231)
// ---------------------------------------------------------------------------

/**
 * A `deps.run` stand-in: it records what it was asked and answers what the case
 * says. The REAL runner is `tests/integration/subagentRun.test.ts` — this file
 * pins only what the provider does with its answer, which is the mapping and the
 * two signals.
 */
function runnerStub(answer: (input: { signal: AbortSignal }) => Promise<CherrySubagentRunOutcome>): {
  deps: CherryProviderDeps
  calls: Array<{ text: string; cwd: string; label: string | undefined; signal: AbortSignal }>
} {
  const calls: Array<{ text: string; cwd: string; label: string | undefined; signal: AbortSignal }> = []
  return {
    calls,
    deps: {
      run: (input) => {
        calls.push(input)
        return answer(input)
      },
    },
  }
}

/** A request the provider will accept, with the caller's own controller. */
function providerRequest(overrides: Partial<SubagentStartRequest> = {}): SubagentStartRequest {
  return {
    cwd: '/w/dsh',
    prompt: [{ type: 'text', text: 'summarise the repo' }],
    parent: {},
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('#231 a task the peer could never accept is refused before anything exists', () => {
  it('⑤0 an over-long task throws, and the runner is never called', async () => {
    // The peer's schema refuses a body over 32,768 characters, so a task
    // assembled by a model would come back as a schema error from the wire —
    // AFTER a Cherry session had been created for it. Refusing here is the same
    // judgement the empty-task rule makes, one dimension over.
    const { deps, calls } = runnerStub(async () => ({ status: 'completed', text: 'never' }))
    const prompt = [{ type: 'text', text: 'x'.repeat(MESSAGE_TEXT_MAX_CHARS + 1) }]
    await expect(createCherryProvider(deps).start(providerRequest({ prompt }))).rejects.toThrow('32768')
    expect(calls).toHaveLength(0)
  })

  it('⑤1 exactly the ceiling is accepted', async () => {
    const { deps, calls } = runnerStub(async () => ({ status: 'completed', text: 'ok' }))
    const prompt = [{ type: 'text', text: 'x'.repeat(MESSAGE_TEXT_MAX_CHARS) }]
    const run = await createCherryProvider(deps).start(providerRequest({ prompt }))
    await run.result
    expect(calls).toHaveLength(1)
  })
})

describe('#231 the provider maps the runner’s answer onto the seam', () => {
  it('⑥a a completed run becomes `completed` with the run’s text as one block (SUB-22)', async () => {
    const { deps } = runnerStub(async () => ({ status: 'completed', text: 'the answer' }))
    const run = await createCherryProvider(deps).start(providerRequest())
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'the answer' }],
      stopReason: 'completed',
    })
  })

  it('⑥b the task, the cwd and the label all reach the runner', async () => {
    const { deps, calls } = runnerStub(async () => ({ status: 'completed', text: 'ok' }))
    const run = await createCherryProvider(deps).start(providerRequest({ label: 'a caption' }))
    await run.result
    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toBe('summarise the repo')
    expect(calls[0]?.cwd).toBe('/w/dsh')
    expect(calls[0]?.label).toBe('a caption')
  })

  it('⑥c an error outcome carries its diagnostic and never rejects (SUB-27/52)', async () => {
    const { deps } = runnerStub(async () => ({
      status: 'error',
      text: '',
      diagnostic: 'the run ended failed: RESOURCE_EXHAUSTED',
    }))
    const run = await createCherryProvider(deps).start(providerRequest())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.output).toEqual([])
    expect(result.diagnostic).toContain('RESOURCE_EXHAUSTED')
  })

  it('⑥d a runner that cannot even start settles as an error, not a rejection', async () => {
    // An unreachable device or a refused session: the handle already exists, so
    // the seam's "fail after returning means settle through result" applies. The
    // runner's message is the only account of why, so it becomes the diagnostic.
    const { deps } = runnerStub(async () => {
      throw new Error('cherry subagent: the target device is unavailable (device-not-found)')
    })
    const run = await createCherryProvider(deps).start(providerRequest())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('device-not-found')
  })

  it('⑥e a `completed` result carries NO diagnostic, whatever the runner said', async () => {
    // The host appends a result's diagnostic to the settlement notification, so
    // one on a success reaches the parent as an unexplained warning.
    const { deps } = runnerStub(async () => ({ status: 'completed', text: 'fine', diagnostic: 'noise' }))
    const run = await createCherryProvider(deps).start(providerRequest())
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.diagnostic).toBeUndefined()
  })
})

describe('#231 cancellation is the provider’s own signal (SUB-25/26)', () => {
  it('⑦a a parent abort reaches the runner and the run settles `aborted`', async () => {
    const controller = new AbortController()
    const { deps, calls } = runnerStub(
      (input) =>
        new Promise((resolve) => {
          input.signal.addEventListener('abort', () => resolve({ status: 'aborted', text: 'partial' }), {
            once: true,
          })
        }),
    )
    const run = await createCherryProvider(deps).start(providerRequest({ signal: controller.signal }))
    controller.abort()
    const result = await run.result
    expect(calls[0]?.signal.aborted).toBe(true)
    expect(result.stopReason).toBe('aborted')
    // The partial the runner reported rides along (SUB-25's "取已收到的部分").
    expect(result.output).toEqual([{ type: 'text', text: 'partial' }])
  })

  it('⑦b dispose stops the child WITHOUT the parent’s signal firing, and settles `aborted`', async () => {
    // The host disposes a run for reasons of its own, so a provider that only
    // forwarded `request.signal` would leave the child running and then report a
    // `completed` nobody is listening for.
    let observed: AbortSignal | undefined
    const { deps } = runnerStub(
      (input) =>
        new Promise((resolve) => {
          observed = input.signal
          input.signal.addEventListener('abort', () => resolve({ status: 'aborted', text: '' }), { once: true })
        }),
    )
    const run = await createCherryProvider(deps).start(providerRequest())
    expect(observed?.aborted).toBe(false)
    await run.dispose()
    expect(observed?.aborted).toBe(true)
    await expect(run.result).resolves.toEqual({ output: [], stopReason: 'aborted' })
  })

  it('⑦b2 a child that answers AFTER a dispose is still `aborted`, never `completed`', async () => {
    // The seam's rule: a run we stopped listening to did not succeed, even when
    // the child had in fact finished. `⑦b` cannot see this — the runner there
    // reports `aborted` itself, so the mapping and the cancellation agree — which
    // is why this case lets the runner answer `completed` on purpose.
    let release: () => void = () => {}
    const { deps } = runnerStub(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 'completed', text: 'the late answer' })
        }),
    )
    const run = await createCherryProvider(deps).start(providerRequest())
    const disposal = run.dispose()
    release()
    await disposal
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    // The partial is still reported — the text arrived, we simply stopped
    // treating it as a success.
    expect(result.output).toEqual([{ type: 'text', text: 'the late answer' }])
  })

  it('⑦c dispose waits for the runner to actually stop', async () => {
    let release: () => void = () => {}
    const { deps } = runnerStub(
      (input) =>
        new Promise((resolve) => {
          release = () => resolve({ status: 'aborted', text: '' })
          input.signal.addEventListener('abort', () => release(), { once: true })
        }),
    )
    const run = await createCherryProvider(deps).start(providerRequest())
    let disposed = false
    const disposal = run.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await disposal
    expect(disposed).toBe(true)
  })
})
