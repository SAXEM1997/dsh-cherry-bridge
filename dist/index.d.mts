import { connectSecureChannel } from "@cherrystudio/remote-transport";
import "@cherrystudio/remote-protocol/agent";
//#region src/tools.d.ts
/**
 * The plugin's tool face: the complete fourteen-tool `cherry_*` family — six
 * READ-ONLY tools (Task 8), six INTERACTIVE ones (Task 9) and two MANAGEMENT
 * ones (Task 10) — plus the registration framework they all share.
 *
 * Three disciplines run through every tool:
 *
 *  - **Literal JSON Schema parameters** (global constraint): the host registry
 *    consumes the declaration directly, so no zod enters this file.
 *  - **The device selector never throws for ambiguity**: an ambiguous display
 *    name is a structured candidate list, and a non-connected device is the
 *    structured `{device, state}` verdict of spec §6 — never an implicit dial.
 *  - **Pagination is an aggregate concern** (controller ruling ②): the caller's
 *    `limit` bounds the TOTAL across pages, while every page request is clamped
 *    to BOTH the peer-negotiated `limits.pageItems` AND a byte-safe page budget
 *    (`defaults.ts`) — the protocol's single-page hard cap is never exceeded
 *    and no page may serialize past the 64 KiB record budget the transport
 *    enforces by killing the connection.
 */
/** One tool's literal JSON Schema parameters, as the host registry stores them. */
interface ToolParametersSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}
/** A content block the host turns into model-facing tool output. */
interface ToolContentBlock {
  type: 'text';
  text: string;
}
/** The registry-ready definition this plugin hands the host. */
interface CherryToolDefinition {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
  output: {
    /** Canonical value schema; the host validates `execute`'s return against it. */
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): ToolContentBlock[];
  };
  execute(args: Record<string, unknown>): Promise<unknown>;
}
/** The host's tool registry, as this plugin consumes it. */
interface ToolsServiceLike {
  register(definition: CherryToolDefinition): () => void;
}
/** The context slice the tool face needs. */
interface CherryToolsContext {
  tools?: ToolsServiceLike;
}
//#endregion
//#region src/diagnostics.d.ts
/** One recent error summary (spec §5: 「最近错误摘要」). */
interface DiagnosticsError {
  at: string;
  deviceId?: string;
  sessionId?: string;
  reason: string;
  message: string;
}
//#endregion
//#region src/httpApi.d.ts
/** One HTTP request, as the routes read it (Node's IncomingMessage fits). */
interface HttpRequestLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on?(event: 'close', listener: () => void): unknown;
  [Symbol.asyncIterator]?(): AsyncIterator<Uint8Array>;
}
/** One HTTP response, as the routes write it (Node's ServerResponse fits). */
interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string | number>): unknown;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
  on?(event: 'close', listener: () => void): unknown;
}
/** The host's named-route registration contract. */
interface WebServerLike {
  /** Register one named route; returns the disposer removing it. */
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: WebRouteHandler;
  }): () => void;
}
type WebRouteHandler = (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>;
/** The bind-dependent Web values the fence needs. */
interface WebRuntimeLike {
  /** LAN literals followed by explicit invocation authorities. */
  trustedHosts: readonly string[];
  /**
   * 0.2.1 only: the explicit `--host` listener bind, when one was given. A
   * bare hostname (never an authority with a port) — the fence's
   * `isTrustedAuthority` matches a bare entry on any port.
   */
  host?: string;
}
/** The context carrying the host's web services. */
interface CherryHttpContext {
  webServer?: WebServerLike;
  /**
   * DSH 0.2.0 shape only. 0.2.1-rc.2 removed the service (issue #7), so this is
   * one OPTIONAL source for `trustedHosts` — never an injection key.
   */
  webRuntime?: WebRuntimeLike;
  /** cordis' optional service lookup — no inject gate; absent ⇒ `undefined`. */
  get?(name: string): unknown;
  inject?<T>(deps: string[], callback: (ctx: T) => void | (() => void)): unknown;
}
//#endregion
//#region src/defaults.d.ts
/**
 * The cross-cutting default constants, in ONE place.
 *
 * These two values are contractual (spec §3.4 / §3.5) and are consumed by three
 * different modules: the assembly's config resolver (`index.ts`), the connection
 * layer's rate limiter, and the subscription layer's cache budget. They used to
 * be declared privately in each, which is a drift surface with a silent failure
 * mode: change one copy and the assembly's documented default stops matching the
 * behaviour a layer actually applies, with no test able to see the disagreement.
 *
 * IMPORT CYCLE RULE: this module imports NOTHING from `index.ts`,
 * `connection.ts` or `subscriptions.ts`. It is a leaf, so all three can depend
 * on it directly. `index.ts` re-exports both names, keeping the public surface
 * (and the contract test that pins it) stable.
 */
/**
 * The second-level smoothed request budget: admissions per second for business
 * RPCs (spec §3.4). Injectable through plugin config; this is the fallback.
 */
export declare const DEFAULT_RATE_BUDGET_PER_SECOND = 32;
/** 2 MiB of event text cached per session (spec §3.5). */
export declare const DEFAULT_PER_SESSION_CACHE_BYTES: number;
//#endregion
//#region src/index.d.ts
export declare const name = "cherry-remote";
export declare const inject: string[];
/**
 * Plugin assembly — the FULL M3 wiring.
 *
 * Four things live here and nowhere else, because only the assembly can own
 * them:
 *
 *  1. **The device pool** — one lazily created {@link DeviceConnection} per
 *     archive record, shared by the tool face and the HTTP face so a device has
 *     exactly one socket however it is reached. The pool's load-bearing rule is
 *     that a `DeviceConnection` captures its `DeviceRecord` at construction and
 *     never re-reads it, so anything that changes the record must EVICT the
 *     pooled entry (see {@link evictConnection}).
 *  2. **The subscription pool** — one {@link SessionSubscriptions} per device,
 *     whose peer-negotiated `subscriptionsLimit` is read from THAT connection's
 *     hello-effective limits (never a hardcoded constant), plus the notification
 *     routing and the reconnect recovery that keep it live across a link drop.
 *  3. **The two assembly channels** — {@link publishDeviceState} and
 *     {@link publishPairingProgress}, the single fan-out every observer (the SSE
 *     event source, later a UI) subscribes to.
 *  4. **Config resolution** — the plugin-config keys with their fallbacks,
 *     applied to the objects that take them as constructor arguments.
 *
 * ## The four-line subscription wiring (brief Step 3)
 *
 *  - **subs factory** — {@link subsFor}: `subs(deviceId)` returns (lazily
 *    creating) that device's `SessionSubscriptions`.
 *  - **notification routing** — the `rpc.onNotification` hook installed in
 *    {@link connectionFor} hands every peer notification to that device's
 *    subscription layer, which is the only thing that reads the event stream.
 *  - **subscription recovery** — {@link recoverSubscriptions} runs on every
 *    transition INTO `connected`, re-ensuring each active session at its last
 *    cursor.
 *  - **event source** — the same `onState` hook publishes
 *    {@link DeviceStateEvent}s onto the assembly channel the SSE route consumes.
 *
 * Pairing's `onStatus(stage)` bridges to {@link publishPairingProgress} in
 * {@link assemblyDeps}'s `pair` member.
 */
export interface CherryBridgeConfig {
  /**
   * Plugin data directory holding `identity.key` and `devices.json`, both
   * 0600. Omitted follows `$DSH_HOME`, then `~/.dsh`.
   */
  dataDir?: string;
  /**
   * Second-level smoothed request budget per device, handed to
   * {@link DeviceConnection}. Omitted uses {@link DEFAULT_RATE_BUDGET_PER_SECOND}.
   */
  rateBudgetPerSecond?: number;
  /**
   * LOCAL per-session event-cache byte budget for {@link SessionSubscriptions}
   * (not a protocol value). Omitted uses {@link DEFAULT_PER_SESSION_CACHE_BYTES}.
   */
  perSessionCacheBytes?: number;
}
/**
 * The two config values that reach constructor arguments, with their defaults
 * applied.
 *
 * Resolved ONCE per `apply` and threaded explicitly, rather than re-read at each
 * construction site: a config surface that can change between two constructions
 * of the same pool would let two devices of one plugin disagree about the budget.
 */
export interface ResolvedBridgeConfig {
  rateBudgetPerSecond: number;
  perSessionCacheBytes: number;
}
/** Applies the documented fallbacks to the plugin config's numeric keys. */
export declare function resolveBridgeConfig(config?: CherryBridgeConfig): ResolvedBridgeConfig;
/** The context slice `apply` touches beyond the HTTP face's own services. */
export interface CherryBridgeContext extends CherryHttpContext, CherryToolsContext {
  effect?(callback: () => () => void): unknown;
}
/** The data directory convention every DSH plugin follows. */
export declare function resolveDataDir(config?: CherryBridgeConfig, env?: NodeJS.ProcessEnv): string;
/**
 * Records one error summary for the diagnostics endpoint.
 *
 * TWO bounds, both real:
 *
 *  - the ring keeps at most {@link RECENT_ERROR_LIMIT} entries, and
 *  - the `message` is truncated to {@link ERROR_MESSAGE_MAX} characters here
 *    too, so an over-long string never enters memory in the first place. The
 *    HTTP boundary applies the same cap again (`sanitizeDiagnostics`), which is
 *    the one that actually protects the endpoint — this one is cheap
 *    defense in depth.
 *
 * PRODUCER DISCIPLINE (not enforced by types): pass pre-redacted static context
 * — a device id, a state name, a protocol reason. NEVER a peer-echoed payload:
 * `message` is the only free-text field that reaches the report, and the
 * truncation bounds its LENGTH, not its sensitivity.
 */
export declare function noteError(entry: DiagnosticsError): void;
export declare function apply(ctx: CherryBridgeContext, config?: CherryBridgeConfig): void;
//#endregion