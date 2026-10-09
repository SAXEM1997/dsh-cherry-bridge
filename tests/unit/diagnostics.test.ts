import { describe, expect, it } from 'vitest'
import { digestIdentity, sanitizeDevice } from '../../src/diagnostics'
import type { DeviceRecord } from '../../src/deviceStore'

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
