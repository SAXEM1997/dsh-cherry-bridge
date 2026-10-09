import { describe, expect, it } from 'vitest'
import { buildDiagnostics, digestIdentity, sanitizeDevice } from '../../src/diagnostics.js'
import type { DiagnosticsSources } from '../../src/diagnostics.js'
import type { DeviceRecord } from '../../src/deviceStore.js'

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
