import {
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
  remoteFailureSchema,
} from '@cherrystudio/remote-protocol'
import type { SecureChannel } from '@cherrystudio/remote-transport'

/** Default cap on business requests in flight on a single connection. */
const DEFAULT_MAX_IN_FLIGHT = 8
/**
 * Default per-request timeout in milliseconds.
 *
 * ALIGNED WITH THE PROTOCOL'S IDLE TERM (v0.1.3 review, P3-4): the peer's
 * `remoteLimits.idleMs` is 60,000ms, the window after which the desktop may
 * consider the session idle and close it. A client-side timeout SHORTER than
 * that decides a request is dead while the peer still considers the session
 * live — it turns a slow-but-legal answer into a spurious local failure, and
 * (because the connection replays reads) into a second arrival the peer never
 * asked for. Waiting at least as long as the peer means every timeout this
 * client reports is a real one. `remoteLimits` is not imported here on purpose:
 * this module stays free of the protocol package's runtime surface, and the
 * value is pinned by the review that set it.
 */
const DEFAULT_TIMEOUT_MS = 60_000
/** Rejection message used once the channel can no longer carry responses. */
const CHANNEL_CLOSED_MESSAGE = 'JSON-RPC channel closed'
/** Bounded number of schema issues quoted in one drop warning. */
const ISSUE_LIMIT = 3
/**
 * Longest peer-supplied identifier (`method` / `id`) quoted in a drop warning.
 *
 * A LOG-SIZE bound, not a protocol one: the frame has already failed validation
 * when this applies, so the peer is either broken or hostile, and the log line
 * must not grow with whatever it sent.
 */
const FRAME_FIELD_LIMIT = 120

export interface JsonRpcClientOptions {
  /** Business requests allowed in flight at once; further calls queue. */
  maxInFlight?: number
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
}

/**
 * Whether a rejection is this client's "the channel can no longer answer" face.
 *
 * Exported so the connection layer classifies a dead channel WITHOUT keeping a
 * second copy of {@link CHANNEL_CLOSED_MESSAGE}: the literal lives here, in the
 * module that produces it, and every consumer asks this predicate instead. Two
 * copies of the text are two places to change and one place to forget, and the
 * failure mode before this predicate existed was exactly that — see
 * {@link writeLossError}.
 */
export function isChannelClosedError(error: unknown): boolean {
  return error instanceof Error && error.message === CHANNEL_CLOSED_MESSAGE
}

/**
 * The classified error for a FAILED WRITE, with the transport's own diagnosis
 * preserved as `cause`.
 *
 * A write failure means the frame never reached the peer: nothing can adjudicate
 * a request that was never sent, which is the transport-loss condition, not a
 * peer refusal. The upstream transport raises two such failures on this path —
 * "Remote record budget exceeded" (also aborting the connection) and "Remote
 * socket unavailable or congested" — and both used to be passed through
 * verbatim, so the connection layer (which classifies losses by the channel
 * message) neither recognised them nor replayed the read.
 *
 * The message is therefore the SAME classified face every in-flight request on
 * a dead link gets, and the upstream text rides along as `cause` instead of in
 * the message: operators keep the diagnosis (a record-budget kill reads
 * differently from congestion) while consumers key on one stable signal.
 */
function writeLossError(error: unknown): Error {
  const detail =
    error instanceof Error ? error : new Error(`JSON-RPC write failed (${String(error)})`)
  // The classified message is the FIRST argument and never derived from `detail`,
  // so it is byte-exact regardless of what the transport rejected with.
  return new Error(CHANNEL_CLOSED_MESSAGE, { cause: detail })
}

/**
 * The structured error a peer returns for a request. `code` is the literal
 * 1000 the transport reserves for protocol failures; `data.reason` is the
 * discriminator consumers switch on.
 */
export class JsonRpcRequestError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data: unknown) {
    super(message)
    this.name = 'JsonRpcRequestError'
    this.code = code
    this.data = data
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Serialises a frame for the channel; the channel itself carries objects. */
function encodeFrame(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

/**
 * Bounded, payload-free description of a dropped frame.
 *
 * The drop paths fire on frames that FAILED validation, which is exactly the
 * set of frames whose contents are least trustworthy — and a peer frame
 * carries user content (chat text, tool arguments, file paths). Logging the
 * frame itself would therefore publish arbitrary peer-supplied bytes at warn
 * level, in a log an operator shares when filing a bug. What an operator
 * actually needs is classification: which branch rejected it, the method name
 * (a bounded identifier the remote controls, and the only part that routes the
 * report), the request id when the frame carries one, and the schema path that
 * failed. Everything else stays out.
 *
 * BOUNDED IN LENGTH TOO, not only in content. `method` and `id` are
 * peer-supplied strings, and a hostile or merely broken peer can put a
 * megabyte in either: the frame fails validation, and this function then writes
 * that megabyte into the operator's log at warn level. Excluding payload fields
 * is not enough when the CLASSIFICATION fields are themselves unbounded, so
 * both are truncated with an explicit ellipsis (the marker matters — a silently
 * clipped value reads as the peer's actual method name, and an operator would
 * go looking for a tool that never existed).
 */
function describeFrame(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `frame is ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}`
  }
  const record = value as Record<string, unknown>
  const parts: string[] = []
  if (typeof record['method'] === 'string') parts.push(`method="${bounded(record['method'])}"`)
  if ('id' in record) parts.push(`id=${bounded(JSON.stringify(record['id']))}`)
  return parts.length === 0 ? 'frame has no method or id' : parts.join(' ')
}

/**
 * A peer-supplied identifier, clipped to {@link FRAME_FIELD_LIMIT} for logging.
 *
 * The limit is generous enough to keep every realistic method name and request
 * id intact — 120 characters is longer than any name the protocol defines — so
 * the clip only ever fires on a frame that is already malformed or hostile.
 */
function bounded(text: string): string {
  return text.length <= FRAME_FIELD_LIMIT ? text : `${text.slice(0, FRAME_FIELD_LIMIT)}…`
}

/** The zod issue paths of a failed parse, joined for one bounded log line. */
function describeIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, ISSUE_LIMIT)
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
}

/**
 * The full, payload-free drop warning: the branch that rejected the frame, its
 * classification, and the validation-error path that explains the rejection.
 */
function dropWarning(
  branch: string,
  value: unknown,
  error: { issues: Array<{ path: PropertyKey[]; message: string }> },
): string {
  return `[cherry-remote] dropped invalid JSON-RPC ${branch} (${describeFrame(value)}): ${describeIssues(error)}`
}

/**
 * JSON-RPC 2.0 client riding on a Noise-encrypted `SecureChannel`.
 *
 * The published transport package ships only a server, so this layer owns the
 * client half: id-keyed request/response correlation, in-flight limits, request
 * timeouts, and schema validation in both directions. One instance per
 * connection keeps multi-device dispatch isolated by construction.
 */
export class JsonRpcClient {
  private readonly channel: SecureChannel
  /**
   * Current admission cap. Mutable (unlike the other options) because the peer
   * reports its own concurrent-request allowance in `connection.hello`, and the
   * spec's half-the-report rule (§3.4) can only be honoured once that reply has
   * been seen — which is after this client was constructed.
   */
  private maxInFlight: number
  private readonly defaultTimeoutMs: number

  private nextId = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly handlers: Array<(method: string, params: unknown) => void> = []
  private inFlight = 0
  private readonly queue: Array<(error?: Error) => void> = []
  private disposed = false
  private reading = false
  /**
   * Set once the channel is known dead. Kept separate from `disposed` because
   * the two differ in who may still act: a closed channel is terminal for
   * requests, while `disposed` is a deliberate local shutdown.
   */
  private closed = false

  constructor(channel: SecureChannel, opts: JsonRpcClientOptions = {}) {
    this.channel = channel
    this.maxInFlight = opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.startReadLoop()
  }

  request<T>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('JSON-RPC client disposed'))
    // Fail fast once the channel is known dead: queueing onto it would only
    // burn a full timeout before rejecting anyway.
    if (this.closed) return Promise.reject(new Error(CHANNEL_CLOSED_MESSAGE))

    const id = this.nextId
    this.nextId += 1
    const envelope = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }
    const parsed = jsonRpcRequestSchema.safeParse(envelope)
    if (!parsed.success) {
      return Promise.reject(new Error(`Invalid JSON-RPC request for method "${method}"`))
    }

    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs

    return new Promise<T>((resolve, reject) => {
      const send = (abortError?: Error): void => {
        if (this.disposed || abortError !== undefined) {
          reject(abortError ?? new Error('JSON-RPC client disposed'))
          return
        }
        // `closed` is re-checked HERE, not only in `request`: a queued send is
        // admitted by `drainQueue` whenever the window frees, and a write
        // failure (which sets `closed`) is exactly what frees it. Draining into
        // a known-dead channel would write again to a socket the transport has
        // already abandoned — the same doomed write, one queue slot later.
        if (this.closed) {
          // Drain the whole queue here, not just this one entry: the window this
          // admission would have consumed is not consumed, so `drainQueue`'s
          // loop stops (nothing was admitted) and anything left behind would be
          // settled only by their own timeouts. Every queued request is dead
          // for the same reason, so they all take the classified face now.
          reject(new Error(CHANNEL_CLOSED_MESSAGE))
          for (const send of this.queue.splice(0, this.queue.length)) send()
          return
        }
        // Register before writing: the response can land as soon as the write
        // is queued, and an unregistered id would be dropped as unknown.
        const timer = setTimeout(() => {
          this.finish(id, `JSON-RPC request "${method}" timed out after ${timeoutMs}ms`)
        }, timeoutMs)
        this.pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        })
        this.inFlight += 1
        void this.channel.write(encodeFrame(parsed.data)).catch((error: unknown) => {
          // The write failed, so the frame never reached the peer and this
          // request has no adjudicator: the channel is dead for it. Report the
          // CLASSIFIED loss (same face the read loop gives every other in-flight
          // request on the dead link) with the transport's own message kept as
          // `cause`, and mark the client closed so requests admitted after this
          // point fail fast instead of writing into an aborted connection.
          this.closed = true
          const pending = this.pending.get(id)
          if (pending === undefined) return
          this.release(id)
          pending.reject(writeLossError(error))
        })
      }

      if (this.inFlight < this.maxInFlight) send()
      else this.queue.push(send)
    })
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.handlers.push(handler)
  }

  /**
   * Resizes the admission window: `n` is the new cap on requests that may be in
   * flight at once. Only ADMISSIONS are affected — requests already in flight
   * are never cancelled, re-queued, or rejected, because they have already been
   * written to the peer and the peer counts arrivals, not intentions.
   *
   * Shrinking takes effect immediately for new admissions: with more requests
   * in flight than the new cap, the queue simply drains back down to it before
   * anything further is admitted. Growing the window drains the queue at once.
   *
   * The cap is floored at 1: a cap of 0 would queue every request forever with
   * no event that could ever release one, which is a deadlock, not a limit.
   */
  updateMaxInFlight(n: number): void {
    // A non-finite input carries no window width at all; ignore it rather than
    // poisoning `maxInFlight` with NaN, which would make every comparison in
    // `drainQueue` false and wedge the queue permanently.
    if (!Number.isFinite(n)) return
    this.maxInFlight = Math.max(1, Math.floor(n))
    // Growing the window may have made room right now; shrinking admits nobody.
    this.drainQueue()
  }

  /**
   * Admits queued requests while the window has room.
   *
   * The bound is re-checked every iteration because `send()` is what increments
   * `inFlight`, and it can also reject without incrementing (disposed or
   * aborted), which must not spin this loop forever.
   */
  private drainQueue(): void {
    while (this.queue.length > 0 && this.inFlight < this.maxInFlight) {
      const before = this.inFlight
      this.queue.shift()!()
      if (this.inFlight === before) return
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.failAll('JSON-RPC client disposed')
  }

  /**
   * Tears the client down because its LINK went away, not because the local
   * side chose to stop using it.
   *
   * The distinction is the whole point of a separate entry point. `dispose()`
   * describes this object's own lifetime ("this client was disposed"), which is
   * an internal-sounding statement about the plugin's bookkeeping; a caller
   * holding an in-flight request needs to hear about the DEVICE — the spec §6
   * `{device, state}` condition — and this is the message every layer above
   * already classifies as a dead channel. So the link-loss path fails in flight
   * with {@link CHANNEL_CLOSED_MESSAGE}, exactly as the read loop's own
   * channel-death path does, and marks the client `closed` so a request issued
   * after the loss fails fast with the same face instead of queueing onto a
   * socket that no longer exists.
   *
   * `disposed` is set too — nothing may use this client again — but it is set
   * AFTER the rejection, so the message a caller sees is the link-loss one.
   */
  disposeForLinkLoss(): void {
    if (this.disposed) return
    this.closed = true
    this.failAll(CHANNEL_CLOSED_MESSAGE)
    this.disposed = true
  }

  /**
   * Rejects every request that can no longer be answered — both those in flight
   * and those still queued — with one structured error, and clears the queue so
   * no queued request is silently dropped.
   */
  private failAll(message: string): void {
    const error = new Error(message)
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.inFlight = 0
    const queued = this.queue.splice(0, this.queue.length)
    for (const send of queued) send(error)
  }

  /** Settles one pending request and releases its in-flight slot. */
  private finish(id: number, message: string): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.release(id)
    pending.reject(new Error(message))
  }

  private resolve(id: number, value: unknown): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.release(id)
    pending.resolve(value)
  }

  /**
   * Removes bookkeeping for one id and admits the next queued request, but only
   * if the window has room. The room check is not redundant with the one in
   * `request`: the cap can shrink while requests are in flight
   * ({@link updateMaxInFlight}), and an unconditional admit here would let the
   * shrunk window be refilled straight back to the old width.
   */
  private release(id: number): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    this.inFlight -= 1
    this.drainQueue()
  }

  /**
   * Drains the channel until it closes. Frames are dispatched in a fixed order:
   * (a) no `id` → notification, (b) `id` + `method` → request, (c) any other
   * `id` frame → response. A frame matching no branch is dropped with a warning
   * so a forward-compatible peer can never crash the client.
   */
  private startReadLoop(): void {
    if (this.reading) return
    this.reading = true
    void (async () => {
      for (;;) {
        let frame: unknown
        try {
          frame = await this.channel.read()
        } catch {
          // The channel is dead: no response can ever arrive, so fail every
          // outstanding request now instead of letting each burn its timeout.
          // Skipped after dispose(), which has already rejected everything.
          if (!this.disposed) {
            this.closed = true
            this.failAll(CHANNEL_CLOSED_MESSAGE)
          }
          return
        }
        if (this.disposed) return
        try {
          this.dispatch(frame)
        } catch (error) {
          // JSON.parse of a string frame is the only throw here; the frame
          // itself is NOT logged (see `describeFrame`).
          console.warn(
            `[cherry-remote] dropped unparsable JSON-RPC frame (${
              error instanceof Error ? error.message : String(error)
            })`,
          )
        }
      }
    })()
  }

  private dispatch(frame: unknown): void {
    const value = typeof frame === 'string' ? (JSON.parse(frame) as unknown) : frame
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      console.warn(`[cherry-remote] dropped non-object JSON-RPC frame (${describeFrame(value)})`)
      return
    }

    const record = value as Record<string, unknown>
    const hasId = 'id' in record

    // (a) No id → notification. Checked first: a valid notification has no
    // result/error, so a response-first parse would wrongly reject it.
    if (!hasId) {
      const parsed = jsonRpcNotificationSchema.safeParse(value)
      if (!parsed.success) {
        console.warn(dropWarning('notification', value, parsed.error))
        return
      }
      const { method, params } = parsed.data
      for (const handler of [...this.handlers]) {
        try {
          handler(method, params)
        } catch (error) {
          console.warn(`[cherry-remote] notification handler for "${method}" threw`, error)
        }
      }
      return
    }

    // (b) id + method → request. A client does not serve requests, but the
    // shape must be recognised so it is not misread as a response.
    if ('method' in record) {
      const parsed = jsonRpcRequestSchema.safeParse(value)
      if (!parsed.success) {
        console.warn(dropWarning('request', value, parsed.error))
        return
      }
      console.warn(
        `[cherry-remote] ignoring inbound JSON-RPC request "${parsed.data.method}" (client does not serve requests)`,
      )
      return
    }

    // (c) Any other id-bearing frame → response.
    const parsed = jsonRpcResponseSchema.safeParse(value)
    if (!parsed.success) {
      console.warn(dropWarning('response', value, parsed.error))
      return
    }
    const response = parsed.data
    if (!('id' in response) || typeof response.id !== 'number') {
      // String/null ids cannot come from this client's counter. The id itself is
      // omitted for the same reason the payload is: it is peer-supplied.
      console.warn('[cherry-remote] dropped JSON-RPC response with unknown id')
      return
    }
    if ('error' in response) {
      const { code, message, data } = response.error
      // `reason` is a closed 16-value enum carried in `data`. A known reason is
      // surfaced verbatim so consumers can switch on it (Task 8/9 anchor on
      // this pass-through). A future value fails `remoteFailureSchema`; that is
      // the rejection-degradation path, so the request still rejects with a
      // structured error preserving the original code and message rather than
      // crashing the client or propagating an unrecognised discriminator.
      const known = data !== null && typeof data === 'object' && remoteFailureSchema.safeParse(data).success
      this.reject(response.id, new JsonRpcRequestError(code, message, known ? data : undefined))
      return
    }
    this.resolve(response.id, response.result)
  }

  private reject(id: number, error: Error): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.release(id)
    pending.reject(error)
  }
}
