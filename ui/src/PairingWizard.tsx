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
import { STAGE_LABELS, TERMINAL_STAGES, VERIFICATION_CODE_STAGE } from './types'
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
  /** Called once a run reaches a terminal stage, so the app can reset the frame. */
  onSettled?(): void
}

export function PairingWizard({
  subscribed,
  progress,
  codeLifetimeMs = DEFAULT_CODE_LIFETIME_MS,
  onSettled,
}: PairingWizardProps): ReturnType<typeof Object> {
  const [payload, setPayload] = useState('')
  const [claimId, setClaimId] = useState<string | undefined>(undefined)
  const [phase, setPhase] = useState<PairingPhase>('idle')
  const [error, setError] = useState<string | undefined>(undefined)
  const [code, setCode] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const stage = progress?.stage

  useEffect(() => {
    // `progress` is reset by the app on `onSettled`, and a fresh run must never
    // inherit the previous run's frames.
    if (stage === undefined) {
      setCode(undefined)
      return
    }
    if (stage === VERIFICATION_CODE_STAGE) {
      setCode(progress?.detail)
      return
    }
    const terminal = (TERMINAL_STAGES as readonly string[]).includes(stage)
    if (terminal || stage === 'pairing-failed') {
      // Terminal frame: the code is a transient display and goes away with it.
      setCode(undefined)
      setPhase(terminal && stage === 'approved' ? 'done' : 'failed')
      setBusy(false)
      onSettled?.()
    }
  }, [stage, progress?.detail, onSettled])

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
      {phase === 'failed' && <p className="cherry-error">配对失败：{STAGE_LABELS[stage ?? ''] ?? stage}</p>}
      {error !== undefined && (
        <p className="cherry-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
