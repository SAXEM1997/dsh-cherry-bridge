import { isAbsolute } from 'node:path'
import { CHERRY_SUBAGENT_TOOL_DEFAULT } from './defaults.js'
import type { CherryToolDefinition, ToolContentBlock } from './tools.js'

/**
 * The model-facing `cherry_subagent` tool: one activation, one child id.
 *
 * ## Why this is a file of its own
 *
 * The tool is the only part of the subsystem that needs BOTH the host's tool
 * registry and `ctx.subagents` — and it needs neither of them for long. Putting
 * it beside the provider (`subagent.ts`) would drag the registry into a module
 * that deliberately knows nothing about tools; putting it in `tools.ts` would
 * drag `startActivation` into a module that deliberately knows nothing about
 * subagents. What is left over is small enough to state in one screen.
 *
 * ## What it does NOT do
 *
 * It does not wait. `startActivation` returns as soon as the provider has a run
 * handle, and everything that can fail slowly — dialling the device, creating
 * the Cherry session, the run itself — settles through the run's result and
 * reaches the parent as a completion notification. That is the seam's own
 * division (`start` fails-before-return, or settles-after), and it is why this
 * tool has no timeout of its own: the delegation's `timeoutMs` is the child's
 * wall clock, not the parent's turn.
 *
 * ## What the answer can and cannot carry
 *
 * `device` IS here whenever the call supplied an ABSOLUTE `cwd`: it is then a
 * pure function of the operator's config and that path (`resolveTargetDevice`,
 * shared with the runner), so the model can hand it straight to
 * `cherry_sessions`. Otherwise the field is omitted, because the seam resolves a
 * missing or relative directory against the PARENT's working directory — which
 * this tool cannot see — and a `routes` entry could make any answer it invented
 * wrong.
 *
 * `cherrySessionId` is NOT, and the reason is a trade-off rather than an
 * impossibility. The session is created by the runner AFTER `start()` has
 * returned the run handle — that ordering is what lets an unreachable desktop
 * settle through the run's result instead of stalling the parent's turn. A
 * provider COULD await session creation inside `start()` and report it, and then
 * this tool could return it; that would trade a fast tool call for a
 * device-handshake-shaped one, and it is a decision for the delegation's owner,
 * not for this file. Until then the operator finds the session by the title the
 * delegation gave it (the task label, SUB-23).
 *
 * ## The wording is load-bearing (SUB-54, SUB-64)
 *
 * A model that believes the child sees this conversation will under-specify the
 * prompt; one that believes it can send a follow-up will try, and there is no
 * inbox on an external provider; one that reads a refusal as a crash will redo
 * work the child already declined. Each of those is a sentence in
 * {@link DESCRIPTION}, not a comment in the code.
 */

/**
 * The `prompt`/`parent`/`cwd` triple one activation carries.
 *
 * `cwd` is OPTIONAL here, unlike {@link SubagentStartRequest}: this is the
 * request as a CALLER states it, before the seam resolves a missing directory
 * against the parent's own. Passing `undefined` through instead of defaulting it
 * here is what keeps that resolution in one place.
 */
export interface CherryActivationRequest {
  readonly cwd?: string
  readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
  /** The delegating agent; the seam needs it for delivery and for `cwd`. */
  readonly parent: unknown
}

/** The activation call this tool makes, structurally (`ctx.subagents.startActivation`). */
export interface CherryActivationSpec {
  readonly provider: string
  readonly label: string
  readonly request: CherryActivationRequest
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'
}

/** What one activation answers: the child's identity, and nothing else yet. */
export interface CherryActivation {
  readonly childId: string
}

/**
 * The model-facing description.
 *
 * Four facts, each one a mistake the model would otherwise make (SUB-64), plus
 * the refusal note SUB-54 requires. Kept as one constant so a test can assert
 * the phrases and a reader can see all of them at once.
 */
const DESCRIPTION =
  'Delegate a self-contained task to a Cherry Studio agent: a separate agent that works in ' +
  "its own context on the operator's desktop, so the work does not consume this conversation's " +
  'context.\n\n' +
  'The child does NOT see this conversation — include everything it needs in `prompt`. It does ' +
  'NOT accept follow-up messages: nothing you say after this call reaches it. This tool starts ' +
  'the run and returns at once; the runtime notifies you when the child finishes, and the ' +
  'notification carries the child\'s final answer.\n\n' +
  'The child may decline the task — Cherry agents have their own role boundaries — and a ' +
  'refusal is a normal completed run whose text IS the refusal. Read the answer before ' +
  'assuming the work was done.'

/**
 * Read one required non-empty string argument.
 *
 * A local copy of `tools.ts`'s `requiredString` on purpose: sharing it would
 * publish a three-line predicate from a module whose exports are a compatibility
 * commitment (`src` ships in the tarball), which is a worse trade than the
 * duplication.
 */
function requiredArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`cherry_subagent: "${key}" is required and must be a non-empty string`)
  }
  return value
}

/**
 * Build the tool for one apply.
 *
 * @param parts - the configured provider name and the activation call.
 * @returns a registry-ready definition; nothing is registered here.
 */
export function createCherrySubagentTool(parts: {
  /** The CONFIGURED tool name (`subagent.toolName`), never a literal. */
  readonly toolName?: string
  /** The CONFIGURED provider name (`subagent.providerName`), never a literal. */
  readonly providerName: string
  /**
   * Which desktop a task in `cwd` will address. Supplied by the assembly so this
   * file does not need the target/routes table — and so the tool and the runner
   * share one answer ({@link resolveTargetDevice}).
   */
  readonly resolveDevice: (cwd: string) => string
  readonly startActivation: (spec: CherryActivationSpec) => Promise<CherryActivation>
}): CherryToolDefinition {
  return {
    name: parts.toolName ?? CHERRY_SUBAGENT_TOOL_DEFAULT,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          description:
            'The complete, self-contained task for the child. It does not share this ' +
            "conversation's context, so include everything it needs.",
        },
        cwd: {
          type: 'string',
          description:
            'Initial child working directory. Relative paths use your current directory; ' +
            'omitted inherits it. It also selects the operator\'s route for this directory, ' +
            'so a delegation may land on a different desktop or workspace than the default. ' +
            'Later directory changes in either agent are independent.',
        },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
    output: {
      // The COMPILED dialect, not the authoring one. The host's own tool writes
      // `kind: { type: 'string', required: true }` and hands it to `defineTool`,
      // which compiles it to an object-level `required` list before registering;
      // this definition goes to `ctx.tools.register` RAW, and that call runs
      // `assertSupportedJsonSchema`, which rejects `required` on a string
      // property outright. Copying the authoring literal without its compile
      // step is a tool that never registers.
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'subagentId'],
        properties: {
          kind: { type: 'string', const: 'activation' },
          subagentId: { type: 'string' },
          // Optional on purpose: present exactly when the call supplied an
          // ABSOLUTE `cwd`, the routing key the runner will use. See `execute`.
          device: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown): ToolContentBlock[] => {
        const { subagentId, device } = value as { subagentId?: unknown; device?: unknown }
        // The id is what the completion notice will name; the device is what
        // `cherry_sessions` / `cherry_read` address, and it is known only when
        // the call gave the routing key (see `execute`).
        return [
          {
            type: 'text',
            text:
              device === undefined
                ? `started subagent ${String(subagentId)}`
                : `started subagent ${String(subagentId)} on device ${String(device)}`,
          },
        ]
      },
    },
    // SUB-63: a delegation mutates nothing this plugin owns — it creates a
    // session on the peer — so several may start in one assistant message.
    isConcurrencySafe: () => true,
    execute: async (args: Record<string, unknown>, exec): Promise<unknown> => {
      // SUB-65: without a parent there is no result delivery target and no
      // working directory to resolve against, so the seam would have nothing to
      // notify. Failing here is the only honest answer.
      if (exec?.agent === undefined) {
        throw new Error(
          'cherry_subagent: this tool requires a calling agent (exec.agent was undefined)',
        )
      }
      const parent = exec.agent
      // Both reads happen BEFORE the seam is called: a malformed task must not
      // leave a Cherry session behind (SUB-20's discipline, one layer up).
      const label = requiredArgument(args, 'description')
      const text = requiredArgument(args, 'prompt')
      const cwd = typeof args['cwd'] === 'string' && args['cwd'] !== '' ? args['cwd'] : undefined
      // The device is resolved only when the answer is EXACT, which needs an
      // absolute `cwd`:
      //
      //  - no `cwd` at all — the seam resolves the child directory against the
      //    PARENT's working directory, which this tool cannot see;
      //  - a RELATIVE `cwd` — the seam resolves it the same way before the
      //    runner ever sees it (`resolveDirectory`), so matching the raw string
      //    against absolute `routes[].cwdPrefix` values would report the default
      //    device while the run landed on a routed one.
      //
      // Both would name a desktop the run does not address, and the model's
      // follow-up (`cherry_sessions` takes a device) would read the wrong one.
      const device = cwd !== undefined && isAbsolute(cwd) ? parts.resolveDevice(cwd) : undefined
      const activation = await parts.startActivation({
        provider: parts.providerName,
        label,
        request: {
          ...(cwd === undefined ? {} : { cwd }),
          prompt: [{ type: 'text', text }],
          parent,
        },
        // The parent's own cancellation: a disposed parent must stop the child,
        // and the seam forwards this into the provider's local controller.
        signal: exec.signal,
        // `parent` delivery is what turns the child's settlement into a
        // notification on the delegating conversation.
        delivery: 'parent',
      })
      return {
        kind: 'activation',
        subagentId: activation.childId,
        ...(device === undefined ? {} : { device }),
      }
    },
  }
}
