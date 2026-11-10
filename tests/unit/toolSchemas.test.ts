import { describe, expect, it } from 'vitest'
import type { CherryToolDefinition } from '../../src/tools.js'
import { properties, registerAll, toolOf } from '../helpers/cherryRegistry.js'

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

/** Just the six read-only definitions THIS suite owns. */
function registerReadOnly(): CherryToolDefinition[] {
  return registerAll().filter((definition) => (READ_TOOLS as readonly string[]).includes(definition.name))
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

  it('cherry_agents requires device and declares limit as an AGGREGATE integer, not a page', () => {
    const definition = toolOf('cherry_agents')
    expect(definition.parameters.required).toEqual(['device'])
    expect(properties(definition)['device']).toMatchObject({ type: 'string' })
    const limit = properties(definition)['limit']!
    expect(limit['type']).toBe('integer')
    // The caller's ceiling is the AGGREGATE total: it must admit the brief's
    // 150 (which the tool satisfies with multiple clamped pages), so it is
    // deliberately NOT the 100-item protocol page cap. The two NUMBERS are no
    // longer schema keywords (issue #219: the host's enforced parameter subset
    // has no `minimum`/`maximum`) — they live in the description, pinned by
    // `toolParameterSubset.test.ts` #219b.
  })

  it('cherry_workspaces requires device and agentId and paginates like the other list tools', () => {
    const definition = toolOf('cherry_workspaces')
    expect(definition.parameters.required).toEqual(['device', 'agentId'])
    expect(Object.keys(properties(definition)).sort()).toEqual(['agentId', 'cursor', 'device', 'limit'])
    expect(properties(definition)['limit']!['type']).toBe('integer')
  })

  it('cherry_sessions requires device and exposes the two filter passthroughs plus the aggregate cap', () => {
    const definition = toolOf('cherry_sessions')
    expect(definition.parameters.required).toEqual(['device'])
    expect(properties(definition)['agentId']).toMatchObject({ type: 'string' })
    expect(properties(definition)['workspaceId']).toMatchObject({ type: 'string' })
    expect(properties(definition)['limit']!['type']).toBe('integer')
  })

  it('cherry_read requires device and sessionId', () => {
    const definition = toolOf('cherry_read')
    expect(definition.parameters.required).toEqual(['device', 'sessionId'])
    expect(properties(definition)['sessionId']).toMatchObject({ type: 'string' })
    expect(properties(definition)['limit']!['type']).toBe('integer')
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

  it('issue #65: exactly the four list tools declare a resumable `cursor`', () => {
    const listTools = ['cherry_agents', 'cherry_workspaces', 'cherry_sessions', 'cherry_interactions']
    for (const definition of registerAll()) {
      const keys = Object.keys(properties(definition))
      // The raw peer position is internal: it must not be an INPUT anywhere.
      expect(keys).not.toContain('nextCursor')
      if (listTools.includes(definition.name)) {
        expect(keys).toContain('cursor')
        // Issue #70: the token is caller input with a peer-supplied tail. Its
        // ceiling is TEXT now (issue #219: `maxLength` is outside the host's
        // enforced parameter subset), enforced by the parser and pinned as a
        // number by `toolParameterSubset.test.ts` #219b.
        expect(properties(definition)['cursor']).toMatchObject({ type: 'string' })
      } else if (definition.name !== 'cherry_events') {
        // `cherry_events` has its own cursor OBJECT, declared since Task 8.
        expect(keys).not.toContain('cursor')
      }
    }
  })

  it('issue #74: cherry_read bounds its resume token the way the list tools do', () => {
    // Same bound, same face: the ceiling is TEXT (issue #219) and the number is
    // pinned by `toolParameterSubset.test.ts` #219b.
    expect(properties(toolOf('cherry_read'))['messagesResumeCursor']).toMatchObject({
      type: 'string',
    })
  })

  it('issue #307: cherry_read offers includeImages as an OPTIONAL boolean, and says what it reads', () => {
    const definition = toolOf('cherry_read')
    const includeImages = properties(definition)['includeImages']
    expect(includeImages).toMatchObject({ type: 'boolean' })
    expect(definition.parameters.required).toEqual(['device', 'sessionId'])
    // The description is the model's only warning that this opt-in has a
    // deployment/route gate and a per-call cap, so neither may silently vanish.
    expect(String(includeImages?.['description'])).toMatch(/image input/i)
    expect(String(includeImages?.['description'])).toMatch(/imagesOmitted/i)
    expect(definition.description).toMatch(/includeImages: true/)
    expect(definition.description).toMatch(/legacy `data` attachment/i)
  })

  it('issue #103: the failure clause is conditional and claims only what is dropped', () => {
    // The wire `failure` is OPTIONAL even on a failed message (protocol
    // `messageSchema.failure` is `ZodOptional`), so an unconditional "carries
    // `failure`" is a promise a 2.1.4–2.1.6 peer breaks. And `failure.message`
    // IS peer/provider text — only the structured `source`/`context` are ours
    // to drop — so "the raw error body is never included" overclaimed.
    const description = toolOf('cherry_read').description ?? ''
    expect(description).toMatch(/may carry `failure: \{reasonCode, retryable, message\}`/i)
    expect(description).toMatch(/when the peer sent one/i)
    expect(description).toMatch(/`source` and `context\.responseBody` are never projected/i)
    expect(description).not.toMatch(/raw error body is never included/i)
  })

  it('issue #82: a description promises a resume token only when one can be named', () => {
    // The description IS the contract a model reads, so an unconditional promise
    // is a claim the tool then contradicts: the emitters withhold the token
    // whenever naming it would break the round trip (an empty or mangled peer
    // position, a token past `MAX_RESUME_TOKEN_CHARS`, or no message id to anchor
    // the `after:` form). Before this, the four list tools said a truncated
    // answer "also carries `resumeCursor`", and `cherry_read` named the WRONG
    // absent case — "the walk reached the peer's last page", which a truncated
    // walk by definition never reaches.
    //
    // The POSITIVE half selects by CONTENT, not by tool name: any top-level
    // description that mentions the token has to carry the clause, so a future
    // tool cannot reintroduce the claim by being absent from a list.
    for (const definition of registerAll()) {
      const description = definition.description ?? ''
      if (!/`(messages)?resumeCursor`/i.test(description)) continue
      expect(description, `${definition.name} must make the token conditional`).toMatch(
        /stop point can be named/i,
      )
    }
    // ...and no description anywhere keeps a retired UNCONDITIONAL clause,
    // including the two variants the four list tools used and the wrong absent
    // case `cherry_read` used.
    for (const definition of registerAll()) {
      const description = definition.description ?? ''
      for (const retired of [
        /reached the peer's last page/i,
        /answer also carries `resumeCursor`/i,
        /ran out and carries `resumeCursor`/i,
      ]) {
        expect(description, `${definition.name} keeps a retired claim`).not.toMatch(retired)
      }
    }
    // Anchor: the six descriptions that speak about tokens in a RESULT are the
    // ones the positive half above must have covered — assert the count so a
    // silently narrowed regex cannot pass by matching nothing.
    const mentioning = registerAll().filter((definition) =>
      /`(messages)?resumeCursor`/i.test(definition.description ?? ''),
    )
    expect(mentioning.map((definition) => definition.name).sort()).toEqual([
      'cherry_agents',
      'cherry_interactions',
      'cherry_read',
      'cherry_send',
      'cherry_sessions',
      'cherry_workspaces',
    ])
  })

  it('every read-only tool declares the aggregate limit as an integer', () => {
    // The BOUNDS moved into the description (issue #219) and are pinned there;
    // what stays here is the shape the host's parameter subset can carry.
    for (const definition of registerReadOnly()) {
      const limit = properties(definition)['limit']
      if (limit === undefined) continue
      expect(limit['type']).toBe('integer')
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

  it('cherry_send requires device/sessionId, text optional, and declares typed attachments', () => {
    const definition = toolOf('cherry_send')
    expect(definition.parameters.required).toEqual(['device', 'sessionId'])
    // 32768 is the protocol's `agent.messages.send.text` ceiling. The tool still
    // refuses an over-long body BEFORE the wire (`text-too-long`), and the
    // number is stated in the description because the host's parameter subset
    // has no `maxLength` (issue #219; pinned by toolParameterSubset.test.ts
    // #219b).
    expect(properties(definition)['text']).toMatchObject({ type: 'string' })
    // Attachments (issue #306): the path is the one required field; an item has
    // no open-ended extras, so a typo like `fileName` is a schema error rather
    // than silently ignored.
    const attachments = properties(definition)['attachments']!
    expect(attachments['type']).toBe('array')
    expect(attachments['items']).toMatchObject({
      type: 'object',
      required: ['path'],
      additionalProperties: false,
    })
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
