import { describe, expect, it } from 'vitest'
import { createCherrySubagentTool } from '../../src/subagentTool.js'
import type { CherryActivationSpec } from '../../src/subagentTool.js'

/**
 * Issue #232 — the model-facing `cherry_subagent` tool.
 *
 * The tool is deliberately the SMALLEST thing in the subsystem: it builds one
 * activation spec and returns the child id. Everything that can fail slowly
 * (dialling the device, creating the Cherry session, the run itself) is on the
 * far side of `startActivation` and settles through the run's result — which is
 * why this file has no clock and no fake.
 *
 * The shape is transcribed from the host's own delegation tool
 * (`@deepseek-ai/dsh-tool-subagent@0.2.2-rc.1`, `lib/index.js`), because a
 * second spelling of `startActivation`'s spec is a second thing to get wrong.
 * What is NOT transcribed is the wording: that tool's `inheritsParentContext:
 * false` branch is the one that applies here (SUB-05), but its prompt does not
 * say the child may REFUSE the task, and a Cherry agent can (SUB-54).
 *
 * WHAT THIS FILE DOES NOT COVER: registration with the host (`subagentHost.test.ts`),
 * the activation seam itself (`subagentSeam.test.ts`), the delegation
 * (`subagentRun.test.ts`), and whether the parameter schema sits inside the
 * host's JSON Schema subset (`toolParameterSubset.test.ts`, SUB-61).
 */

/** The spec the tool hands the seam, recorded instead of performed. */
function recordingSeam(childId = 'child-1'): {
  readonly specs: CherryActivationSpec[]
  startActivation(spec: CherryActivationSpec): Promise<{ readonly childId: string }>
} {
  const specs: CherryActivationSpec[] = []
  return {
    specs,
    async startActivation(spec) {
      specs.push(spec)
      return { childId }
    },
  }
}

/** A calling agent: the seam needs one, and the tool only forwards it (SUB-65). */
const PARENT = { session: { id: 'parent-session' } }

/** The `exec` the host hands `execute`, narrowed to what the tool reads. */
function exec(overrides: { agent?: unknown; signal?: AbortSignal } = {}): {
  agent?: unknown
  signal: AbortSignal
} {
  return {
    ...('agent' in overrides ? { agent: overrides.agent } : { agent: PARENT }),
    signal: overrides.signal ?? new AbortController().signal,
  }
}

/** The device a delegation would address; the assembly supplies the real one. */
const DEVICE_OF = (cwd: string): string => (cwd.startsWith('/w/other') ? 'desk-2' : 'desk-1')

/**
 * The tool under test.
 *
 * `resolveDevice` is a stub here: the REAL one is `resolveTargetDevice`, shared
 * with the runner, and `subagentHost.test.ts` pins that the host passes it. What
 * this file pins is that the tool asks for it and reports its answer.
 */
function build(
  seam: { startActivation(spec: CherryActivationSpec): Promise<{ readonly childId: string }> },
  overrides: { toolName?: string; providerName?: string; resolveDevice?: (cwd: string) => string } = {},
) {
  return createCherrySubagentTool({
    providerName: overrides.providerName ?? 'cherry',
    ...(overrides.toolName === undefined ? {} : { toolName: overrides.toolName }),
    resolveDevice: overrides.resolveDevice ?? DEVICE_OF,
    startActivation: seam.startActivation,
  })
}

const ARGS = { description: 'audit the parser', prompt: 'Read src/parse.ts and list the gaps.' }

describe('the cherry_subagent tool definition', () => {
  it('①a is named cherry_subagent and describes what the child cannot do (SUB-60, SUB-64)', () => {
    const tool = build(recordingSeam())
    expect(tool.name).toBe('cherry_subagent')
    // SUB-64's four facts, each one a thing a model gets wrong without being told.
    expect(tool.description).toContain('own context')
    expect(tool.description).toContain('does NOT see this conversation')
    expect(tool.description).toContain('does NOT accept follow-up messages')
    expect(tool.description).toContain('notifies you when the child finishes')
    // SUB-54: a refusal is a COMPLETED run, not a fault, and the model must not
    // read one as a failed delegation.
    expect(tool.description).toContain('may decline')
  })

  it('①b takes exactly description, prompt and cwd — never a target (SUB-60)', () => {
    const tool = build(recordingSeam())
    const parameters = tool.parameters as {
      properties: Record<string, unknown>
      required?: readonly string[]
    }
    expect(Object.keys(parameters.properties).sort()).toEqual(['cwd', 'description', 'prompt'])
    // The target is the OPERATOR's decision (a default plus a `cwd` route table),
    // so a model-chosen `device`/`agentId`/`workspace` would be a second, silently
    // diverging way to pick one.
    for (const forbidden of ['device', 'agentId', 'workspace', 'workspaceId']) {
      expect(parameters.properties).not.toHaveProperty(forbidden)
    }
    expect(parameters.required).toEqual(['description', 'prompt'])
  })

  it('②a declares the canonical value the seam returns (SUB-62)', () => {
    const tool = build(recordingSeam())
    const schema = tool.output.schema as {
      type?: string
      additionalProperties?: boolean
      required?: readonly string[]
      properties: Record<string, { type?: string; const?: unknown; required?: boolean }>
    }
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    // The COMPILED dialect: `required` is an object-level LIST, never a
    // per-property flag. The host's `ctx.tools.register` runs
    // `assertSupportedJsonSchema` on this exact value and REJECTS a `required`
    // on a string property — the authoring form `defineTool` accepts is not the
    // form the registry stores (`toolParameterSubset.test.ts` `#219d` is the
    // interceptor that drives the host's own checker over every output schema).
    expect(schema.required).toEqual(['kind', 'subagentId'])
    expect(schema.properties['kind']).toEqual({ type: 'string', const: 'activation' })
    expect(schema.properties['subagentId']).toEqual({ type: 'string' })
    // `device` is OPTIONAL, and that is the honest shape rather than a
    // convenience: it is present exactly when the call supplied `cwd` (the
    // routing key), because without it the seam resolves the child directory
    // against the PARENT's cwd — which this tool cannot see — and a `routes`
    // entry could make any device it named wrong.
    expect(schema.properties['device']).toEqual({ type: 'string' })
    // …and NOT in `required`: the field is present exactly when the call gave an
    // absolute `cwd` (see `execute`).
    expect(schema.required).not.toContain('device')
    // No `cherrySessionId`: the session is created after `start()` has returned,
    // so the field would be empty on every call (see the module docblock).
    expect(Object.keys(schema.properties).sort()).toEqual(['device', 'kind', 'subagentId'])
  })

  it('②b renders the started child, not a JSON dump (SUB-62)', () => {
    const tool = build(recordingSeam())
    const rendered = tool.output.render(ARGS, { kind: 'activation', subagentId: 'child-9' })
    expect(rendered).toEqual([{ type: 'text', text: 'started subagent child-9' }])
    // With a device the text names it: the model needs it for `cherry_sessions`
    // and `cherry_read`, both of which address a device explicitly.
    expect(
      tool.output.render(ARGS, { kind: 'activation', subagentId: 'child-9', device: 'desk-1' }),
    ).toEqual([{ type: 'text', text: 'started subagent child-9 on device desk-1' }])
  })

  it('③a may join a parallel group (SUB-63)', () => {
    const tool = build(recordingSeam())
    // `true` is the only value that opts in; anything else is exclusive.
    expect(tool.isConcurrencySafe?.(ARGS)).toBe(true)
  })
})

describe('cherry_subagent execute', () => {
  it('④a refuses to run without a calling agent (SUB-65)', async () => {
    const seam = recordingSeam()
    const tool = build(seam)
    await expect(tool.execute(ARGS, exec({ agent: undefined }))).rejects.toThrow(/calling agent/)
    // Nothing was activated: a delegation with no parent has no result delivery
    // target, so it must fail before the seam sees it.
    expect(seam.specs).toEqual([])
  })

  it('④b hands the seam one parent-delivered activation, forwarding the parent and the signal', async () => {
    const seam = recordingSeam('child-42')
    const tool = build(seam)
    const controller = new AbortController()
    await tool.execute(ARGS, exec({ signal: controller.signal }))
    expect(seam.specs).toHaveLength(1)
    const spec = seam.specs[0]!
    // SUB-04: the CONFIGURED provider name, not a literal.
    expect(spec.provider).toBe('cherry')
    // The label is the display title the child's catalog entry and the Cherry
    // session title both use.
    expect(spec.label).toBe('audit the parser')
    expect(spec.request.prompt).toEqual([{ type: 'text', text: ARGS.prompt }])
    expect(spec.request.parent).toBe(PARENT)
    // The parent's cancellation is the run's: without it a disposed parent leaves
    // the child running.
    expect(spec.signal).toBe(controller.signal)
    // `parent` delivery is what makes the completion a NOTIFICATION (the host's
    // own tool uses the same value); `caller` would return the result here, and
    // this tool returns before the run ends.
    expect(spec.delivery).toBe('parent')
  })

  it('④c omits cwd when the model sent none, and forwards it when it did (SUB-60)', async () => {
    const seam = recordingSeam()
    const tool = build(seam)
    await tool.execute(ARGS, exec())
    // Omitted, NOT defaulted here: the seam resolves a missing cwd against the
    // parent's own working directory, and inventing one would bypass that.
    expect(seam.specs[0]!.request).not.toHaveProperty('cwd')
    await tool.execute({ ...ARGS, cwd: '/w/dsh' }, exec())
    expect(seam.specs[1]!.request.cwd).toBe('/w/dsh')
    // An EMPTY string is the same as absent: forwarding it would make the seam
    // resolve the child directory against `''`, which is not a directory.
    await tool.execute({ ...ARGS, cwd: '' }, exec())
    expect(seam.specs[2]!.request).not.toHaveProperty('cwd')
  })

  it('④d returns the id the seam minted, and the device the call routed to (SUB-62)', async () => {
    const seam = recordingSeam('child-42')
    const tool = build(seam)
    // No `cwd` ⇒ no device: the seam resolves the directory against the
    // PARENT's working directory, which this tool cannot see.
    await expect(tool.execute(ARGS, exec())).resolves.toEqual({
      kind: 'activation',
      subagentId: 'child-42',
    })
    // With an ABSOLUTE `cwd` the device is exact, and it is the SAME resolver
    // the runner uses — here the stub routes `/w/other` to a second desktop.
    await expect(tool.execute({ ...ARGS, cwd: '/w/other/x' }, exec())).resolves.toEqual({
      kind: 'activation',
      subagentId: 'child-42',
      device: 'desk-2',
    })
    // A RELATIVE `cwd` is omitted for the same reason as none at all: the seam
    // resolves it against the parent's directory before the runner sees it, so
    // matching the raw string against absolute route prefixes would name the
    // default desktop while the run landed on a routed one.
    await expect(tool.execute({ ...ARGS, cwd: 'src' }, exec())).resolves.toEqual({
      kind: 'activation',
      subagentId: 'child-42',
    })
  })

  it('⑤a takes its NAME from the config, never a literal (SUB-04)', () => {
    // `subagent.toolName` is validated and defaulted by the config table, so a
    // hardcoded name here would be a field an operator can set and the registry
    // never honours.
    expect(build(recordingSeam(), { toolName: 'custom_delegate' }).name).toBe('custom_delegate')
    expect(build(recordingSeam()).name).toBe('cherry_subagent')
  })

  it('④e rejects an empty prompt before the seam sees it', async () => {
    const seam = recordingSeam()
    const tool = build(seam)
    await expect(tool.execute({ description: 'x', prompt: '' }, exec())).rejects.toThrow(/"prompt"/)
    await expect(tool.execute({ prompt: 'y' }, exec())).rejects.toThrow(/"description"/)
    expect(seam.specs).toEqual([])
  })

  it('④f propagates a refused activation instead of inventing an id', async () => {
    const tool = build({
      startActivation: async () => {
        throw new Error('cherry subagent: the target device is unavailable (not-found)')
      },
    })
    // A refusal here is fail-BEFORE-return, so the seam's contract says reject:
    // swallowing it would tell the model a child exists when none does.
    await expect(tool.execute(ARGS, exec())).rejects.toThrow(/not-found/)
  })
})
