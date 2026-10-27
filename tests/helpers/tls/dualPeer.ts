import { readFileSync } from 'node:fs'
import net, { type AddressInfo } from 'node:net'
import { createServer, type TLSSocket } from 'node:tls'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FakeCherry } from '../../loopback/fakeCherry.js'

/**
 * The real `FakeCherry` desktop, with a `wss://` TLS door in front of it.
 *
 * `FakeCherry` is this repo's record of what the desktop does and the only peer
 * this suite trusts — but it speaks plain `ws`, while the behaviour under test
 * in issue #126 IS the choice between `ws:` and `wss:`. A plain fake cannot
 * observe that choice: a TLS handshake sent to a plain listener fails whatever
 * scheme the client thought it used, so "it failed" says nothing about which
 * URL was built. This helper adds a TLS front, never a second peer:
 *
 *  - {@link DualPeer.tlsPort} runs a real TLS server (the self-signed fixture
 *    beside this file, valid for 127.0.0.1 and ::1). A completed handshake on
 *    a port that speaks NOTHING but TLS is the proof that the client built a
 *    `wss://` URL — a `ws://` client's cleartext bytes cannot complete one.
 *  - Every connection that completes TLS is piped — as a raw byte stream, the
 *    way a TLS-terminating proxy works — into the real `FakeCherry`, so a
 *    genuine `wss` dial still pairs, authenticates and proves the desktop's
 *    pinned identity through the Noise XX handshake, against the same desktop
 *    a `ws` dial would reach ({@link DualPeer.desktopConnections}).
 */
export interface DualPeerOptions {
  /** Interface to bind (default 127.0.0.1). Use '::1' for IPv6. */
  bindHost?: string
  /** Forwarded to the `FakeCherry` the front stands in front of. */
  desktop?: ConstructorParameters<typeof FakeCherry>[0]
}

export interface DualPeer {
  /** The TLS front's `wss` port. */
  tlsPort: number
  desktop: FakeCherry
  desktopIdentity: string
  /** TLS handshakes completed (a `wss://` dial got as far as TLS). */
  tlsHandshakes(): number
  /** Noise handshakes the desktop completed (a `wss` dial reached the peer). */
  desktopConnections(): number
  stop(): Promise<void>
}

const FIXTURES = dirname(fileURLToPath(import.meta.url))
const TLS_OPTIONS = {
  cert: readFileSync(join(FIXTURES, 'cert.pem')),
  key: readFileSync(join(FIXTURES, 'key.pem')),
}

/**
 * The websocket options a client needs to reach {@link makeDualPeer}: FLAT
 * `tls.connect` options, which is the shape `ws` forwards to its TLS socket
 * (a `tls: {...}` wrapper is `https`' shape and is ignored here).
 */
export const insecureTlsOptions = { rejectUnauthorized: false }

export async function makeDualPeer(options: DualPeerOptions = {}): Promise<DualPeer> {
  const bindHost = options.bindHost ?? '127.0.0.1'
  const desktop = new FakeCherry({ ...options.desktop, bindHost })
  const { port: desktopPort } = await desktop.start()
  const desktopIdentity = await desktop.identityId

  let handshakes = 0
  // The CONNECTION listener (every accepted socket, whatever the TLS outcome)
  // gated on `secureConnect`, so only a completed TLS handshake is spliced into
  // the desktop. A cleartext `ws:` client therefore gets NOTHING — no upgrade,
  // no desktop connection — which is exactly the verdict #126 must observe.
  const front = createServer(TLS_OPTIONS, (upstream: TLSSocket) => {
    handshakes += 1
    spliceIntoDesktop(upstream, desktopPort)
  })
  await new Promise<void>((resolve) => front.listen(0, bindHost, resolve))
  const tlsPort = (front.address() as AddressInfo).port

  return {
    tlsPort,
    desktop,
    desktopIdentity,
    tlsHandshakes: () => handshakes,
    desktopConnections: () => desktop.connectionCount,
    async stop() {
      await new Promise<void>((resolve) => front.close(() => resolve()))
      await desktop.stop()
    },
  }
}

/**
 * Pipe the TLS client's DECRYPTED bytes into the desktop over a plain TCP
 * connection, and the desktop's bytes back.
 *
 * A raw byte pipe is exactly what a TLS-terminating PROXY does — a real
 * deployment puts one in front of a desktop that still speaks plain `ws` — so
 * the desktop sees its ordinary `ws` protocol and proves its pinned identity
 * through the ordinary Noise handshake.
 */
function spliceIntoDesktop(upstream: TLSSocket, desktopPort: number): void {
  const backend = net.connect(desktopPort, '127.0.0.1', () => {
    upstream.on('data', (chunk: Buffer) => backend.write(chunk))
    backend.on('data', (chunk: Buffer) => upstream.write(chunk))
  })
  const close = (): void => {
    upstream.destroy()
    backend.destroy()
  }
  for (const side of [upstream, backend]) {
    side.on('close', close)
    side.on('error', close)
  }
}
