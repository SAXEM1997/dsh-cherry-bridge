import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { RemoteSocket } from '@cherrystudio/remote-transport'
import { toRemoteSocket } from '../../src/rpc/wsAdapter.js'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!()
})

function disposeSocket(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    socket.once('close', () => resolve())
    socket.close()
  })
}

function startLoopback(): { url: string; peer: Promise<WebSocket> } {
  const server = new WebSocketServer({ port: 0 })
  disposers.push(async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const peer = new Promise<WebSocket>((resolve) => {
    server.once('connection', (socket) => resolve(socket))
  })
  const { port } = server.address() as AddressInfo
  return { url: `ws://127.0.0.1:${port}`, peer }
}

function connect(url: string): { client: WebSocket; remote: RemoteSocket; opened: Promise<void> } {
  const client = new WebSocket(url)
  disposers.push(() => disposeSocket(client))
  const remote = toRemoteSocket(client)
  const opened = new Promise<void>((resolve) => {
    client.once('open', () => resolve())
  })
  return { client, remote, opened }
}

async function openPair(): Promise<{ client: WebSocket; remote: RemoteSocket; peer: WebSocket }> {
  const loop = startLoopback()
  const { client, remote, opened } = connect(loop.url)
  const peer = await loop.peer
  await opened
  return { client, remote, peer }
}

describe('toRemoteSocket', () => {
  it('exposes binaryType as a writable property initialized to arraybuffer', async () => {
    const { remote, opened } = connect(startLoopback().url)
    // RemoteSocketStream's constructor assigns `socket.binaryType = 'arraybuffer'`;
    // a getter-only accessor would throw a TypeError here under ESM strict mode.
    expect(remote.binaryType).toBe('arraybuffer')
    expect(() => {
      remote.binaryType = 'arraybuffer'
    }).not.toThrow()
    expect(remote.binaryType).toBe('arraybuffer')
    await opened
  })

  it('delivers binary frames as ArrayBuffer instances', async () => {
    const { remote, peer } = await openPair()
    const received = new Promise<unknown>((resolve) => {
      remote.addEventListener('message', (event) => resolve(event.data))
    })
    peer.send(Buffer.from([1, 2, 3]))
    const data = await received
    expect(data).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(data as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('sends Uint8Array payloads as binary frames', async () => {
    const { remote, peer } = await openPair()
    const received = new Promise<{ data: WebSocket.RawData; isBinary: boolean }>((resolve) => {
      peer.once('message', (data, isBinary) => resolve({ data, isBinary }))
    })
    remote.send(new Uint8Array([4, 5, 6]))
    const { data, isBinary } = await received
    expect(isBinary).toBe(true)
    expect(data).toBeInstanceOf(Buffer)
    expect(data as Buffer).toEqual(Buffer.from([4, 5, 6]))
  })

  it('tracks readyState across open and close', async () => {
    const { client, remote, opened } = connect(startLoopback().url)
    expect(remote.readyState).toBe(0)
    await opened
    // RemoteSocketStream.sendData treats readyState !== 1 as "cannot send".
    expect(remote.readyState).toBe(1)
    remote.close()
    await new Promise<void>((resolve) => {
      client.once('close', () => resolve())
    })
    expect(remote.readyState).not.toBe(1)
    expect(remote.readyState).toBe(client.readyState)
  })

  it('passes bufferedAmount through', async () => {
    const { client, remote } = await openPair()
    expect(remote.bufferedAmount).toBe(client.bufferedAmount)
    expect(remote.bufferedAmount).toBe(0)
  })

  it('emits a close event when close() is called', async () => {
    const { client, remote } = await openPair()
    const closed = new Promise<void>((resolve) => {
      remote.addEventListener('close', () => resolve())
    })
    remote.close()
    await closed
    expect(client.readyState).not.toBe(1)
  })

  it('stops delivering message events after removeEventListener', async () => {
    const { remote, peer } = await openPair()
    const removed = vi.fn()
    const delivered = new Promise<void>((resolve) => {
      remote.addEventListener('message', () => resolve())
    })
    remote.addEventListener('message', removed)
    remote.removeEventListener('message', removed)
    peer.send(Buffer.from([7]))
    await delivered
    expect(removed).not.toHaveBeenCalled()
  })
})
