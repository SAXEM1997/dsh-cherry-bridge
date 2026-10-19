/**
 * One process-wide gate over externalized-content ASSEMBLY (issue #39).
 *
 * WHY THIS EXISTS. `MAX_EXTERNALIZED_BYTES` caps ONE `{ref}` at 32 MiB, and a
 * walk holds its content at roughly 3× its size while it assembles it (decoded
 * slices, their concatenation, the decoded string). That product is per ref, so
 * before this gate the process peak was `3 × 32 MiB × (refs being assembled at
 * once)` — and nothing in the engine bounded how many independent tool calls
 * could be assembling one. Four concurrent `cherry_read`s over fat sessions
 * could put ~384 MiB of transient buffers in flight with no number anywhere
 * saying so.
 *
 * The gate makes that number explicit: at most `limit` refs are being assembled
 * at any instant, so the peak is `limit × 3 × 32 MiB` worst case (4 → 384 MiB),
 * and in ordinary traffic `limit × 3 × (declared size)` — usually a few MiB.
 * It bounds the COUNT, not the bytes: a byte budget would be tighter, but it
 * would have to reserve each ref's DECLARED size (optimistic: a peer may serve
 * more) or its cap when the size is unusable (serializing everything behind one
 * slot). The count is what the official client gates on
 * (`REMOTE_READ_CACHE_POLICY.concurrency = 4`), and it is honest about what it
 * does not bound.
 *
 * FIFO: a waiter is admitted in arrival order, so a long walk cannot starve the
 * calls behind it beyond one slot's work. The slot is handed DIRECTLY from the
 * releasing holder to the next waiter (`#active` does not move), so a fresh
 * caller cannot slip in through the fast path between the two.
 *
 * THE DEADLINE BOUNDARY — chosen explicitly, not half-done (the #21 lesson):
 *
 *  - **While QUEUED the caller's budget is honoured**: a wait that has not been
 *    admitted by its instant gives up (`ContentGateTimeoutError`) and is removed
 *    from the queue, so it neither starts a walk it could not finish nor gets
 *    admitted later by a slot nobody can use.
 *  - **After admission the deadline is RE-CHECKED** before the slot is handed
 *    over: a slot that arrives too late is passed on, never spent.
 *  - **Once the walk is RUNNING it is never interrupted here.** Its per-slice
 *    requests are clamped by the transport to the same deadline (issue #21), so
 *    a running walk stops at its next request — the interruption lives where
 *    the I/O is, not here. Doing both would leave "cancelled but still reading"
 *    as a state nobody can reason about.
 */
export class ContentGateTimeoutError extends Error {
  /** The gate's concurrency limit, for the caller's own report. */
  readonly limit: number

  constructor(limit: number) {
    super(
      `content-read gate (limit ${String(limit)}): the answer's time budget ran out while waiting for a slot; ` +
        'the externalized content was not read',
    )
    this.name = 'ContentGateTimeoutError'
    this.limit = limit
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class ContentReadGate {
  /** Maximum refs assembled at once (always ≥ 1). */
  readonly limit: number
  /** Slots currently held. Exposed for assertions and future diagnostics. */
  #active = 0
  /** Admitted-in-arrival-order waiters; each entry keeps its slot on resolve. */
  readonly #queue: Array<() => void> = []
  /**
   * The clock, injectable so the admission re-check's race window — a slot that
   * frees AFTER the deadline but BEFORE the queued waiter's timer runs — can be
   * driven deterministically in a unit test. Production never passes one.
   */
  readonly #now: () => number

  constructor(limit: number, now: () => number = () => performance.now()) {
    this.limit = Math.max(1, Math.floor(limit))
    this.#now = now
  }

  /** Slots currently held, for tests and diagnostics. */
  get active(): number {
    return this.#active
  }

  /**
   * Takes one slot and resolves with its release. The release is IDEMPOTENT: a
   * caller that releases twice (a `finally` plus a defensive path) must not free
   * two slots.
   *
   * `deadline` is an absolute instant on `performance.now()`'s clock, or
   * undefined for "wait as long as it takes" (`cherry_read` and the list tools
   * have no budget of their own; their caller's own timeout applies).
   */
  async acquire(deadline?: number): Promise<() => void> {
    if (deadline !== undefined && this.#now() >= deadline) throw new ContentGateTimeoutError(this.limit)
    if (this.#active < this.limit) {
      this.#active += 1
      return this.#releaseOnce()
    }
    return await new Promise<() => void>((resolve, reject) => {
      let settled = false
      const grant = (): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        // RE-CHECKED at admission: this slot may have freed after the caller's
        // instant, in which case it belongs to the next waiter, not to a walk
        // whose first request the transport would refuse.
        if (deadline !== undefined && this.#now() >= deadline) {
          this.#handOff()
          reject(new ContentGateTimeoutError(this.limit))
          return
        }
        resolve(this.#releaseOnce())
      }
      const timer =
        deadline === undefined
          ? undefined
          : setTimeout(
              () => {
                if (settled) return
                settled = true
                const index = this.#queue.indexOf(grant)
                if (index >= 0) this.#queue.splice(index, 1)
                reject(new ContentGateTimeoutError(this.limit))
              },
              Math.max(1, deadline - this.#now()),
            )
      this.#queue.push(grant)
    })
  }

  /** The idempotent release handed to one admitted caller. */
  #releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.#handOff()
    }
  }

  /**
   * Passes this slot to the next waiter, or frees it when the queue is empty.
   * `#active` moves ONLY in the second case: a transfer is not a release plus an
   * admission, so nothing can be admitted through the fast path in between.
   */
  #handOff(): void {
    const next = this.#queue.shift()
    if (next === undefined) {
      this.#active -= 1
      return
    }
    next()
  }
}
