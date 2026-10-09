/**
 * The device card: one status light plus the four maintenance actions.
 *
 * The light is the card's whole story — five states, each with a distinct
 * colour and a distinct accessible name, because colour alone is not a status.
 * The three inline editors (rename, address, remove confirmation) are mutually
 * exclusive: two open forms on one card would make "save" ambiguous.
 *
 * Every mutation reports the server's authoritative record back through
 * `onSaved`, so the card shows what the archive holds rather than what the
 * browser hoped for. The live `state` keeps coming from SSE; the patch response
 * only seeds it.
 */
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, RefObject } from 'react'
import { patchDevice, removeDevice } from './api'
import { STATE_LABELS } from './types'
import type { DeviceState, DeviceSummary } from './types'

/** The mutually exclusive editors a card can have open. */
type Editor = 'none' | 'rename' | 'address' | 'remove'

export interface DeviceCardProps {
  device: DeviceSummary
  /**
   * The live state, sourced from the SSE stream. `undefined` means the stream
   * has not reported this device yet — the light then shows `unknown` rather
   * than borrowing the REST projection, so the card never claims a state the
   * stream did not send.
   */
  state: DeviceState | undefined
  onSaved(device: DeviceSummary): void
  onRemoved(deviceId: string): void
}

/**
 * Whether focus currently sits INSIDE this card's editors.
 *
 * Read from the document rather than tracked with local state: focus moves
 * between the card's own inputs (name → hosts → port) and out to another card
 * or a button, and a per-input handler would have to coordinate all of those.
 * `document.activeElement` is the single source of truth, and it is only
 * consulted when the effect runs (a prop change), never during a render.
 */
function useIsFocusedWithin(root: RefObject<HTMLLIElement | null>): boolean {
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    const check = (): void => {
      const node = root.current
      const active = node?.ownerDocument.activeElement ?? null
      setFocused(node !== null && node !== undefined && active !== null && node.contains(active))
    }
    // The listeners live on the card's OWN document, so a card rendered in a
    // test's jsdom and a card in the host page both observe real focus moves.
    const owner = root.current?.ownerDocument ?? globalThis.document
    owner.addEventListener('focusin', check)
    owner.addEventListener('focusout', check)
    return () => {
      owner.removeEventListener('focusin', check)
      owner.removeEventListener('focusout', check)
    }
  }, [root])

  return focused
}

/** Splits the comma-separated host box into the whole-replace list the API wants. */
function parseHosts(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

export function DeviceCard({ device, state, onSaved, onRemoved }: DeviceCardProps): ReturnType<typeof Object> {
  const root = useRef<HTMLLIElement | null>(null)
  const [editor, setEditor] = useState<Editor>('none')
  const [name, setName] = useState(device.displayName)
  const [hostsText, setHostsText] = useState(device.hosts.join(', '))
  const [portText, setPortText] = useState(String(device.port))
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  /**
   * RESYNC FROM PROPS. Each editor holds a local draft seeded from the record,
   * and `device` can change underneath it: a refresh (`GET /devices` after a
   * pairing settles) replaces the card's record, and another tab's PATCH arrives
   * the same way. Without this the box would keep showing a value the server no
   * longer holds, and saving that box would write the STALE value back — the
   * exact failure the "server's verdict is authoritative" rule elsewhere in
   * this component exists to prevent.
   *
   * Skipped while an editor is OPEN and focus sits inside the card, because there the
   * user's in-progress typing outranks the server: overwriting a half-typed
   * address from a background refresh would lose their edit. Closing the editor
   * clears the guard, and the next prop change resyncs.
   *
   * Keyed on the fields themselves, not the object identity: `listDevices`
   * rebuilds every record on each refresh, so an identity check would resync on
   * every poll even when nothing changed.
   */
  const focused = useIsFocusedWithin(root)
  useEffect(() => {
    if (editor !== 'none' && focused) return
    setName(device.displayName)
    setHostsText(device.hosts.join(', '))
    setPortText(String(device.port))
  }, [device.displayName, device.hosts, device.port, editor, focused])

  /** Runs one mutation, mapping a refusal into the card's error line. */
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = (): void => {
    const enabled = !device.enabled
    void run(async () => {
      onSaved(await patchDevice(device.deviceId, { enabled }))
    })
  }

  const saveName = (event: FormEvent): void => {
    event.preventDefault()
    const displayName = name.trim()
    if (displayName === '') {
      setError('设备名称不能为空')
      return
    }
    void run(async () => {
      onSaved(await patchDevice(device.deviceId, { displayName }))
      setEditor('none')
    })
  }

  const saveAddress = (event: FormEvent): void => {
    event.preventDefault()
    const hosts = parseHosts(hostsText)
    if (hosts.length === 0) {
      setError('至少需要一个主机地址')
      return
    }
    const port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setError('端口必须是 1..65535 之间的整数')
      return
    }
    void run(async () => {
      // hosts is WHOLE-REPLACE: send the list, never a diff.
      onSaved(await patchDevice(device.deviceId, { hosts, port }))
      setEditor('none')
    })
  }

  const confirmRemove = (): void => {
    void run(async () => {
      await removeDevice(device.deviceId)
      onRemoved(device.deviceId)
    })
  }

  const label = state === undefined ? '状态未知' : STATE_LABELS[state]

  return (
    <li className="cherry-card" data-device-id={device.deviceId} ref={root}>
      <div className="cherry-card-head">
        {state === undefined ? (
          <span className="cherry-state" data-state="unknown" title={label}>
            <span className="cherry-state-dot" />
          </span>
        ) : (
          <span className="cherry-state" role="img" aria-label={label} data-state={state} title={label}>
            <span className="cherry-state-dot" />
          </span>
        )}
        <div className="cherry-card-title">
          <strong>{device.displayName}</strong>
          <span className="cherry-state-label">{label}</span>
        </div>
        <div className="cherry-card-actions">
          <button type="button" onClick={toggleEnabled} disabled={busy}>
            {device.enabled ? '停用' : '启用'}
          </button>
          <button type="button" onClick={() => setEditor(editor === 'rename' ? 'none' : 'rename')} disabled={busy}>
            重命名
          </button>
          <button type="button" onClick={() => setEditor(editor === 'address' ? 'none' : 'address')} disabled={busy}>
            地址维护
          </button>
          <button type="button" onClick={() => setEditor(editor === 'remove' ? 'none' : 'remove')} disabled={busy}>
            移除
          </button>
        </div>
      </div>

      <dl className="cherry-card-facts">
        <dt>地址</dt>
        <dd>{device.hosts.join(', ')}</dd>
        <dt>端口</dt>
        <dd>{device.port}</dd>
        <dt>设备 ID</dt>
        <dd className="cherry-mono">{device.deviceId}</dd>
      </dl>

      {editor === 'rename' && (
        <form className="cherry-inline-form" onSubmit={saveName}>
          <label htmlFor={`name-${device.deviceId}`}>设备名称</label>
          <input
            id={`name-${device.deviceId}`}
            value={name}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
          />
          <button type="submit" disabled={busy}>
            保存名称
          </button>
        </form>
      )}

      {editor === 'address' && (
        <form className="cherry-inline-form" onSubmit={saveAddress}>
          <label htmlFor={`hosts-${device.deviceId}`}>主机地址</label>
          <input
            id={`hosts-${device.deviceId}`}
            value={hostsText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setHostsText(event.target.value)}
          />
          <span className="cherry-hint">多个候选地址用逗号分隔（整体替换）</span>
          <label htmlFor={`port-${device.deviceId}`}>端口</label>
          <input
            id={`port-${device.deviceId}`}
            inputMode="numeric"
            value={portText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setPortText(event.target.value)}
          />
          <button type="submit" disabled={busy}>
            保存地址
          </button>
        </form>
      )}

      {editor === 'remove' && (
        <div className="cherry-inline-form">
          <p>移除后本机将不再连接该设备，凭据保留在对方一侧。</p>
          <button type="button" onClick={confirmRemove} disabled={busy}>
            确认移除
          </button>
          <button type="button" onClick={() => setEditor('none')} disabled={busy}>
            取消
          </button>
        </div>
      )}

      {error !== undefined && (
        <p className="cherry-error" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}
