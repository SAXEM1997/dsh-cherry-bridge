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
import { ToolScopePanel } from './ToolScopePanel'
import { REQUEST_TIMEOUT, listDevices } from './api'
import { useT } from './i18n'
import type { T } from './i18n'
import { API_BASE } from './types'
import type {
  DeviceState,
  DeviceStateEvent,
  DeviceSummary,
  EventSourceFactory,
  PairingProgressEvent,
  ScopeClient,
} from './types'

export interface AppProps {
  /**
   * Opens the SSE stream. Defaults to the global `EventSource`; tests inject a
   * controllable fake, since jsdom ships none.
   */
  eventSourceFactory?: EventSourceFactory
  /** Transient verification-code lifetime, forwarded to the wizard. */
  codeLifetimeMs?: number
  /** Run deadline (the exit for a lost terminal frame), forwarded to the wizard. */
  runLifetimeMs?: number
  /**
   * The scope panel's HTTP seam. Defaults to the real same-origin client;
   * injected by tests in the same style as `eventSourceFactory`, so no test has
   * to stand up a fake registry server to render the page.
   */
  scopeClient?: ScopeClient
}

/** The production stream opener; the host page always has `EventSource`. */
const defaultEventSourceFactory: EventSourceFactory = (url) => {
  const source = (globalThis as { EventSource?: new (url: string) => unknown }).EventSource
  // Thrown for `apply()`'s error line to translate. The message is an INTERNAL
  // token, not copy: the component renders `t('app.eventSourceUnavailable')`
  // and never surfaces this string, so the two cannot drift apart.
  if (source === undefined) throw new Error(EVENT_SOURCE_UNAVAILABLE)
  return new source(url) as ReturnType<EventSourceFactory>
}

/**
 * The marker a missing `EventSource` throws with.
 *
 * A constant rather than a sentence, because the USER-VISIBLE wording is the
 * dictionary's (`app.eventSourceUnavailable`, zh and en) while this string only
 * travels from the opener to the catch block that recognizes it. Keeping them
 * separate is what makes the Chinese page finally able to say so in Chinese —
 * before this task the literal here rendered in English on a zh page.
 */
const EVENT_SOURCE_UNAVAILABLE = 'event-source-unavailable'

/**
 * One description for a cause, shared by the two catches below so they cannot
 * drift. Two markers get the dictionary's own sentence — the missing
 * `EventSource` and a request that never answered (`api.ts`'s ceiling) — because
 * both are INTERNAL tokens that must never render; everything else is the
 * foreign message, interpolated verbatim as data.
 */
function describeCause(t: T, cause: unknown): string {
  if (cause instanceof Error && cause.message === EVENT_SOURCE_UNAVAILABLE) return t('app.eventSourceUnavailable')
  if (cause instanceof Error && cause.message === REQUEST_TIMEOUT) return t('app.error.timeout')
  return cause instanceof Error ? cause.message : String(cause)
}

/** Parses one SSE frame payload, ignoring a malformed one rather than crashing. */
function parseFrame<T>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T
  } catch {
    return undefined
  }
}

export function App({
  eventSourceFactory = defaultEventSourceFactory,
  codeLifetimeMs,
  runLifetimeMs,
  scopeClient,
}: AppProps): ReturnType<typeof Object> {
  const t = useT()
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
      // The opener's own token means "no EventSource here", which has a
      // sentence of its own in both dictionaries; anything else is a foreign
      // message and is interpolated verbatim (data, not copy).
      setError(describeCause(t, cause))
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
        setError(describeCause(t, cause))
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
    // without a manual reload.
    //
    // The frame is deliberately NOT cleared here. Clearing it in the same
    // batched commit as the wizard's own terminal `setPhase` is what made every
    // failure verdict render as '未知错误': the wizard's settled paragraph read
    // the label off a frame that this very update had already removed. The
    // wizard now carries its own captured verdict, and the stale frame is
    // retired when the NEXT run starts (`startRun` below) — which is also what
    // the wizard's claim filter expects, since re-running resets `claimId`.
    refresh()
  }, [refresh])

  /** Retires the previous run's frame; a fresh run must never inherit it. */
  const startRun = useCallback(() => {
    setProgress(undefined)
  }, [])

  const sorted = useMemo(
    () => [...devices].sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [devices],
  )

  return (
    <div className="cherry-settings">
      <header className="cherry-header">
        <h2>{t('app.title')}</h2>
        <p className="cherry-hint">{t('app.subtitle')}</p>
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
        {...(runLifetimeMs === undefined ? {} : { runLifetimeMs })}
        onRunStart={startRun}
        onSettled={onSettled}
      />

      {/* Above the device list: the scope decides which workspaces the tools
          appear in, which is the setting an operator comes here to change. */}
      <ToolScopePanel {...(scopeClient === undefined ? {} : { client: scopeClient })} />

      <section className="cherry-panel" aria-labelledby="cherry-devices-title">
        <h3 id="cherry-devices-title">{t('app.devices.heading')}</h3>
        {/* Three states, not two: the list is EMPTY only once a read said so.
            After a failed read it is UNKNOWN, and claiming 「暂无已配对设备」 beside
            the error that says the read failed would contradict that error — so the
            error line speaks alone. */}
        {sorted.length === 0 && error === undefined && (
          <p className="cherry-hint">{listed ? t('app.devices.empty') : t('app.devices.loading')}</p>
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
