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
import { useEffect, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { REQUEST_TIMEOUT, patchDevice, removeDevice } from './api'
import { useT } from './i18n'
import { STATE_KEYS } from './types'
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

/** Splits the comma-separated host box into the whole-replace list the API wants. */
function parseHosts(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** The dial port for one host: its own stored port, else the record-level one. */
function dialPort(device: DeviceSummary, host: string): number {
  return device.ports?.[host] ?? device.port
}

/**
 * `host:port` as one readable address.
 *
 * An IPv6 literal contains colons, so `fe80::1:4343` reads as an ambiguous
 * host; stored hosts are bare (`normalizeHost` strips the brackets), so the
 * brackets are added here, for display only.
 */
function formatAddress(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

export function DeviceCard({ device, state, onSaved, onRemoved }: DeviceCardProps): ReturnType<typeof Object> {
  const t = useT()
  const [editor, setEditor] = useState<Editor>('none')
  const [name, setName] = useState(device.displayName)
  const [hostsText, setHostsText] = useState(device.hosts.join(', '))
  const [portText, setPortText] = useState(String(device.port))
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  /**
   * RESYNC FROM PROPS, but only while NO editor is open. Each editor holds a
   * local draft seeded from the record, and `device` can change underneath
   * it: a refresh (`GET /devices` after a pairing settles) replaces the
   * card's record, and another tab's PATCH arrives the same way. Without
   * this the box would keep showing a value the server no longer holds, and
   * saving that box would write the STALE value back — the exact failure
   * the "server's verdict is authoritative" rule elsewhere in this component
   * exists to prevent.
   *
   * While an editor IS open the draft is unconditionally sacred, focus
   * notwithstanding. The earlier guard also required focus to sit inside the
   * card, and the live host page proved that focus signal unreliable: a
   * focus artifact while the editor was open resynced the draft to the OLD
   * name mid-edit, so the save PATCHed the pre-edit name and the rename
   * "silently did nothing" (the input kept the typed text because React
   * never re-rendered after the wipe bailed out on an identical value).
   * Closing the editor is itself a dep change, so the drafts are always
   * reseeded fresh for the next open.
   *
   * Keyed on the fields themselves, not the object identity: `listDevices`
   * rebuilds every record on each refresh, so an identity check would resync
   * on every poll even when nothing changed.
   */
  useEffect(() => {
    if (editor !== 'none') return
    setName(device.displayName)
    setHostsText(device.hosts.join(', '))
    setPortText(String(device.port))
  }, [device.displayName, device.hosts, device.port, editor])

  /**
   * Runs one mutation, mapping a refusal into the card's error line.
   *
   * A request that never answered arrives as `api.ts`'s internal marker — the
   * page-wide ceiling (issue #180) — and a marker must never render. Every card
   * action is a bounded call (停用 / 重命名 / 移除 are PATCH or DELETE), so this
   * surface translates it like the other three do instead of echoing
   * `cherry-remote.request-timeout` onto the page.
   */
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === REQUEST_TIMEOUT
          ? t('device.error.timeout')
          : cause instanceof Error
            ? cause.message
            : String(cause),
      )
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
      setError(t('device.error.nameRequired'))
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
      setError(t('device.error.hostsRequired'))
      return
    }
    const port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setError(t('device.error.portInvalid'))
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

  // The record-level `port` alone would claim every host dials it, which is
  // false for a record whose map disagrees. `mixedPorts` decides whether the
  // card has anything to say beyond that single number; `addressList` is the
  // per-host truth (map value, record port as the fallback).
  const mixedPorts = device.hosts.some((host) => dialPort(device, host) !== device.port)
  const addressList = device.hosts.map((host) => formatAddress(host, dialPort(device, host))).join(', ')

  // `?? state` keeps an unknown future state transparent — the enum is the only
  // honest thing left to show for one this build has no copy for — while every
  // state it DOES know renders through the dictionary.
  const label = state === undefined ? t('device.state.unknown') : t(STATE_KEYS[state] ?? state)

  return (
    <li className="cherry-card" data-device-id={device.deviceId}>
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
            {device.enabled ? t('device.disable') : t('device.enable')}
          </button>
          <button type="button" onClick={() => setEditor(editor === 'rename' ? 'none' : 'rename')} disabled={busy}>
            {t('device.rename')}
          </button>
          <button type="button" onClick={() => setEditor(editor === 'address' ? 'none' : 'address')} disabled={busy}>
            {t('device.addresses')}
          </button>
          <button type="button" onClick={() => setEditor(editor === 'remove' ? 'none' : 'remove')} disabled={busy}>
            {t('device.remove')}
          </button>
        </div>
      </div>

      <dl className="cherry-card-facts">
        <dt>{t('device.field.addresses')}</dt>
        <dd>{device.hosts.join(', ')}</dd>
        <dt>{t('device.field.port')}</dt>
        <dd>{device.port}</dd>
        {mixedPorts && (
          <>
            <dt>{t('device.field.ports')}</dt>
            <dd className="cherry-mono">{addressList}</dd>
          </>
        )}
        <dt>{t('device.field.id')}</dt>
        <dd className="cherry-mono">{device.deviceId}</dd>
      </dl>

      {mixedPorts && <p className="cherry-hint">{t('device.ports.hint')}</p>}

      {editor === 'rename' && (
        <form className="cherry-inline-form" onSubmit={saveName}>
          <label htmlFor={`name-${device.deviceId}`}>{t('device.field.name')}</label>
          <input
            id={`name-${device.deviceId}`}
            value={name}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
          />
          <button type="submit" disabled={busy}>
            {t('device.save.name')}
          </button>
        </form>
      )}

      {editor === 'address' && (
        <form className="cherry-inline-form" onSubmit={saveAddress}>
          <label htmlFor={`hosts-${device.deviceId}`}>{t('device.field.hosts')}</label>
          <input
            id={`hosts-${device.deviceId}`}
            value={hostsText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setHostsText(event.target.value)}
          />
          <span className="cherry-hint">{t('device.hosts.hint')}</span>
          <span className="cherry-hint">
            {t('device.ports.current')} <span className="cherry-mono">{addressList}</span>
          </span>
          <label htmlFor={`port-${device.deviceId}`}>{t('device.field.port')}</label>
          <input
            id={`port-${device.deviceId}`}
            inputMode="numeric"
            value={portText}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setPortText(event.target.value)}
          />
          <span className="cherry-hint">{t('device.port.hint')}</span>
          <button type="submit" disabled={busy}>
            {t('device.save.addresses')}
          </button>
        </form>
      )}

      {editor === 'remove' && (
        <div className="cherry-inline-form">
          <p>{t('device.remove.warning')}</p>
          <button type="button" onClick={confirmRemove} disabled={busy}>
            {t('device.remove.confirm')}
          </button>
          <button type="button" onClick={() => setEditor('none')} disabled={busy}>
            {t('device.cancel')}
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
