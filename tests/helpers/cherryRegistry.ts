/**
 * The `registerCherryTools` "register-and-collect" fixture, in ONE place.
 *
 * Three suites assert properties of the definitions the HOST registry receives
 * (`toolSchemas.test.ts` the literal schemas, `toolParameterSubset.test.ts` the
 * enforced parameter subset, `toolDeviceDocSync.test.ts` the `device`
 * descriptions). Each of them needs the same thing: call the real
 * `registerCherryTools` with a `ctx.tools.register` that collects instead of
 * installing, so every assertion reads the PRODUCTION declaration rather than a
 * test-local copy of it.
 *
 * They used to carry three copies of that rig (issue #228, found as Duplicated
 * Code by #219's standards review). The copies differed only in the text of the
 * four `throw`s — and that text is the reason they existed at all: each one
 * names its own suite. The cost was not the volume but the coupling: a new
 * required `CherryToolsDeps` field has to be added in three places, and the
 * miss is a typecheck error at best and a silently different wiring at worst.
 *
 * The four throws are NOT decoration. `registerCherryTools` takes the whole
 * dependency surface, and every one of these suites must reach the schemas
 * WITHOUT dialing, subscribing, pairing or evicting: a dependency that starts
 * being called during registration means a tool face did work at assembly time,
 * which no schema suite should ever do. They throw rather than returning a
 * stub so that such a call fails loudly at its first use instead of being
 * absorbed.
 */
import { DeviceStore } from '../../src/deviceStore.js'
import { registerCherryTools } from '../../src/tools.js'
import type { CherryToolDefinition, CherryToolsContext } from '../../src/tools.js'

/**
 * Every `cherry_*` definition `registerCherryTools` registers, in registration
 * order, read from the definitions the host would receive.
 *
 * The store path does not exist and is never read: registration builds the tool
 * faces, it does not open the device document.
 */
export function registerAll(): CherryToolDefinition[] {
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
      throw new Error('the registry fixture never connects')
    },
    subs: () => {
      throw new Error('the registry fixture never subscribes')
    },
    pair: async () => {
      throw new Error('the registry fixture never pairs')
    },
    evict: () => {
      throw new Error('the registry fixture never evicts')
    },
  })
  return definitions
}

/**
 * One registered definition by name.
 *
 * Throws rather than returning undefined: a suite that asks for a tool the
 * registry no longer registers should fail on the MISSING TOOL, not on the
 * `undefined.parameters` that follows it three lines later.
 */
export function toolOf(name: string): CherryToolDefinition {
  const found = registerAll().find((definition) => definition.name === name)
  if (found === undefined) throw new Error(`tool ${name} is not registered`)
  return found
}

/** The declared property map of one tool's parameter schema. */
export function properties(definition: CherryToolDefinition): Record<string, Record<string, unknown>> {
  return definition.parameters.properties as unknown as Record<string, Record<string, unknown>>
}
