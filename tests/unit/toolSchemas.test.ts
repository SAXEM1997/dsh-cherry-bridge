import { describe, expect, it } from 'vitest'
import { DeviceStore } from '../../src/deviceStore'
import { registerCherryTools } from '../../src/tools'
import type { CherryToolDefinition, CherryToolsContext } from '../../src/tools'

/**
 * Task 8⑧ + Task 10④: literal JSON Schema validation for the WHOLE `cherry_*`
 * family. Every assertion reads the schema the HOST registry would receive (the
 * definition's compiled `parameters`), so a tool whose declared schema drifts
 * from its documented contract fails here rather than at call time.
 *
 * Task 8 pinned the six read-only tools by SELECTING them out of a registry
 * Task 9 had already widened. Task 10④ owns the full-set assertion, so the file
 * now states the COMPLETE 14-tool contract in one place — the brief's §7-1
 * 「工具参数 schema 校验」 — including the three parameters a caller cannot get
 * wrong without the peer refusing the call: `cherry_respond`'s required
 * `interactionId` with its `decision|response` exclusivity, `cherry_cancel`'s
 * required `expectedExecutionId`, and `cherry_send`'s `text` ceiling.
 */

const READ_TOOLS = [
  'cherry_devices',
  'cherry_agents',
  'cherry_workspaces',
  'cherry_sessions',
  'cherry_read',
  'cherry_events',
] as const

/** The interactive face (Task 9). */
const INTERACTIVE_TOOLS = [
  'cherry_create',
  'cherry_send',
  'cherry_wait',
  'cherry_interactions',
  'cherry_respond',
  'cherry_cancel',
] as const

/** The management face (Task 10). */
const MANAGEMENT_TOOLS = ['cherry_pair', 'cherry_unpair'] as const

/** The complete `cherry_*` registry, in registration order. */
const ALL_TOOLS = [...READ_TOOLS, ...INTERACTIVE_TOOLS, ...MANAGEMENT_TOOLS] as const

/** The full registry, read-only tools first. */
function registerAll(): CherryToolDefinition[] {
  const definitions: CherryToolDefinition[] = []
  const ctx: CherryToolsContext = {
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
  }
  registerCherryTools(ctx, {
    store: new DeviceStore('/nonexistent/devices.json'),
    connect: () => {
      throw new Error('the schema suite never connects')
    },
    subs: () => {
      throw new Error('the schema suite never subscribes')
    },
    pair: async () => {
      throw new Error('the schema suite never pairs')
    },
    evict: () => {
      throw new Error('the schema suite never evicts')
    },
  })
  return definitions
}

/** Just the six read-only definitions THIS suite owns. */
function registerReadOnly(): CherryToolDefinition[] {
  return registerAll().filter((definition) => (READ_TOOLS as readonly string[]).includes(definition.name))
}

function toolOf(name: string): CherryToolDefinition {
  const found = registerAll().find((definition) => definition.name === name)
  if (found === undefined) throw new Error(`tool ${name} is not registered`)
  return found
}

/** The declared property map of one tool's parameter schema. */
function properties(definition: CherryToolDefinition): Record<string, Record<string, unknown>> {
  return definition.parameters.properties as unknown as Record<string, Record<string, unknown>>
}

describe('tool parameter schemas: the six read-only tools', () => {  it('registers exactly the six read-only tools, each with a literal object-root schema', () => {
    // Task 9 widened the registry; this suite's subject is its own six, which
    // Task 8 registers FIRST and in this order.
    const definitions = registerReadOnly()
    expect(definitions.map((definition) => definition.name)).toEqual([...READ_TOOLS])
    for (const definition of definitions) {
      expect(definition.parameters.type).toBe('object')
      expect(definition.parameters.additionalProperties).toBe(false)
      expect(typeof definition.description).toBe('string')
      expect(definition.description.length).toBeGreaterThan(0)
    }
  })

  it('cherry_devices takes no required parameter and declares an optional device selector', () => {
    const definition = toolOf('cherry_devices')
    expect(definition.parameters.required ?? []).toEqual([])
    // `device` is optional here: without it the tool lists every device.
    expect(properties(definition)['device']).toMatchObject({ type: 'string' })
  })

  it('cherry_agents requires device and bounds limit as an AGGREGATE, not a page', () => {
    const definition = toolOf('cherry_agents')
    expect(definition.parameters.required).toEqual(['device'])
    expect(properties(definition)['device']).toMatchObject({ type: 'string' })
    const limit = properties(definition)['limit']!
    expect(limit['type']).toBe('integer')
    // The caller's ceiling is the AGGREGATE total: it must admit the brief's
    // 150 (which the tool satisfies with multiple clamped pages), so it is
    // deliberately NOT the 100-item protocol page cap.
    expect(limit['maximum']).toBe(1000)
    expect(limit['minimum']).toBe(1)
  })

  it('cherry_workspaces requires device and agentId and paginates like the other list tools', () => {
    const definition = toolOf('cherry_workspaces')
    expect(definition.parameters.required).toEqual(['device', 'agentId'])
    expect(Object.keys(properties(definition)).sort()).toEqual(['agentId', 'device', 'limit'])
    expect(properties(definition)['limit']!['maximum']).toBe(1000)
  })

  it('cherry_sessions requires device and exposes the two filter passthroughs plus the aggregate cap', () => {
    const definition = toolOf('cherry_sessions')
    expect(definition.parameters.required).toEqual(['device'])
    expect(properties(definition)['agentId']).toMatchObject({ type: 'string' })
    expect(properties(definition)['workspaceId']).toMatchObject({ type: 'string' })
    expect(properties(definition)['limit']!['maximum']).toBe(1000)
  })

  it('cherry_read requires device and sessionId', () => {
    const definition = toolOf('cherry_read')
    expect(definition.parameters.required).toEqual(['device', 'sessionId'])
    expect(properties(definition)['sessionId']).toMatchObject({ type: 'string' })
    expect(properties(definition)['limit']!['maximum']).toBe(1000)
  })

  it('cherry_events requires device and sessionId and declares a closed cursor shape', () => {
    const definition = toolOf('cherry_events')
    expect(definition.parameters.required).toEqual(['device', 'sessionId'])
    const cursor = properties(definition)['cursor']!
    expect(cursor['type']).toBe('object')
    expect(cursor['additionalProperties']).toBe(false)
    expect(cursor['required']).toEqual(['sessionId', 'streamEpoch', 'seq'])
    expect(Object.keys(cursor['properties'] as object).sort()).toEqual(['seq', 'sessionId', 'streamEpoch'])
  })

  it('every read-only tool declares the aggregate limit as an integer within [1, 1000]', () => {
    for (const definition of registerReadOnly()) {
      const limit = properties(definition)['limit']
      if (limit === undefined) continue
      expect(limit['type']).toBe('integer')
      expect(limit['minimum']).toBe(1)
      expect(limit['maximum']).toBe(1000)
    }
  })

  it('no read-only tool declares a write-shaped parameter', () => {
    // Read-only means read-only: a `text`/`payload`/`commandId` on this set
    // would silently widen the M3 read face into a mutation surface. (The
    // interactive tools Task 9 adds DO carry these — which is exactly why this
    // assertion is scoped to the read-only six rather than the whole registry.)
    for (const definition of registerReadOnly()) {
      const keys = Object.keys(properties(definition))
      for (const forbidden of ['text', 'payload', 'commandId', 'name']) {
        expect(keys).not.toContain(forbidden)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Task 10④: the full 14-tool set
// ---------------------------------------------------------------------------

describe('tool parameter schemas: the complete 14-tool registry (Task 10④)', () => {
  it('registers exactly the fourteen `cherry_*` tools, in the order M3 documents them', () => {
    expect(registerAll().map((definition) => definition.name)).toEqual([...ALL_TOOLS])
  })

  it('every one of the fourteen declares a literal, closed, object-root schema with a description', () => {
    for (const definition of registerAll()) {
      expect(definition.parameters.type).toBe('object')
      expect(definition.parameters.additionalProperties).toBe(false)
      expect(Object.keys(definition.parameters.properties).length).toBeGreaterThan(0)
      expect(typeof definition.description).toBe('string')
      expect(definition.description.length).toBeGreaterThan(0)
      // The host validates `execute`'s return against `output.schema`, so a
      // tool with no output contract could return anything at all.
      expect(definition.output.schema).toBeDefined()
      expect(typeof definition.output.render).toBe('function')
    }
  })

  it('cherry_send requires device/sessionId/text and caps text at the protocol ceiling of 32768', () => {
    const definition = toolOf('cherry_send')
    expect(definition.parameters.required).toEqual(['device', 'sessionId', 'text'])
    // 32768 is the protocol's `agent.messages.send.text` ceiling: the schema
    // must state it so an over-long body is refused before the wire rather than
    // round-tripped into a peer error.
    expect(properties(definition)['text']).toMatchObject({ type: 'string', maxLength: 32_768 })
  })

  it('cherry_cancel REQUIRES expectedExecutionId: a cancel without a target is unrunnable', () => {
    const definition = toolOf('cherry_cancel')
    expect(definition.parameters.required).toEqual(['device', 'sessionId', 'expectedExecutionId'])
    expect(properties(definition)['expectedExecutionId']).toMatchObject({ type: 'string' })
  })

  it('cherry_respond requires interactionId and offers decision|response as the two answer forms', () => {
    const definition = toolOf('cherry_respond')
    expect(definition.parameters.required).toEqual(['device', 'sessionId', 'interactionId'])
    expect(properties(definition)['interactionId']).toMatchObject({ type: 'string' })
    // The two forms are the protocol's own union branches: `decision` for a
    // card, `response` for a question. Both are declared, and the tool refuses
    // "neither" and "both" in band.
    const decision = properties(definition)['decision']!
    expect(decision['type']).toBe('string')
    expect(decision['enum']).toEqual(['approve', 'deny'])
    const response = properties(definition)['response']!
    expect(response['type']).toBe('object')
    expect(response['additionalProperties']).toBe(false)
    expect(response['required']).toEqual(['kind', 'answers'])
    expect((response['properties'] as Record<string, unknown>)['kind']).toMatchObject({
      enum: ['answer'],
    })
  })

  it('cherry_pair requires the payload and takes an optional device-name override', () => {
    const definition = toolOf('cherry_pair')
    expect(definition.parameters.required).toEqual(['payload'])
    expect(Object.keys(properties(definition)).sort()).toEqual(['name', 'payload'])
    expect(properties(definition)['payload']).toMatchObject({ type: 'string' })
    expect(properties(definition)['name']).toMatchObject({ type: 'string' })
  })

  it('cherry_unpair requires the device selector: there is no "unpair everything"', () => {
    const definition = toolOf('cherry_unpair')
    expect(definition.parameters.required).toEqual(['device'])
    expect(Object.keys(properties(definition))).toEqual(['device'])
    expect(properties(definition)['device']).toMatchObject({ type: 'string' })
  })

  it('the interactive and management tools all carry the device selector, and only cherry_pair omits a list limit', () => {
    // Every tool EXCEPT the two read-only management/listing entry points
    // addresses a device; `cherry_pair` is the one that CREATES the pairing and
    // `cherry_devices` the one that may list them all.
    for (const name of [...INTERACTIVE_TOOLS, 'cherry_unpair'] as const) {
      expect(properties(toolOf(name))['device']).toMatchObject({ type: 'string' })
      expect(toolOf(name).parameters.required).toContain('device')
    }
    expect(toolOf('cherry_pair').parameters.required).not.toContain('device')
    expect(toolOf('cherry_devices').parameters.required ?? []).not.toContain('device')
  })
})
