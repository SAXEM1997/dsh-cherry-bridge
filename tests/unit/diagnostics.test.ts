import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildDiagnostics,
  digestIdentity,
  readScopeSegment,
  sanitizeDevice,
  sanitizeDiagnostics,
  DIAGNOSTICS_DEVICE_KEYS,
  ERROR_MESSAGE_MAX,
  SCOPE_UPGRADE_HINT,
} from '../../src/diagnostics.js'
import type { DiagnosticsScope, DiagnosticsSources } from '../../src/diagnostics.js'
import type { DeviceRecord } from '../../src/deviceStore.js'
import { ToolScopeState } from '../../src/toolScope.js'

/**
 * The diagnostics redaction helpers, unit-tested at their own seam.
 *
 * `digestIdentity` is the ONE place a raw pinned identity crosses into the
 * report: it must either produce the 12-hex stand-in for a REAL identity or say
 * plainly that there is none. The empty string is the case that matters — an
 * absent `desktopIdentity` digests to the fixed hash of `''`, a plausible
 * 12-hex string that reads to an operator as a real (if odd) identity rather
 * than as "this device has no pinned peer identity".
 */

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    schemaVersion: 2,
    deviceId: 'dev-1',
    displayName: 'Workstation',
    hosts: ['192.168.1.20'],
    port: 8765,
    desktopIdentity: 'desktop-abc',
    grants: ['agent'],
    enabled: true,
    ...overrides,
  }
}

describe('final review: digestIdentity on an absent identity', () => {
  it('R10: the empty identity reports `unknown` instead of a plausible digest', () => {
    // 12 hex chars is the digest's own shape, so the digest of `''` is
    // indistinguishable from a real identity in the report.
    expect(digestIdentity('')).toBe('unknown')
  })

  it('R10b: a real identity still digests to 12 hex characters', () => {
    const digest = digestIdentity('desktop-abc')
    expect(digest).toMatch(/^[0-9a-f]{12}$/)
    // Distinct inputs stay distinguishable — the property the report relies on.
    expect(digest).not.toBe(digestIdentity('desktop-abd'))
  })

  it('R10c: a device with no pinned identity reports `unknown` through sanitizeDevice', () => {
    const projected = sanitizeDevice(record({ desktopIdentity: '' }), 'offline')
    expect(projected.desktopIdentity).toBe('unknown')
  })
})

describe('F2-6c: the device whitelist describes the shape sanitizeDevice really emits', () => {
  it('lists every key the projection produces, `limits` included, and nothing it does not', () => {
    const projected = sanitizeDevice(record(), 'connected', {
      heartbeatMs: 20_000,
      subscriptions: 8,
      pageItems: 100,
      inFlightRequests: 8,
      messageSummaries: 1,
    })

    // The whitelist is a statement about what MAY appear. A field the projection
    // emits but the list omits makes the list wrong — and `limits` was exactly
    // that: the negotiated caps reach every report, but a reader of this list
    // would conclude they never do.
    expect([...DIAGNOSTICS_DEVICE_KEYS].sort()).toEqual(Object.keys(projected).sort())
    expect(DIAGNOSTICS_DEVICE_KEYS).toContain('limits')
    // And the credential fields are still absent from both.
    expect(Object.keys(projected)).not.toContain('accessToken')
    expect(Object.keys(projected)).not.toContain('tokenExpiresAt')
  })
})

describe('fix round 2: a throwing source degrades its own section only', () => {
  /** The smallest source set that satisfies `DiagnosticsSources`. */
  const sourcesWith = (overrides: Partial<DiagnosticsSources>): DiagnosticsSources =>
    ({
      store: { list: () => [] },
      connect: () => ({ state: 'offline' as const }),
      stats: () => ({}),
      sessions: () => [],
      recentErrors: () => [],
      ...overrides,
    }) as unknown as DiagnosticsSources

  it('a store whose list() throws degrades the device section instead of failing the report', () => {
    // THE POINT OF THE GUARD: this endpoint is opened exactly when something is
    // wrong, so it must not be the thing that fails. Every OTHER source is read
    // through a guard (sessions/stats/recentErrors below); `store.list()` was the
    // one that could still throw out of `buildDiagnostics` as a 500.
    const report = buildDiagnostics(
      sourcesWith({
        store: {
          list: () => {
            throw new Error('the archive resolver exploded')
          },
        } as unknown as DiagnosticsSources['store'],
        stats: () => ({ connections: 3 }),
        recentErrors: () => [],
      }),
    )

    // The section is empty-but-present, and the REST of the report still went out.
    expect(report.devices).toEqual([])
    expect(report.stats.connections).toBe(3)
    expect(report.plugin.name).toBe('dsh-cherry-bridge')
  })
})

// ---------------------------------------------------------------------------
// Task 9 ①②③: the enablement-scope segment (`DiagnosticsReport.scope`)
// ---------------------------------------------------------------------------

/** A REAL scope state whose document file does not exist ⇒ `DEFAULT_SCOPE`. */
function freshScope(): ToolScopeState {
  return new ToolScopeState({ file: join(tmpdir(), `dsh-scope-diag-${randomUUID()}.json`) })
}

/** The smallest source set that satisfies `DiagnosticsSources`, overridable. */
function diagnosticsSources(overrides: Partial<DiagnosticsSources> = {}): DiagnosticsSources {
  return {
    store: { list: () => [] },
    connect: () => ({ state: 'offline' as const }),
    stats: () => ({}),
    sessions: () => [],
    recentErrors: () => [],
    ...overrides,
  } as unknown as DiagnosticsSources
}

/**
 * EXACTLY the production wiring for the scope seam, and deliberately a
 * CLOSURE over the live object: `src/httpApi.ts`'s `diagnosticsReport` hands
 * the aggregator `readScopeSegment(deps.scope)` per request, and `scopeSnapshot`
 * (the `GET /scope` face) reads `host` and `pathUnmatched` out of that very same
 * call. A snapshot taken here instead would freeze the segment at wiring time —
 * that is the "second copy" assertion ② exists to forbid.
 */
function scopeSeam(scope: ToolScopeState): Partial<DiagnosticsSources> {
  return { scope: () => readScopeSegment(scope) }
}

describe('Task 9①: the report carries the enablement-scope segment', () => {
  it('① emits every field, with `capable` the projection of the tri-state', () => {
    const scope = freshScope()
    scope.setHost({ state: 'ready', capable: true, reason: '宿主就绪' })

    const report = buildDiagnostics(diagnosticsSources(scopeSeam(scope)))

    // Every field of the segment is present, at both levels. `upgradeHint` is
    // the report's OWN extra (B7①); `host` itself keeps the four fields spec
    // §6.3 fixes for `GET /scope`.
    expect(Object.keys(report.scope).sort()).toEqual(
      ['host', 'mode', 'pathUnmatched', 'revision', 'upgradeHint', 'workspaceIds'].sort(),
    )
    expect(Object.keys(report.scope.host).sort()).toEqual(
      ['capable', 'degraded', 'reason', 'state'].sort(),
    )
    // The document's own side of the segment, read from the live default document.
    expect(report.scope).toMatchObject({
      mode: 'selected',
      revision: 0,
      workspaceIds: [],
      pathUnmatched: [],
    })
    expect(report.scope.host).toEqual({ state: 'ready', capable: true, reason: '宿主就绪', degraded: [] })
    expect(report.scope.upgradeHint).toBe('')

    // The hint's wording is a server-side literal that promises the consequence
    // the panel's page copy also promises (B7①).
    expect(SCOPE_UPGRADE_HINT).toContain('升级宿主')
    expect(SCOPE_UPGRADE_HINT).toContain('不会注册')

    // ①'s invariant, over all three states: `capable === (state === 'ready')`.
    for (const state of ['pending', 'unsupported', 'ready'] as const) {
      scope.setHost({ state, capable: state === 'ready', reason: `reason-${state}` })
      const next = buildDiagnostics(diagnosticsSources(scopeSeam(scope)))
      expect(next.scope.host.capable).toBe(next.scope.host.state === 'ready')
      // The hint is attached by the STATE, not carried in the input: only the
      // `unsupported` arm gets it, and `pending` — a wait, never "the host does
      // not support this" — explicitly does not (B7①).
      expect(next.scope.upgradeHint, state).toBe(state === 'unsupported' ? SCOPE_UPGRADE_HINT : '')
    }
  })

  it('① a non-default document and a degraded note reach the report field for field', () => {
    // Typed as the deliverable itself, so this literal is a statement about the
    // segment's shape and not merely about the values inside it. `DiagnosticsScope`
    // is the SHARED shape (`GET /scope` + this report), so it carries no hint.
    const segment: DiagnosticsScope = {
      mode: 'global',
      revision: 7,
      workspaceIds: ['ws-2', 'ws-1'],
      host: {
        state: 'ready',
        capable: true,
        reason: '宿主就绪',
        degraded: [{ source: 'install', reason: '安装被拒' }],
      },
      pathUnmatched: [{ agentId: 'agent-1', cwd: '/home/op/other-project' }],
    }

    const report = buildDiagnostics(diagnosticsSources({ scope: () => segment }))

    expect(report.scope).toEqual({
      mode: 'global',
      revision: 7,
      workspaceIds: ['ws-2', 'ws-1'],
      host: {
        state: 'ready',
        capable: true,
        reason: '宿主就绪',
        degraded: [{ source: 'install', reason: '安装被拒' }],
      },
      pathUnmatched: [{ agentId: 'agent-1', cwd: '/home/op/other-project' }],
      // The report adds it; the input does not carry it.
      upgradeHint: '',
    })
  })
})

describe('Task 9②: the report host IS `GET /scope`\'s host, never a second copy', () => {
  it('② one `setHost` moves both faces at once', () => {
    const scope = freshScope()
    // Wired ONCE, like the assembly wires it: everything below re-reads it.
    const seam = diagnosticsSources(scopeSeam(scope))

    scope.setHost({ state: 'pending', capable: false, reason: '等待宿主注入 agents' })
    const before = buildDiagnostics(seam)
    // The `/scope` face's host is this same read (`src/httpApi.ts` scopeSnapshot).
    expect(before.scope.host).toEqual(readScopeSegment(scope).host)

    // ONE write, through the real setter the host integration layer calls.
    scope.setHost({ state: 'unsupported', capable: false, reason: '宿主未注入 agents' })

    const after = buildDiagnostics(seam) //             GET /diagnostics
    const scopeFace = readScopeSegment(scope) //        what GET /scope serves

    // Both places moved TOGETHER, and to the same values.
    expect(after.scope.host).toEqual(scopeFace.host)
    expect(after.scope.host.state).toBe('unsupported')
    expect(after.scope.host.reason).toBe('宿主未注入 agents')
    expect(after.scope.host).not.toEqual(before.scope.host)
    // Not just `host`: every member the two faces SHARE is one read of one
    // object. The report adds exactly one member of its own — B7①'s
    // `upgradeHint` — so the shared members are compared member by member
    // instead of by whole-object equality, which would now be false by design.
    const { upgradeHint, ...shared } = after.scope
    expect(shared).toEqual(scopeFace)
    expect(upgradeHint).toBe(SCOPE_UPGRADE_HINT)

    // `degraded` is part of the same read, so a state write moves it too.
    scope.noteDegraded({ source: 'install', reason: '安装被拒' })
    const noted = buildDiagnostics(seam)
    expect(noted.scope.host.degraded).toEqual([{ source: 'install', reason: '安装被拒' }])
    expect(readScopeSegment(scope).host.degraded).toEqual(noted.scope.host.degraded)
  })
})

describe('Task 9③: the scope segment is a whitelist, and `cwd` is passed through verbatim', () => {
  /** Longer than `ERROR_MESSAGE_MAX`: a truncated value would be observable. */
  const LONG_CWD = `/${'deeply/nested/'.repeat(30)}project`

  /**
   * A `source` OUTSIDE the closed five-value set, beside the reasons it must not
   * leak. The input is a loose bag (`sanitizeDiagnostics` takes `scope: unknown`
   * on purpose), so an unknown source is a real arrival — a peer or a plugin
   * version on the other side of the wire, a hand-assembled report — and
   * `projectDegraded` drops it rather than narrowing it to a plausible member.
   */
  const BOGUS_SOURCE = 'bogus'
  const BOGUS_REASON = '不在五个已知来源之内'

  /** The over-stuffed probe: every credential the brief names, at both levels. */
  function overstuffed(): Record<string, unknown> {
    return {
      mode: 'global',
      revision: 7,
      workspaceIds: ['ws-1'],
      accessToken: 'scope-super-secret-token',
      desktopIdentity: 'scope-desktop-abc',
      identity: { privateKey: 'scope-invitation-secret' },
      host: {
        state: 'ready',
        capable: true,
        reason: '宿主就绪',
        degraded: [
          // A VALID source carrying a smuggled key: the inner projection is what
          // strips `accessToken`, and this note must survive.
          { source: 'install', reason: '安装被拒', accessToken: 'scope-leaked' },
          { source: 'path-normalization', reason: '路径规范化降级' },
          // …and a source OUTSIDE the closed set, which must not survive at all.
          { source: BOGUS_SOURCE, reason: BOGUS_REASON, accessToken: 'scope-leaked-3' },
        ],
        identity: 'host-identity-probe',
        // A smuggled hint: `host` is a four-field whitelist, and the report's
        // own hint is DERIVED from `state`, so a caller's text never survives.
        upgradeHint: 'scope-hint-smuggled',
      },
      pathUnmatched: [{ agentId: 'agent-1', cwd: LONG_CWD, accessToken: 'scope-leaked-2' }],
      contractDifferences: [{ id: 'smuggled' }],
    }
  }

  it('③ drops every field the whitelist does not name, at both levels', () => {
    const sanitized = sanitizeDiagnostics({ scope: overstuffed() })
    const serialized = JSON.stringify(sanitized)

    for (const key of ['accessToken', 'desktopIdentity', 'identity', 'privateKey', 'smuggled']) {
      expect(serialized).not.toContain(key)
    }
    for (const secret of [
      'scope-super-secret-token',
      'scope-desktop-abc',
      'scope-invitation-secret',
      'scope-leaked',
      'scope-hint-smuggled',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    // The `host` whitelist is exactly spec §6.3's four fields: the smuggled text
    // is gone rather than echoed, and `sanitizeDiagnostics` — the shape
    // `GET /scope` serves — gains no hint at all.
    expect('upgradeHint' in sanitized.scope.host).toBe(false)
    expect('upgradeHint' in sanitized.scope).toBe(false)

    // The whitelist is a statement about what MAY appear: an unlisted field is
    // gone from the SHAPE, not merely from a serialized string.
    expect(Object.keys(sanitized.scope).sort()).toEqual(
      ['host', 'mode', 'pathUnmatched', 'revision', 'workspaceIds'].sort(),
    )
    expect(Object.keys(sanitized.scope.host).sort()).toEqual(
      ['capable', 'degraded', 'reason', 'state'].sort(),
    )
    expect(Object.keys(sanitized.scope.host.degraded[0]!).sort()).toEqual(['reason', 'source'].sort())
    expect(Object.keys(sanitized.scope.pathUnmatched[0]!).sort()).toEqual(['agentId', 'cwd'].sort())

    // The whitelisted fields DO come through — a sanitizer that redacts
    // everything is as useless as one that redacts nothing.
    expect(sanitized.scope).toMatchObject({
      mode: 'global',
      revision: 7,
      workspaceIds: ['ws-1'],
      host: {
        state: 'ready',
        capable: true,
        reason: '宿主就绪',
        degraded: [
          { source: 'install', reason: '安装被拒' },
          { source: 'path-normalization', reason: '路径规范化降级' },
        ],
      },
    })
  })

  it('③ drops a `degraded` note whose `source` is not one of the five known values', () => {
    // THE BRANCH THIS EXISTS FOR: the `continue` in `projectDegraded` that
    // discards a foreign source. The probe below carried a VALID source with an
    // extra key, which exercises the inner `{source, reason}` projection but
    // never the DROP — so `DegradedSource`'s closure rested on inspection alone.
    const sanitized = sanitizeDiagnostics({ scope: overstuffed() })

    // DROPPED, and dropped ENTIRELY: the foreign note is gone from the array
    // while the valid ones survive, in order. Asserting only "no error was
    // thrown" (or only the absence of one string) would pass over a
    // re-labelled, truncated or passthrough note just as happily.
    expect(sanitized.scope.host.degraded.map((note) => note.source)).toEqual(['install', 'path-normalization'])
    expect(sanitized.scope.host.degraded).toHaveLength(2)
    // Nothing of it survives anywhere in the body an operator receives — not the
    // source, not its reason.
    expect(JSON.stringify(sanitized)).not.toContain(BOGUS_SOURCE)
    expect(JSON.stringify(sanitized)).not.toContain(BOGUS_REASON)

    // The report an operator actually reads is the same projection, so the drop
    // holds on that path too.
    const report = buildDiagnostics(
      diagnosticsSources({ scope: () => overstuffed() as unknown as DiagnosticsScope }),
    )
    expect(report.scope.host.degraded).toEqual([
      { source: 'install', reason: '安装被拒' },
      { source: 'path-normalization', reason: '路径规范化降级' },
    ])
    expect(JSON.stringify(report.scope)).not.toContain(BOGUS_SOURCE)
  })

  it('③ the REPORT itself is a projection: an over-stuffed source cannot smuggle a key in', () => {
    // The failure mode this pins: a report that SPREADS the source segment
    // (`scope: sources.scope?.()`) instead of projecting it. The whitelist must
    // be applied on the way OUT, whatever the source hands over.
    const report = buildDiagnostics(
      diagnosticsSources({ scope: () => overstuffed() as unknown as DiagnosticsScope }),
    )

    const serialized = JSON.stringify(report.scope)
    for (const key of ['accessToken', 'desktopIdentity', 'identity', 'smuggled', 'scope-hint-smuggled']) {
      expect(serialized).not.toContain(key)
    }
    // The report's segment is the sanitized one PLUS its own derived hint — the
    // state here is `ready`, so that hint is empty, not the smuggled text.
    expect(Object.keys(report.scope).sort()).toEqual(
      ['host', 'mode', 'pathUnmatched', 'revision', 'upgradeHint', 'workspaceIds'].sort(),
    )
    expect(Object.keys(report.scope.host).sort()).toEqual(
      ['capable', 'degraded', 'reason', 'state'].sort(),
    )
    expect(report.scope.upgradeHint).toBe('')
  })

  it('③ passes `pathUnmatched[].cwd` through VERBATIM: not summarized, not truncated', () => {
    expect(LONG_CWD.length).toBeGreaterThan(ERROR_MESSAGE_MAX)

    const sanitized = sanitizeDiagnostics({ scope: overstuffed() })
    expect(sanitized.scope.pathUnmatched).toEqual([{ agentId: 'agent-1', cwd: LONG_CWD }])
    expect(sanitized.scope.pathUnmatched[0]!.cwd).toBe(LONG_CWD)

    // …and the body an operator reads carries that same path, WHOLE: it is the
    // evidence that explains 「勾了却无工具」, and it is a local path, not a credential.
    const report = buildDiagnostics(
      diagnosticsSources({
        scope: () => ({
          ...(overstuffed() as unknown as DiagnosticsScope),
          pathUnmatched: [{ agentId: 'agent-1', cwd: LONG_CWD }],
        }),
      }),
    )
    expect(report.scope.pathUnmatched).toEqual([{ agentId: 'agent-1', cwd: LONG_CWD }])
    expect(report.scope.pathUnmatched[0]!.cwd).toBe(LONG_CWD)
  })
})
