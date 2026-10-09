import {
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
  remoteFailureSchema,
} from '@cherrystudio/remote-protocol'
import type { SecureChannel } from '@cherrystudio/remote-transport'

/** Default cap on business requests in flight on a single connection. */
const DEFAULT_MAX_IN_FLIGHT = 8
/** Default per-request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000
/** Rejection message used once the channel can no longer carry responses. */
const CHANNEL_CLOSED_MESSAGE = 'JSON-RPC channel closed'

export interface JsonRpcClientOptions {
  /** Business requests allowed in flight at once; further calls queue. */
  maxInFlight?: number
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
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
 * JSON-RPC 2.0 client riding on a Noise-encrypted `SecureChannel`.
 *
 * The published transport package ships only a server, so this layer owns the
 * client half: id-keyed request/response correlation, in-flight limits, request
 * timeouts, and schema validation in both directions. One instance per
 * connection keeps multi-device dispatch isolated by construction.
 */
export class JsonRpcClient {
  private readonly channel: SecureChannel
  private readonly maxInFlight: number
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
          this.finish(id, error instanceof Error ? error.message : 'JSON-RPC write failed')
        })
      }

      if (this.inFlight < this.maxInFlight) send()
      else this.queue.push(send)
    })
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.handlers.push(handler)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.failAll('JSON-RPC client disposed')
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

  /** Removes bookkeeping for one id and admits the next queued request. */
  private release(id: number): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    this.inFlight -= 1
    const next = this.queue.shift()
    if (next !== undefined) next()
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
          console.warn('[cherry-remote] dropped malformed JSON-RPC frame', error)
        }
      }
    })()
  }

  private dispatch(frame: unknown): void {
    const value = typeof frame === 'string' ? (JSON.parse(frame) as unknown) : frame
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      console.warn('[cherry-remote] dropped non-object JSON-RPC frame', value)
      return
    }

    const record = value as Record<string, unknown>
    const hasId = 'id' in record

    // (a) No id → notification. Checked first: a valid notification has no
    // result/error, so a response-first parse would wrongly reject it.
    if (!hasId) {
      const parsed = jsonRpcNotificationSchema.safeParse(value)
      if (!parsed.success) {
        console.warn('[cherry-remote] dropped invalid JSON-RPC notification', value)
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
        console.warn('[cherry-remote] dropped invalid JSON-RPC request', value)
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
      console.warn('[cherry-remote] dropped invalid JSON-RPC response', value)
      return
    }
    const response = parsed.data
    if (!('id' in response) || typeof response.id !== 'number') {
      // String/null ids cannot come from this client's counter.
      console.warn('[cherry-remote] dropped JSON-RPC response with unknown id', response.id)
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
