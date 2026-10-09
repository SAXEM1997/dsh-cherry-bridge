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
import { startPairing } from './api'
import { APPROVED_STAGE, STAGE_LABELS, TERMINAL_STAGES, VERIFICATION_CODE_STAGE } from './types'
import type { PairingPhase, PairingProgressEvent } from './types'

/** The countdown the transient code display gets, in seconds. */
export const DEFAULT_CODE_LIFETIME_MS = 120_000

export interface PairingWizardProps {
  /** True while a stream is open; submitting with no stream would lose the code. */
  subscribed: boolean
  /** The latest `pairing-progress` frame; `undefined` before the run starts. */
  progress: PairingProgressEvent | undefined
  /** How long the verification code stays on screen. Injectable for tests. */
  codeLifetimeMs?: number
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
  onRunStart,
  onSettled,
}: PairingWizardProps): ReturnType<typeof Object> {
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

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const trimmed = payload.trim()
    if (trimmed === '') {
      setError('请先粘贴配对 payload')
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
        setError(cause instanceof Error ? cause.message : String(cause))
        setPhase('idle')
        setBusy(false)
      },
    )
  }

  const running = phase === 'submitting' || phase === 'waiting'

  return (
    <section className="cherry-panel" aria-labelledby="cherry-pairing-title">
      <h3 id="cherry-pairing-title">配对向导</h3>
      <p className="cherry-hint">
        在 Cherry Studio 桌面端打开「远程连接 → 添加设备」，复制生成的配对信息，粘贴到下方。
      </p>

      <ol className="cherry-steps">
        <li>Cherry Studio 中生成配对信息（含地址、端口与一次性邀请）</li>
        <li>粘贴到下方输入框并开始配对</li>
        <li>对照 Cherry Studio 窗口上的 6 位验证码，确认后即完成</li>
      </ol>

      <form className="cherry-pair-form" onSubmit={submit}>
        <label htmlFor="cherry-payload">配对 payload</label>
        <textarea
          id="cherry-payload"
          value={payload}
          rows={3}
          placeholder="粘贴 Cherry Studio 生成的配对信息"
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setPayload(event.target.value)}
        />
        <button type="submit" disabled={busy || running || !subscribed}>
          开始配对
        </button>
      </form>

      {!subscribed && <p className="cherry-hint">正在建立事件流，稍候即可开始配对…</p>}

      {running && (
        <div className="cherry-progress" aria-live="polite">
          <p>配对进行中</p>
          {claimId !== undefined && <p className="cherry-hint cherry-mono">claim {claimId}</p>}
          <p>{stage === undefined ? '已提交配对请求…' : (STAGE_LABELS[stage] ?? stage)}</p>
        </div>
      )}

      {code !== undefined && (
        <div className="cherry-code" role="status">
          <p>请在 Cherry Studio 上核对验证码</p>
          <output className="cherry-code-digits">{code}</output>
        </div>
      )}

      {phase === 'done' && <p className="cherry-ok">配对成功</p>}
      {/* Labelled verdict, never a raw stage string: `STAGE_LABELS` carries copy
          for every terminal stage, and the fallback keeps an unknown future
          stage readable without leaking the enum into the UI. The label is read
          from the wizard's CAPTURED verdict, never from `progress` — the app
          clears the frame as the run settles, so the frame is already gone by
          the time this paragraph renders (see the `verdict` state above). */}
      {phase === 'failed' && (
        <p className="cherry-error" role="alert">
          配对失败：{STAGE_LABELS[verdict ?? ''] ?? '未知错误'}
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
