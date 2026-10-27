import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QUARANTINE_RECOVERY, DeviceStore } from '../../src/deviceStore.js'
import { registerCherryTools } from '../../src/tools.js'
import type { CherryToolDefinition, CherryToolsContext, CherryToolsDeps } from '../../src/tools.js'

/**
 * R3-F2 acceptance suite: the QUARANTINED archive on the TOOL face.
 *
 * A quarantined store serves an EMPTY read-only view by design — the archive on
 * disk is the last copy of every pairing, so refusing to overwrite it is the
 * whole point. The tool face never noticed: `store.list()` returning `[]` made
 * `resolve()` answer `{ambiguous: []}`, so EVERY device tool replied
 * `ambiguous-device` with an empty candidate list. That is worse than an error.
 * `ambiguous-device` is an ANSWER ("pick one of these"), and with no candidates
 * there is nothing to pick — the caller is told to disambiguate against a device
 * set the plugin cannot see, and the real condition (a damaged archive that
 * needs an operator) never surfaces at all.
 *
 * `cherry_unpair` had the mirror problem: it removed the record through the
 * store unguarded, so a quarantined archive threw `QuarantinedArchiveError`
 * straight out of the tool call — a raw file error where every other face of
 * this plugin reports a structured verdict.
 */

interface FakeCtx extends CherryToolsContext {
  readonly definitions: CherryToolDefinition[]
}

function makeCtx(): FakeCtx {
  const definitions: CherryToolDefinition[] = []
  return {
    definitions,
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {
          const index = definitions.indexOf(definition)
          if (index >= 0) definitions.splice(index, 1)
        }
      },
    },
  }
}

let tmp: string
let consoleWarn: ReturnType<typeof vi.fn>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cherry-quarantine-tools-'))
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

/** A store over a deliberately unparsable archive, primed so it is quarantined. */
function quarantinedRig(): {
  ctx: FakeCtx
  store: DeviceStore
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
} {
  const file = join(tmp, 'devices.json')
  writeFileSync(file, '{ this is not json', 'utf8')
  const store = new DeviceStore(file)
  // Prime the quarantine: the first read degrades to an empty view.
  expect(store.list()).toEqual([])

  const ctx = makeCtx()
  const deps: CherryToolsDeps = {
    store,
    connect: () => {
      throw new Error('a quarantined archive has no connections to resolve')
    },
    subs: () => {
      throw new Error('a quarantined archive has no subscriptions')
    },
    pair: async () => {
      throw new Error('pairing is covered by its own suite')
    },
    evict: () => {
      throw new Error('a quarantined archive has nothing pooled to evict')
    },
  }
  registerCherryTools(ctx, deps, {})

  return {
    ctx,
    store,
    call: (name, args = {}) => {
      const found = ctx.definitions.find((definition) => definition.name === name)
      if (found === undefined) throw new Error(`tool ${name} is not registered`)
      return found.execute(args)
    },
  }
}

describe('R3-F2: a quarantined archive is surfaced on the tool face, never misreported as ambiguity', () => {
  it('F2-4a the store exposes a cheap readonly quarantine probe', () => {
    const file = join(tmp, 'devices.json')
    writeFileSync(file, '{ this is not json', 'utf8')
    const healthy = new DeviceStore(join(tmp, 'healthy.json'))

    // A fresh, absent archive is NOT quarantined (first run).
    expect(healthy.list()).toEqual([])
    expect(healthy.quarantined).toBe(false)

    const poisoned = new DeviceStore(file)
    // The probe is truthful BEFORE the first read (nothing has been discovered
    // yet) and after it (the archive really is quarantined).
    poisoned.list()
    expect(poisoned.quarantined).toBe(true)
    expect(poisoned.quarantineInfo()?.file).toBe(file)
  })

  it('F2-4b cherry_devices answers the structured quarantine verdict instead of an empty device list', async () => {
    const rig = quarantinedRig()

    const result = (await rig.call('cherry_devices')) as Record<string, unknown>

    expect(result['error']).toBe('archive-quarantined')
    expect(String(result['guidance'] ?? '')).toContain(QUARANTINE_RECOVERY)
    // NOT the misleading empty-ambiguity answer.
    expect(result['error']).not.toBe('ambiguous-device')
  })

  it('F2-4b2 a quarantined archive answers archive-quarantined, never not-found (issue #13)', async () => {
    const rig = quarantinedRig()

    // A quarantined archive serves an EMPTY view, so every selector misses.
    // Answering `not-found` would call a store that still holds a valid token
    // "no such device" — the quarantine must keep precedence.
    const devices = (await rig.call('cherry_devices', { device: 'Desk Alpha' })) as Record<string, unknown>
    expect(devices['error']).toBe('archive-quarantined')
    expect(devices['error']).not.toBe('not-found')

    // The same precedence on the throw route: a non-cherry_devices tool gets
    // the quarantine verdict, however unmatched the selector looks.
    const read = (await rig.call('cherry_read', { device: 'no-such-device', sessionId: 's-1' })) as Record<
      string,
      unknown
    >
    expect(read['error']).toBe('archive-quarantined')

    const unpair = (await rig.call('cherry_unpair', { device: 'no-such-device' })) as Record<string, unknown>
    expect(unpair['error']).toBe('archive-quarantined')
  })

  it('F2-4c cherry_read answers the structured quarantine verdict rather than ambiguous-with-no-candidates', async () => {
    const rig = quarantinedRig()

    const result = (await rig.call('cherry_read', { device: 'Desk Alpha', sessionId: 's-1' })) as Record<
      string,
      unknown
    >

    expect(result['error']).toBe('archive-quarantined')
    expect(String(result['guidance'] ?? '')).toContain(QUARANTINE_RECOVERY)
  })

  it('F2-4d cherry_unpair answers the structured quarantine verdict instead of throwing the raw file error', async () => {
    const rig = quarantinedRig()

    // Resolves — every face of this plugin reports in band — and says why.
    const result = (await rig.call('cherry_unpair', { device: 'Desk Alpha' })) as Record<string, unknown>

    expect(result['error']).toBe('archive-quarantined')
    expect(String(result['guidance'] ?? '')).toContain(QUARANTINE_RECOVERY)
  })

  it('F2-4e a quarantined store taken mid-life (write refused) reports the same verdict', async () => {
    // The other route into the state: the archive goes bad while the process is
    // running, so the store was healthy when the plugin started. The probe has
    // to reflect the CURRENT truth, not the truth at construction.
    const file = join(tmp, 'devices.json')
    const store = new DeviceStore(file)
    writeFileSync(file, JSON.stringify({ schemaVersion: 3, devices: [] }), 'utf8')
    store.list()
    expect(store.quarantined).toBe(false)

    // Damage the archive and force the next read to discover it.
    writeFileSync(file, 'not json at all', 'utf8')
    const reopened = new DeviceStore(file)
    reopened.list()
    expect(reopened.quarantined).toBe(true)
  })
})
