/**
 * The Cherry Bridge settings page: the pairing wizard plus one card per device.
 *
 * The app owns the two things that must outlive both children:
 *
 *  - **the event stream**, opened ONCE on mount and closed on unmount. The
 *    ordering is load-bearing: the stream carries no replay, and the
 *    verification code exists only as a frame, so the subscription must exist
 *    before the wizard can POST `/pair`. That is also why the submit button
 *    stays disabled until `subscribed` flips true.
 *  - **the device map**, seeded from `GET /devices` and then driven by
 *    `device-state` frames. The FIRST FRAME contract (one frame per device on
 *    connect) means a card never shows a state the server did not send; the REST
 *    list supplies the static fields (name, hosts, port) and the light stays
 *    blank until the stream speaks.
 *
 * There is no router: this is a single settings view.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DeviceCard } from './DeviceCard'
import { PairingWizard } from './PairingWizard'
import { listDevices } from './api'
import { API_BASE } from './types'
import type {
  DeviceState,
  DeviceStateEvent,
  DeviceSummary,
  EventSourceFactory,
  PairingProgressEvent,
} from './types'

export interface AppProps {
  /**
   * Opens the SSE stream. Defaults to the global `EventSource`; tests inject a
   * controllable fake, since jsdom ships none.
   */
  eventSourceFactory?: EventSourceFactory
  /** Transient verification-code lifetime, forwarded to the wizard. */
  codeLifetimeMs?: number
}

/** The production stream opener; the host page always has `EventSource`. */
const defaultEventSourceFactory: EventSourceFactory = (url) => {
  const source = (globalThis as { EventSource?: new (url: string) => unknown }).EventSource
  if (source === undefined) throw new Error('EventSource is unavailable in this environment')
  return new source(url) as ReturnType<EventSourceFactory>
}

/** Parses one SSE frame payload, ignoring a malformed one rather than crashing. */
function parseFrame<T>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T
  } catch {
    return undefined
  }
}

export function App({ eventSourceFactory = defaultEventSourceFactory, codeLifetimeMs }: AppProps): ReturnType<typeof Object> {
  const [devices, setDevices] = useState<DeviceSummary[]>([])
  const [states, setStates] = useState<Record<string, DeviceState>>({})
  const [progress, setProgress] = useState<PairingProgressEvent | undefined>(undefined)
  const [subscribed, setSubscribed] = useState(false)
  const [listed, setListed] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  // The stream is opened on mount and NEVER re-opened per pairing run: a new
  // connection would not replay the frames the previous one already saw.
  useEffect(() => {
    let source: ReturnType<EventSourceFactory>
    try {
      source = eventSourceFactory(`${API_BASE}/events`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    }

    const onDeviceState = (event: { data: string }): void => {
      const payload = parseFrame<DeviceStateEvent>(event.data)
      if (payload === undefined || typeof payload.deviceId !== 'string') return
      setStates((current) => ({ ...current, [payload.deviceId]: payload.state }))
    }
    const onPairingProgress = (event: { data: string }): void => {
      const payload = parseFrame<PairingProgressEvent>(event.data)
      if (payload === undefined || typeof payload.stage !== 'string') return
      setProgress(payload)
    }

    source.addEventListener('device-state', onDeviceState)
    source.addEventListener('pairing-progress', onPairingProgress)
    setSubscribed(true)

    return () => {
      setSubscribed(false)
      source.removeEventListener('device-state', onDeviceState)
      source.removeEventListener('pairing-progress', onPairingProgress)
      source.close()
    }
  }, [eventSourceFactory])

  const refresh = useCallback(() => {
    void listDevices().then(
      (list) => {
        setDevices(list)
        setListed(true)
        setError(undefined)
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setListed(true)
      },
    )
  }, [])

  useEffect(refresh, [refresh])

  const onSaved = useCallback((device: DeviceSummary) => {
    setDevices((current) => {
      const index = current.findIndex((entry) => entry.deviceId === device.deviceId)
      if (index === -1) return [...current, device]
      return current.map((entry) => (entry.deviceId === device.deviceId ? device : entry))
    })
    // The server's verdict is authoritative for the light too, until the next
    // `device-state` frame corrects it.
    setStates((current) => ({ ...current, [device.deviceId]: device.state }))
  }, [])

  const onRemoved = useCallback((deviceId: string) => {
    setDevices((current) => current.filter((entry) => entry.deviceId !== deviceId))
    setStates((current) => {
      const { [deviceId]: _removed, ...rest } = current
      return rest
    })
  }, [])

  const onSettled = useCallback(() => {
    // A terminal pairing stage changes the archive (approved) or ends the run;
    // either way the card list is re-read so a newly paired device appears
    // without a manual reload. The frame is cleared so a second run starts clean.
    setProgress(undefined)
    refresh()
  }, [refresh])

  const sorted = useMemo(
    () => [...devices].sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [devices],
  )

  return (
    <div className="cherry-settings">
      <header className="cherry-header">
        <h2>Cherry Studio 互联</h2>
        <p className="cherry-hint">
          通过远程传输把本机 DeepSeek Harness 连接到 Cherry Studio 桌面端；设备档案保存在插件数据目录，页面不接触任何凭据。
        </p>
      </header>

      {error !== undefined && (
        <p className="cherry-error" role="alert">
          {error}
        </p>
      )}

      <PairingWizard
        subscribed={subscribed}
        progress={progress}
        {...(codeLifetimeMs === undefined ? {} : { codeLifetimeMs })}
        onSettled={onSettled}
      />

      <section className="cherry-panel" aria-labelledby="cherry-devices-title">
        <h3 id="cherry-devices-title">已配对设备</h3>
        {sorted.length === 0 && (
          <p className="cherry-hint">{listed ? '暂无已配对设备，使用上方向导完成首次配对。' : '正在读取设备列表…'}</p>
        )}
        <ul className="cherry-cards">
          {sorted.map((device) => (
            <DeviceCard
              key={device.deviceId}
              device={device}
              // Undefined until the stream's first frame for this device: the
              // card then shows an honest "unknown" light instead of a state
              // the server never sent.
              state={states[device.deviceId]}
              onSaved={onSaved}
              onRemoved={onRemoved}
            />
          ))}
        </ul>
      </section>
    </div>
  )
}
