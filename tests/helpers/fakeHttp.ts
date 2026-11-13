import { EventEmitter } from 'node:events'
import type { HttpRequestLike, HttpResponseLike } from '../../src/httpApi.js'

/**
 * The one fake HTTP pair shared by the HTTP-surface suites
 * (`httpApi`, `scopeHttpApi`, `toolsManage`): a `node:events`-backed request
 * whose body is one string, and a response that records everything a route
 * writes. Shapes only — nothing here validates protocol content.
 */
export interface FakeRequestInit {
  method?: string
  host?: string
  origin?: string
  headers?: Record<string, string>
  body?: string
  /** The body stream THROWS when read: proves a route refused before reading it. */
  unreadableBody?: boolean
}

export class FakeRequest extends EventEmitter implements HttpRequestLike {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly #body: string
  readonly #unreadable: boolean

  constructor(url: string, init: FakeRequestInit = {}) {
    super()
    this.url = url
    this.method = init.method ?? 'GET'
    this.#body = init.body ?? ''
    this.#unreadable = init.unreadableBody === true
    this.headers = { ...(init.headers ?? {}) }
    if (init.host !== undefined) this.headers['host'] = init.host
    if (init.origin !== undefined) this.headers['origin'] = init.origin
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    if (this.#unreadable) throw new Error('this route must not read the request body')
    if (this.#body !== '') yield Buffer.from(this.#body, 'utf8')
  }

  /** Simulates the client hanging up (SSE disconnect). */
  disconnect(): void {
    this.emit('close')
  }
}

/** One SSE frame written to a {@link FakeResponse}, parsed from the body. */
export interface SentFrame {
  event?: string
  data?: string
  comment?: string
}

export class FakeResponse implements HttpResponseLike {
  status = 0
  headers: Record<string, string> = {}
  body = ''
  ended = false
  /** SSE writes so far — distinguishes "one frame" from "kept alive". */
  writes = 0
  readonly #emitter = new EventEmitter()

  writeHead(status: number, headers: Record<string, string | number> = {}): void {
    this.status = status
    for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = String(value)
  }

  write(chunk: string): void {
    this.writes += 1
    this.body += chunk
  }

  end(chunk?: string): void {
    if (chunk !== undefined) this.body += chunk
    this.ended = true
  }

  on(event: string, listener: () => void): void {
    this.#emitter.on(event, listener)
  }

  /** All SSE frames written so far, parsed into event/data/comment triples. */
  frames(): SentFrame[] {
    const frames: SentFrame[] = []
    for (const block of this.body.split('\n\n')) {
      if (block.trim() === '') continue
      const frame: SentFrame = {}
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) frame.event = line.slice(7)
        else if (line.startsWith('data: ')) frame.data = line.slice(6)
        else if (line.startsWith(': ')) frame.comment = line.slice(2)
      }
      frames.push(frame)
    }
    return frames
  }

  /** Frames of one SSE event type; data parsed as JSON (frames without data are skipped). */
  events<T = unknown>(type: string): T[] {
    const seen: T[] = []
    for (const frame of this.frames()) {
      if (frame.event === type && frame.data !== undefined) seen.push(JSON.parse(frame.data) as T)
    }
    return seen
  }
}
