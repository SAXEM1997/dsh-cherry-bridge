/**
 * The pairing wizard: paste an invitation payload, watch the run, compare the
 * 6-digit code, done.
 *
 * Two contract details drive this component's shape:
 *
 *  - **`POST /pair` returns immediately** (202 + `{claimId}`). The wizard never
 *    waits for approval over HTTP; it moves to "配对进行中" as soon as the claim
 *    exists. That is what keeps a browser fetch from sitting open for the whole
 *    120s invitation window.
 *  - **The 6-digit code arrives ONLY as a `pairing-progress` frame** with
 *    `stage: 'verification-code'`. There is no replay: the stream the app opened
 *    on mount is the only chance to see it. The code is rendered transiently —
 *    cleared by a terminal stage or by its own countdown — because a code left
 *    on screen invites comparing a stale number.
 */
import { useEffect, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { REQUEST_TIMEOUT, startPairing } from './api'
import { useT } from './i18n'
import { APPROVED_STAGE, STAGE_KEYS, TERMINAL_STAGES, VERIFICATION_CODE_STAGE } from './types'
import type { PairingPhase, PairingProgressEvent } from './types'

/** The countdown the transient code display gets, in seconds. */
export const DEFAULT_CODE_LIFETIME_MS = 120_000

/**
 * How long one run may sit in `waiting` before the wizard gives the form back.
 *
 * The server publishes a terminal stage on EVERY outcome (`src/httpApi.ts`
 * `startPairing`), but the event stream carries no replay, so a single dropped
 * frame loses the verdict for good — and nothing else clears `busy`: only a
 * terminal frame or a refused POST does, and there is no cancel control. Without
 * this bound a lost frame parks the wizard on 「配对进行中」 until a page reload.
 *
 * The bound must be comfortably past a REALISTIC live run: `src/pairing.ts`
 * bounds the candidate walk to 30 s (`dialBudgetMs`) and the claim/poll phase to
 * a FRESH 120 s anchored at the claim, so 150 s plus 30 s of margin.
 *
 * It is NOT past a pathological one, and it says so rather than pretending: two
 * round trips inside that walk (`hello`, then the claim) are bounded only by
 * JsonRpcClient's 60 s default request timeout, so a peer that stalls each just
 * under it can keep a run legitimately working for ~270 s. A premature alarm is
 * acceptable because it is not a verdict — it points at the device list, and a
 * terminal frame arriving later replaces it (see `claimId` below).
 */
export const DEFAULT_RUN_LIFETIME_MS = 180_000

export interface PairingWizardProps {
  /** True while a stream is open; submitting with no stream would lose the code. */
  subscribed: boolean
  /** The latest `pairing-progress` frame; `undefined` before the run starts. */
  progress: PairingProgressEvent | undefined
  /** How long the verification code stays on screen. Injectable for tests. */
  codeLifetimeMs?: number
  /** How long a run may wait for its terminal frame. Injectable for tests. */
  runLifetimeMs?: number
  /**
   * Called when a NEW run is submitted, before `POST /pair`: the app retires the
   * previous run's frame here, so the settled render never has to compete with a
   * frame being cleared underneath it (see the `verdict` state).
   */
  onRunStart?(): void
  /** Called once a run reaches a terminal stage, so the app can reset the frame. */
  onSettled?(): void
}

export function PairingWizard({
  subscribed,
  progress,
  codeLifetimeMs = DEFAULT_CODE_LIFETIME_MS,
  runLifetimeMs = DEFAULT_RUN_LIFETIME_MS,
  onRunStart,
  onSettled,
}: PairingWizardProps): ReturnType<typeof Object> {
  const t = useT()
  const [payload, setPayload] = useState('')
  const [claimId, setClaimId] = useState<string | undefined>(undefined)
  const [phase, setPhase] = useState<PairingPhase>('idle')
  const [error, setError] = useState<string | undefined>(undefined)
  const [code, setCode] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // The terminal stage of the LAST settled run, captured in the wizard's OWN
  // state before `onSettled` runs. This is deliberately not a read of
  // `progress`: the app clears the frame when a run ends
  // (`onSettled` → `setProgress(undefined)`), and React 18 batches that with
  // this effect's own `setPhase('failed')` into a SINGLE commit — so the first
  // `phase === 'failed'` render already sees `progress === undefined`. Labelling
  // the verdict from `progress` therefore falls through to the '未知错误'
  // fallback on every failure, permanently, and all five recovery labels are
  // unreachable. The verdict must be an INPUT to the settled render rather than
  // derived from a frame that is being cleared underneath it.
  const [verdict, setVerdict] = useState<string | undefined>(undefined)
  // Set ONLY by the run deadline: `phase === 'failed'` with no stage behind it.
  // Its own flag rather than an empty verdict, because the settled paragraph must
  // NOT read as a verdict — the run may have been approved while its frame was
  // lost, and the device list right below would contradict a "配对失败".
  const [timedOut, setTimedOut] = useState(false)

  const stage = progress?.stage
  const frameClaimId = progress?.claimId

  useEffect(() => {
    // `progress` is reset when the next run STARTS, and a fresh run must never
    // inherit the previous run's frames.
    if (stage === undefined) {
      setCode(undefined)
      return
    }
    // CLAIM SCOPING. The SSE stream is SHARED by every tab and every pairing
    // run, so a frame belongs to this wizard only when its `claimId` is the one
    // POST /pair returned to THIS wizard. Two tabs pairing two desktops at once
    // is the ordinary case: without this filter the second tab would display
    // the first tab's 6-digit code and settle on the first tab's verdict.
    //
    // A frame with NO claimId is one this add-on cannot prove is ours (a
    // producer outside the pairing route), so it is ignored rather than
    // trusted — the wizard only ever acts on frames it can attribute.
    if (claimId === undefined || frameClaimId !== claimId) return
    if (stage === VERIFICATION_CODE_STAGE) {
      setCode(progress?.detail)
      return
    }
    // Terminal frame: the code is a transient display and goes away with it.
    if ((TERMINAL_STAGES as readonly string[]).includes(stage)) {
      setCode(undefined)
      // A LATE frame outranks the deadline: `POST /pair` is fire-and-forget, so a
      // frame can still arrive after the run deadline and the stage it carries is
      // the truth — retiring the flag here is what lets that copy win the render.
      setTimedOut(false)
      // Capture FIRST: `onSettled` is the app's chance to clear the frame, and
      // everything below must already be independent of it.
      setVerdict(stage)
      setPhase(stage === APPROVED_STAGE ? 'done' : 'failed')
      setBusy(false)
      onSettled?.()
    }
  }, [stage, frameClaimId, progress?.detail, claimId, onSettled])

  useEffect(() => {
    if (code === undefined) return undefined
    // The countdown is a backstop: a run that never reaches a terminal stage
    // (a closed tab on the peer, a dropped stream) must not leave the code up.
    const timer = setTimeout(() => setCode(undefined), codeLifetimeMs)
    return () => clearTimeout(timer)
  }, [code, codeLifetimeMs])

  useEffect(() => {
    if (phase !== 'waiting') return undefined
    // The countdown above bounds the CODE DISPLAY; this bounds the RUN. Same
    // failure mode, different casualty: the code goes away on time, but `busy`
    // would stay true forever and leave the submit button disabled with no
    // cancel control. Everything the terminal branch does to the form is done
    // here too, minus the verdict — and `claimId` is deliberately KEPT, so a
    // terminal frame that arrives after the deadline still replaces this message
    // with the truth instead of being filtered out as a stranger's.
    const timer = setTimeout(() => {
      setCode(undefined)
      setTimedOut(true)
      setPhase('failed')
      setBusy(false)
      // The same callback a terminal frame runs: it re-reads the device list,
      // which is what makes "look below" honest — an approved pairing whose
      // frame was lost shows up there.
      onSettled?.()
    }, runLifetimeMs)
    return () => clearTimeout(timer)
  }, [phase, runLifetimeMs, onSettled])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const trimmed = payload.trim()
    if (trimmed === '') {
      setError(t('wizard.error.payloadRequired'))
      return
    }
    setBusy(true)
    setError(undefined)
    setPhase('submitting')
    setClaimId(undefined)
    // A NEW run starts here, so the previous run's verdict is retired now — not
    // when the frame arrives. Clearing it at start (rather than relying on the
    // frame going away) keeps the settled paragraph correct for exactly one run.
    setVerdict(undefined)
    setTimedOut(false)
    // ...and the APP retires the previous run's frame here rather than on settle,
    // so a batched terminal commit cannot take the label away with it.
    onRunStart?.()
    void startPairing(trimmed).then(
      (result) => {
        setClaimId(result.claimId)
        setPhase('waiting')
      },
      (cause: unknown) => {
        // A refusal leaves the wizard open with the payload intact: the user
        // fixes the paste rather than starting over.
        //
        // A HUNG request is not a refusal the user can read: its marker is an
        // internal token, so it becomes the dictionary's own sentence (the same
        // split as `app.eventSourceUnavailable`). Everything else is the
        // server's or the transport's message, interpolated verbatim. The
        // ceiling lives in `api.ts` `request()`, so the token is shared with the
        // other surfaces; only this catch can see it for the pairing POST.
        setError(
          cause instanceof Error && cause.message === REQUEST_TIMEOUT
            ? t('wizard.error.timeout')
            : cause instanceof Error
              ? cause.message
              : String(cause),
        )
        setPhase('idle')
        setBusy(false)
      },
    )
  }

  const running = phase === 'submitting' || phase === 'waiting'

  return (
    <section className="cherry-panel" aria-labelledby="cherry-pairing-title">
      <h3 id="cherry-pairing-title">{t('wizard.heading')}</h3>
      {/* The ruled seam: `before` ends bare, ONE literal JSX space supplies the
          gap, the emphasized words come from their own key, and `after` opens
          flush with its own punctuation. Both locales' values are shaped for
          exactly this. */}
      <p className="cherry-hint">
        {t('wizard.hint.before')} <strong>{t('wizard.hint.qrCode')}</strong>
        {t('wizard.hint.after')}
      </p>

      <ol className="cherry-steps">
        <li>{t('wizard.step.open')}</li>
        <li>{t('wizard.step.scan')}</li>
        <li>{t('wizard.step.paste')}</li>
      </ol>

      <form className="cherry-pair-form" onSubmit={submit}>
        <label htmlFor="cherry-payload">{t('wizard.payload.label')}</label>
        <textarea
          id="cherry-payload"
          value={payload}
          rows={3}
          placeholder={t('wizard.payload.placeholder')}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setPayload(event.target.value)}
        />
        <button type="submit" disabled={busy || running || !subscribed}>
          {t('wizard.submit')}
        </button>
      </form>

      {!subscribed && <p className="cherry-hint">{t('wizard.streamPending')}</p>}

      {running && (
        <div className="cherry-progress" aria-live="polite">
          <p>{t('wizard.running')}</p>
          {claimId !== undefined && <p className="cherry-hint cherry-mono">claim {claimId}</p>}
          <p>{stage === undefined ? t('wizard.submitted') : t(STAGE_KEYS[stage] ?? stage)}</p>
        </div>
      )}

      {code !== undefined && (
        <div className="cherry-code" role="status">
          <p>{t('wizard.code.check')}</p>
          <output className="cherry-code-digits">{code}</output>
        </div>
      )}

      {phase === 'done' && <p className="cherry-ok">{t('wizard.succeeded')}</p>}
      {/* Labelled verdict, never a raw stage string: the dictionary carries copy
          for every terminal stage, and `wizard.unknownError` keeps an unknown
          future stage readable WITHOUT leaking the enum into the UI — which is
          exactly why the fallback is a key here rather than the `?? stage`
          passthrough the in-flight line above uses. The label is read from the
          wizard's CAPTURED verdict, never from `progress` — the app clears the
          frame as the run settles, so the frame is already gone by the time this
          paragraph renders (see the `verdict` state above). */}
      {phase === 'failed' && (
        <p className="cherry-error" role="alert">
          {timedOut
            ? t('wizard.timedOut')
            : t('wizard.failed', {
                stage:
                  STAGE_KEYS[verdict ?? ''] === undefined
                    ? t('wizard.unknownError')
                    : t(STAGE_KEYS[verdict ?? '']!),
              })}
        </p>
      )}
      {error !== undefined && (
        <p className="cherry-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
