import { connectSecureChannel } from "@cherrystudio/remote-transport";
import "@cherrystudio/remote-protocol/agent";
//#region src/connection.d.ts
/**
 * Options handed to every `WebSocket` dial (issue #126).
 *
 * FLAT `tls.connect` options — `ws` forwards its own option bag straight to
 * `tls.connect`, so `{ rejectUnauthorized: false }` or `{ ca: <pem> }` belong
 * at the top level rather than under a `tls:` key.
 */
type WsDialOptions = {
  rejectUnauthorized?: boolean;
  ca?: string | Buffer | Array<string | Buffer>;
};
//#endregion
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
 *
 * This is the SHARED tier: it covers every business RPC EXCEPT the content-read
 * tier below (see {@link DEFAULT_CONTENT_READ_BUDGET_PER_SECOND}).
 *
 * WHY 32: the desktop's allowance for "other" RPCs is 64/s through 2.1.6 and
 * 256/s from 2.1.7 (`RemoteAccessService.ts`; the official client paces them at
 * 40/s, `DesktopSession.ts:36-37`). What an over-budget request does also
 * changed: through 2.1.6 it closes the WHOLE session (1011), while 2.1.7 (PR
 * #21687) refuses that one request (`RATE_LIMITED` + `retryAfterMs`) and keeps
 * the session. The generations cannot be told apart before one answers, so the
 * default is sized for the older, harsher peer: 32 is half of 64 and an eighth
 * of 256, leaving room for the housekeeping traffic that shares the socket
 * (hello/authenticate/ping/refresh bypass pacing by design) and for arrival
 * compression between our admission times and the peer's arrival times.
 *
 * SOURCES (neither is in this repository): the desktop lines are
 * `_research/cherry-studio` @ v2.1.6 (90b234e) and CherryHQ/cherry-studio @
 * v2.1.7; the official-client lines are CherryHQ/cherry-studio-app @ v0.4.0,
 * both read on 2026-10-22 (issue #102).
 */
export declare const DEFAULT_RATE_BUDGET_PER_SECOND = 32;
/**
 * The second-level smoothed request budget for the CONTENT-READ tier, which
 * carries exactly one method: `agent.content.read` (see `classifyRateTier` in
 * `connection.ts` — the classification is exact-match, not a prefix).
 *
 * WHY A SEPARATE TIER: an externalized part is read as a walk of
 * `agent.content.read` slices, so this one method carries the whole throughput
 * of every large reply. Cherry Studio >= 2.1.6 externalizes every part over
 * 4,096 characters, which makes long replies the common case, while the desktop
 * paces content reads against a 512/s allowance of their own
 * (`RemoteAccessService.ts:223-225`) and the official client issues them at
 * 480/s (`DesktopSession.ts:33-37`). Pacing them with the 32/s shared tier
 * bound a multi-slice walk to ~670 KiB/s and queued it behind unrelated RPCs;
 * 256 is half the 512/s content allowance in BOTH desktop generations (the
 * shared-tier allowance changed in 2.1.7; this one did not) and lifts the bound
 * to the multi-MiB/s range of the official client while leaving the desktop a
 * session-sized headroom.
 *
 * NOT a plugin-config key: the two tiers derive from ONE injected shared budget
 * at the ratio below, so an operator who lowers `rateBudgetPerSecond` lowers
 * both. A second config key is deliberately deferred until there is a field
 * report that needs one.
 *
 * THE MARGINS ARE A DEFAULT-INJECTION CLAIM: the 2× headroom above holds at
 * the default injection (32/s), where this tier is exactly 256/s. An injected
 * budget consumes BOTH tiers' headroom up to the point where this tier reaches
 * the PEER'S CEILING — at 64/s the shared tier sits on the ≤2.1.6 line (the
 * harsher generation, where overrun still closes the session) and this tier
 * derives to exactly 512/s, the content allowance BOTH generations share. Above
 * 64/s the clamp holds it at 512/s: `contentBudgetFor` (issue #111) still
 * derives the ratio, then bounds it — because a knob copied from 2.1.7's shared
 * figure (256)
 * would otherwise derive 2,048/s and spend the tier being refused. The
 * limiter's integer gap means the ACHIEVED rate stays below the nominal one in
 * that case (≤ 334/s on this tier, 55.6/s on the shared one; see
 * `SecondWindowRateLimiter` in `connection.ts`), which is margin by accident
 * rather than by design.
 */
export declare const DEFAULT_CONTENT_READ_BUDGET_PER_SECOND = 256;
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
   * Second-level smoothed request budget per device for the business RPCs on
   * the SHARED tier, handed to {@link DeviceConnection}. Omitted uses
   * {@link DEFAULT_RATE_BUDGET_PER_SECOND}.
   *
   * The CONTENT tier is not configurable on its own: it DERIVES from this value
   * at the 8 : 1 production ratio (`DEFAULT_CONTENT_READ_BUDGET_PER_SECOND` /
   * `DEFAULT_RATE_BUDGET_PER_SECOND`), so the default 32 yields the 256/s
   * content tier and lowering this lowers both. UPWARD the derivation stops at
   * the peer's 512/s content allowance (issue #111): a value above 64 no longer
   * scales that tier, it only spends the shared tier's margin. Raising this
   * toward the peer's own lines spends margin: on a <=2.1.6 desktop that is
   * BOTH tiers (64 shared / 512 content), while on 2.1.7 only the shared line
   * moves (256 there). See `DEFAULT_CONTENT_READ_BUDGET_PER_SECOND` for the
   * numbers.
   */
  rateBudgetPerSecond?: number;
  /**
   * LOCAL per-session event-cache byte budget for {@link SessionSubscriptions}
   * (not a protocol value). Omitted uses {@link DEFAULT_PER_SESSION_CACHE_BYTES}.
   */
  perSessionCacheBytes?: number;
  /**
   * FLAT `tls.connect` options for every `wss` dial (issue #133): the operator's
   * TLS trust for a desktop behind a private CA or a self-signed TLS front.
   * `ws` forwards this bag straight to Node's TLS layer, so `{ ca: <pem> }` and
   * `{ rejectUnauthorized: false }` belong at the TOP level — the `{ tls: {…} }`
   * shape (`https`' wrapper) is not recognised by `ws` and is refused here.
   * Applied to BOTH dial sites: the steady-state pool and pairing.
   *
   * NEVER persisted in the record, never logged, never reported: a `ca` is PEM
   * CONTENT, and trust is a grant the operator makes, not a fact the desktop
   * asserts about itself.
   */
  wsTls?: WsDialOptions;
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
  wsTls: WsDialOptions | undefined;
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