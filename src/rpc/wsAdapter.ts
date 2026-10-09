import type { WebSocket } from 'ws'
import type { RemoteSocket } from '@cherrystudio/remote-transport'

type MessageListener = (event: { data: unknown }) => void
type StateListener = () => void
type SocketEvent = 'message' | 'close' | 'error'

/**
 * Wraps a `ws` library WebSocket in the `RemoteSocket` shape consumed by
 * `RemoteSocketStream` from `@cherrystudio/remote-transport`.
 */
export function toRemoteSocket(ws: WebSocket): RemoteSocket {
  const messageListeners = new Set<MessageListener>()
  const closeListeners = new Set<StateListener>()
  const errorListeners = new Set<StateListener>()

  // Establish the receive-side contract up front: with binaryType
  // 'arraybuffer', `ws` delivers binary frames as ArrayBuffer, which is the
  // only frame shape RemoteSocketStream.receive accepts.
  ws.binaryType = 'arraybuffer'

  ws.on('message', (data) => {
    for (const listener of [...messageListeners]) listener({ data })
  })
  ws.on('close', () => {
    for (const listener of [...closeListeners]) listener()
  })
  // Attached unconditionally so an unhandled 'error' never crashes the host
  // process; consumers observe failures through the 'error' event below.
  ws.on('error', () => {
    for (const listener of [...errorListeners]) listener()
  })

  return {
    // Deliberately a getter/setter pair, not a getter-only accessor:
    // RemoteSocketStream's constructor assigns `binaryType = 'arraybuffer'`
    // (socket.ts:32), which throws a TypeError against getter-only
    // accessors in ESM strict mode.
    get binaryType(): string {
      return ws.binaryType
    },
    set binaryType(type: string) {
      ws.binaryType = type as WebSocket['binaryType']
    },
    get bufferedAmount(): number {
      return ws.bufferedAmount
    },
    get readyState(): number {
      return ws.readyState
    },
    send(data: Uint8Array): void {
      ws.send(data)
    },
    close(code?: number, reason?: string): void {
      ws.close(code, reason)
    },
    addEventListener(type: SocketEvent, listener: MessageListener | StateListener): void {
      if (type === 'message') messageListeners.add(listener as MessageListener)
      else if (type === 'close') closeListeners.add(listener as StateListener)
      else errorListeners.add(listener as StateListener)
    },
    removeEventListener(type: SocketEvent, listener: MessageListener | StateListener): void {
      if (type === 'message') messageListeners.delete(listener as MessageListener)
      else if (type === 'close') closeListeners.delete(listener as StateListener)
      else errorListeners.delete(listener as StateListener)
    },
  }
}
