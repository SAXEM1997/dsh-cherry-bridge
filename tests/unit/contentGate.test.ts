import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContentGateTimeoutError, ContentReadGate } from '../../src/contentGate.js'

/**
 * Issue #39: the engine's process-wide gate over externalized-content assembly.
 *
 * The gate bounds a COUNT (refs assembled at once), so its whole correctness is
 * in the queue: FIFO order, a slot that transfers (never re-opens the fast
 * path), an idempotent release, and a deadline that is honoured while queued
 * and re-checked at admission. These are unit cases because the integration
 * surface can only show "two overlapping reads did not overlap"; ordering,
 * transfer and abandonment are decided here.
 */

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.useRealTimers()
})

describe('ContentReadGate: the count', () => {
  it('admits up to the limit without queueing, and reports the held count', async () => {
    const gate = new ContentReadGate(2)
    const first = await gate.acquire()
    expect(gate.active).toBe(1)
    const second = await gate.acquire()
    expect(gate.active).toBe(2)

    first()
    expect(gate.active).toBe(1)
    second()
    expect(gate.active).toBe(0)
  })

  it('clamps a nonsense limit to at least one slot', async () => {
    expect(new ContentReadGate(0).limit).toBe(1)
    expect(new ContentReadGate(-3).limit).toBe(1)
    expect(new ContentReadGate(2.7).limit).toBe(2)
  })

  it('releases IDEMPOTENTLY: a double release frees one slot, not two', async () => {
    const gate = new ContentReadGate(1)
    const release = await gate.acquire()
    release()
    release()
    expect(gate.active).toBe(0)

    // A second release that freed another slot would let two callers in.
    const a = await gate.acquire()
    let admitted = false
    void gate.acquire().then((r) => {
      admitted = true
      r()
    })
    await flush()
    expect(admitted).toBe(false)
    a()
    await flush()
    expect(admitted).toBe(true)
  })
})

describe('ContentReadGate: the queue', () => {
  it('admits waiters in ARRIVAL order', async () => {
    const gate = new ContentReadGate(1)
    const held = await gate.acquire()

    const order: string[] = []
    const waiting = ['a', 'b', 'c'].map((name) =>
      gate.acquire().then((release) => {
        order.push(name)
        return release
      }),
    )
    await flush()
    expect(order).toEqual([])

    held()
    for (let index = 0; index < 3; index += 1) {
      await flush()
      const release = await waiting[index]
      release()
    }
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('TRANSFERS the slot: no fresh caller can slip in while the queue is draining', async () => {
    const gate = new ContentReadGate(1)
    const held = await gate.acquire()

    let queuedAdmitted = false
    const queued = gate.acquire().then((release) => {
      queuedAdmitted = true
      return release
    })
    await flush()

    // Release, and in the SAME turn ask for a new slot. A gate that decremented
    // to zero before handing the slot on would admit this caller first.
    held()
    let freshAdmitted = false
    const fresh = gate.acquire().then((release) => {
      freshAdmitted = true
      return release
    })
    await flush()
    expect(queuedAdmitted).toBe(true)
    expect(freshAdmitted).toBe(false)
    ;(await queued)()
    await flush()
    expect(freshAdmitted).toBe(true)
    ;(await fresh)()
  })
})

describe('ContentReadGate: the deadline boundary', () => {
  it('refuses a caller whose budget is already spent, without taking a slot', async () => {
    const gate = new ContentReadGate(1)
    await expect(gate.acquire(performance.now() - 1)).rejects.toBeInstanceOf(ContentGateTimeoutError)
    expect(gate.active).toBe(0)
    // The free slot is still usable by the next caller.
    const release = await gate.acquire()
    release()
  })

  it('abandons a QUEUED waiter when its budget expires, and the slot goes to the next', async () => {
    const gate = new ContentReadGate(1)
    const held = await gate.acquire()

    const abandoned = gate.acquire(performance.now() + 40)
    const nextInLine = gate.acquire()
    const outcome = abandoned.catch((reason: unknown) => reason)

    const error = await outcome
    expect(error).toBeInstanceOf(ContentGateTimeoutError)
    expect((error as ContentGateTimeoutError).limit).toBe(1)
    // It left the queue: it cannot be admitted later by a slot nobody can use.
    held()
    const release = await nextInLine
    expect(gate.active).toBe(1)
    release()
    expect(gate.active).toBe(0)
  })

  it('passes on a slot that frees AFTER the budget expired, even before its timer runs (admission re-check)', async () => {
    // The window this exists for: a slot is handed over after the deadline but
    // before the queued waiter's own timer callback gets to run (the event loop
    // may delay it). The injected clock makes the ordering exact: release at
    // t=100 against a deadline of 60, with the 60 ms timer still pending.
    //
    // FAKE TIMERS so the real 60 ms timer cannot win a stalled event loop and
    // silently switch this test onto the abandonment path (same assertions,
    // different branch — false comfort). Nothing here advances timers: the
    // release is what must decide.
    vi.useFakeTimers()
    try {
      let now = 0
      const gate = new ContentReadGate(1, () => now)
      const held = await gate.acquire()

      const late = gate.acquire(60)
      const nextInLine = gate.acquire()
      const outcome = late.catch((reason: unknown) => reason)

      now = 100
      held()
      expect(await outcome).toBeInstanceOf(ContentGateTimeoutError)
      // The slot was handed ON, not spent: the next waiter is admitted.
      const release = await nextInLine
      expect(gate.active).toBe(1)
      release()
      expect(gate.active).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
