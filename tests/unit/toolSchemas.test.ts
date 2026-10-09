import { describe, expect, it } from 'vitest'
import { DeviceStore } from '../../src/deviceStore'
import { registerCherryTools } from '../../src/tools'
import type { CherryToolDefinition, CherryToolsContext } from '../../src/tools'

/**
 * Task 8⑧: literal JSON Schema validation for the six read-only tools this task
 * registers. Every assertion reads the schema the HOST registry would receive
 * (the definition's compiled `parameters`), so a tool whose declared schema
 * drifts from its documented contract fails here rather than at call time.
 *
 * The 14-tool full-set assertion belongs to Task 10④; this suite pins exactly
 * the read-only set.
 */

/** A collecting fake ctx.tools, mirroring the host's `register` contract. */
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
    identity: new Uint8Array(),
  })
  return definitions
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

const READ_TOOLS = [
  'cherry_devices',
  'cherry_agents',
  'cherry_workspaces',
  'cherry_sessions',
  'cherry_read',
  'cherry_events',
] as const

describe('tool parameter schemas: the six read-only tools', () => {
  it('registers exactly the six read-only tools, each with a literal object-root schema', () => {
    const definitions = registerAll()
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

  it('every tool declares the aggregate limit as an integer within [1, 1000]', () => {
    for (const definition of registerAll()) {
      const limit = properties(definition)['limit']
      if (limit === undefined) continue
      expect(limit['type']).toBe('integer')
      expect(limit['minimum']).toBe(1)
      expect(limit['maximum']).toBe(1000)
    }
  })

  it('no read-only tool declares a write-shaped parameter', () => {
    // Read-only means read-only: a `text`/`payload`/`commandId` on this set
    // would silently widen the M3 read face into a mutation surface.
    for (const definition of registerAll()) {
      const keys = Object.keys(properties(definition))
      for (const forbidden of ['text', 'payload', 'commandId', 'name']) {
        expect(keys).not.toContain(forbidden)
      }
    }
  })
})
