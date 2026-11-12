import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { registerCherryToolsWithEngine } from '../../src/tools.js'
import type {
  CherryToolEngine,
  CherryFsLike,
  CherryFsTargetLike,
  CherryToolDefinition,
  CherryToolExec,
  CherryToolsContext,
  CherryToolsDeps,
} from '../../src/tools.js'
import { FakeCherry } from '../loopback/fakeCherry.js'

interface Rig {
  fake: FakeCherry
  /** The real engine, so a test can drive its command-memory seam (#321). */
  engine: CherryToolEngine
  call(name: string, args?: Record<string, unknown>, exec?: CherryToolExec): Promise<unknown>
  stop(): Promise<void>
}

const rigs: Rig[] = []
let consoleWarn: ReturnType<typeof vi.fn>
let consoleInfo: ReturnType<typeof vi.fn>

beforeEach(() => {
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.stop()
  consoleWarn.mockRestore()
  consoleInfo.mockRestore()
})

function makeCtx(): CherryToolsContext & { readonly definitions: CherryToolDefinition[] } {
  const definitions: CherryToolDefinition[] = []
  return {
    definitions,
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {
          const index = definitions.indexOf(definition)
          if (index >= 0) definitions.splice(index, 1)
        }
      },
    },
  }
}

/** A filesystem whose "files" are in-memory buffers, keyed by displayPath. */
function memoryFs(files: Map<string, Uint8Array>): CherryFsLike {
  return {
    async resolve(path) {
      return { displayPath: path } satisfies CherryFsTargetLike
    },
    async stat(target) {
      const bytes = files.get(target.displayPath)
      return bytes === undefined ? undefined : { type: 'file', size: bytes.length }
    },
    async readByteRange(target, range) {
      const bytes = files.get(target.displayPath)
      if (bytes === undefined) throw new Error('missing')
      return bytes.slice(range.offset, range.offset + range.length)
    },
  }
}

async function makeRig(options: {
  files?: Map<string, Uint8Array>
  uploads?: boolean
  fs?: CherryFsLike
  ackDelayMs?: number
  presentAccepted?: boolean
  sendOutcome?: 'busy' | 'target-unavailable' | 'resource-exhausted' | 'interrupted'
} = {}): Promise<Rig> {
  const uploads = options.uploads ?? true
  const fake = new FakeCherry({
    ...(uploads ? { hello: { capabilities: { agentUploadsVersion: 1 } } } : {}),
    ...(options.ackDelayMs === undefined ? {} : { uploadAckDelayMs: options.ackDelayMs }),
    ...(options.presentAccepted === undefined ? {} : { presentAccepted: options.presentAccepted }),
    agent: {
      ...(options.sendOutcome === undefined ? {} : { sendOutcome: options.sendOutcome }),
      agents: [{ agentId: 'agent-1', name: 'Agent One' }],
      sessions: [
        { sessionId: 's-1', agentId: 'agent-1', workspaceId: 'ws-1', title: 'Uploads', historyRevision: '1000' },
      ],
    },
  })
  const { host, port } = await fake.start()
  const identity = await createDeviceIdentity()
  const desktopIdentity = await fake.identityId
  const tmp = mkdtempSync(join(tmpdir(), 'cherry-send-attachments-'))
  const store = new DeviceStore(join(tmp, 'devices.json'))
  store.upsert({
    schemaVersion: 4,
    deviceId: 'dev-A',
    displayName: 'Desk Alpha',
    hosts: [host],
    security: { [host]: 'ws' as const },
    ports: { [host]: port },
    port,
    desktopIdentity,
    grants: ['agent'] as 'agent'[],
    enabled: true,
  })
  const connection = new DeviceConnection({ identity, record: store.list()[0]!, rateBudgetPerSecond: 32 })
  const subscriptions = new SessionSubscriptions(connection.rpc, { subscriptionsLimit: 8 })
  connection.rpc.onNotification((method, params) => subscriptions.handleNotification(method, params))
  const ctx = makeCtx()
  const files = options.files ?? new Map<string, Uint8Array>()
  const deps: CherryToolsDeps = {
    store,
    connect: () => connection,
    subs: () => subscriptions,
    pair: async () => {
      throw new Error('pairing is not exercised here')
    },
    evict: () => {
      throw new Error('eviction is not exercised here')
    },
    fs: () => options.fs ?? memoryFs(files),
    workingDirectory: () => ({ ensure: async () => tmp }),
  }
  const registered = registerCherryToolsWithEngine(ctx, deps, {})
  await connection.connect()
  const rig: Rig = {
    fake,
    engine: registered.engine!,
    call: async (name, args = {}, exec) => {
      const definition = ctx.definitions.find((entry) => entry.name === name)
      if (definition === undefined) throw new Error(`tool ${name} is not registered`)
      return definition.execute(args, exec)
    },
    stop: async () => {
      await subscriptions.dispose()
      await connection.close()
      await fake.stop()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
  rigs.push(rig)
  return rig
}

function exec(): CherryToolExec {
  return { agent: { marker: true }, signal: new AbortController().signal }
}

describe('issue #306: cherry_send uploads local files', () => {
  it('㉑a a single image is prepared, chunked, completed, presented and attached to one send', async () => {
    // 2.5 MiB exercises the 1 MiB chunk boundary: three chunks, one partial.
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 512 * 1024, 7)
    const files = new Map([['/work/photo.png', bytes]])
    const rig = await makeRig({ files })

    const result = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '', wait: false, attachments: [{ path: '/work/photo.png' }] },
      exec(),
    )) as Record<string, unknown>

    // The peer saw exactly one upload's worth of RPCs.
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(1)
    expect(rig.fake.methodCount('agent.uploads.complete')).toBe(1)
    expect(rig.fake.methodCount('agent.uploads.get')).toBe(1)
    expect(rig.fake.methodCount('agent.attachments.present')).toBe(1)
    expect(rig.fake.methodCount('agent.messages.send')).toBe(1)

    const sent = rig.fake.commandCallsFor('agent.messages.send')[0]!
    const attachments = sent['attachments'] as Array<{ uploadId: string }>
    expect(attachments).toHaveLength(1)
    expect(sent['text']).toBe('')
    expect(typeof sent['selectionId']).toBe('string')

    const uploadId = attachments[0]!.uploadId
    expect(rig.fake.uploadedBytes(uploadId)?.equals(bytes)).toBe(true)
    expect(rig.fake.uploadedSha256(uploadId)).toBe(createHash('sha256').update(bytes).digest('hex'))

    // The result echoes the staged file, never its bytes.
    expect(result['attachments']).toEqual([
      {
        filename: 'photo.png',
        mediaType: 'image/png',
        byteLength: bytes.length,
        uploadId,
      },
    ])
    expect(JSON.stringify(result)).not.toContain(bytes.toString('base64'))
  })

  it('㉑b blank text WITHOUT attachments still answers text-empty and touches no upload RPC', async () => {
    const rig = await makeRig()
    const verdict = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '   ' },
      exec(),
    )) as Record<string, unknown>
    expect(verdict['error']).toBe('text-empty')
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(0)
    expect(rig.fake.methodCount('agent.messages.send')).toBe(0)
  })

  it('㉑c an old desktop (no agentUploadsVersion) answers unsupported before any upload request', async () => {
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    const rig = await makeRig({ files, uploads: false })
    const verdict = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '', attachments: [{ path: '/work/a.txt' }] },
      exec(),
    )) as Record<string, unknown>
    expect(verdict['error']).toBe('unsupported')
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(0)
    expect(rig.fake.methodCount('agent.messages.send')).toBe(0)
  })

  it('㉑d two attachments upload in order and ride ONE send, ids in caller order', async () => {
    const files = new Map([
      ['/work/first.txt', Buffer.from('first')],
      ['/work/second.txt', Buffer.from('second')],
    ])
    const rig = await makeRig({ files })
    const result = (await rig.call(
      'cherry_send',
      {
        device: 'dev-A',
        sessionId: 's-1',
        text: 'two files',
        wait: false,
        attachments: [{ path: '/work/first.txt' }, { path: '/work/second.txt' }],
      },
      exec(),
    )) as { attachments: Array<{ filename: string; uploadId: string }> }

    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(2)
    expect(rig.fake.methodCount('agent.messages.send')).toBe(1)
    expect(result.attachments.map((file) => file.filename)).toEqual(['first.txt', 'second.txt'])
    const sent = rig.fake.commandCallsFor('agent.messages.send')[0]!
    expect((sent['attachments'] as unknown[]).length).toBe(2)
    const presented = rig.fake.presentedSelections()[0]!
    expect((presented['items'] as unknown[]).length).toBe(2)
  })

  it('㉑e nine attachments are refused locally: no prepare, no send', async () => {
    const rig = await makeRig()
    const attachments = Array.from({ length: 9 }, (_, index) => ({ path: `/work/${index}.txt` }))
    const verdict = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: 'nine', attachments },
      exec(),
    )) as Record<string, unknown>
    expect(verdict['error']).toBe('attachments-too-many')
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(0)
    expect(rig.fake.methodCount('agent.messages.send')).toBe(0)
  })

  it('㉑f a file above 1 GiB is refused from stat alone: no prepare, no read', async () => {
    const huge: CherryFsLike = {
      async resolve(path) {
        return { displayPath: path }
      },
      async stat() {
        return { type: 'file', size: 1024 ** 3 + 1 }
      },
      async readByteRange() {
        throw new Error('must not read a refused file')
      },
    }
    const rig = await makeRig({ fs: huge })
    const verdict = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: 'big', attachments: [{ path: '/work/big.bin' }] },
      exec(),
    )) as Record<string, unknown>
    expect(verdict['error']).toBe('attachment-too-large')
    expect(verdict['limit']).toBe(1024 ** 3)
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(0)
  })

  it('㉑g caller-supplied filename and mediaType reach prepare verbatim', async () => {
    const files = new Map([['/work/blob', Buffer.from('abc')]])
    const rig = await makeRig({ files })
    const result = (await rig.call(
      'cherry_send',
      {
        device: 'dev-A',
        sessionId: 's-1',
        text: '',
        wait: false,
        attachments: [{ path: '/work/blob', filename: 'report.pdf', mediaType: 'application/pdf' }],
      },
      exec(),
    )) as { attachments: Array<{ filename: string; mediaType: string }> }
    expect(result.attachments[0]).toMatchObject({ filename: 'report.pdf', mediaType: 'application/pdf' })
  })

  it('㉑h a refused ack fails the upload, cancels the staged file and sends nothing', async () => {
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    const rig = await makeRig({ files })
    rig.fake.failNextUploadAck({ reason: 'RESOURCE_EXHAUSTED', message: 'staging full' })

    const verdict = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '', attachments: [{ path: '/work/a.txt' }] },
      exec(),
    )) as Record<string, unknown>
    expect(verdict['error']).toBe('upload-failed')
    expect(verdict['reason']).toBe('RESOURCE_EXHAUSTED')
    expect(rig.fake.uploadCancelCount()).toBe(1)
    expect(rig.fake.methodCount('agent.messages.send')).toBe(0)
    expect(rig.fake.methodCount('agent.attachments.present')).toBe(0)
  })

  it('㉑i the client keeps at most TWO chunks in flight', async () => {
    // 2.5 MiB = three chunks; delayed acks make the window observable.
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 512 * 1024, 3)
    const files = new Map([['/work/large.bin', bytes]])
    const rig = await makeRig({ files, ackDelayMs: 100 })
    await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '', wait: false, attachments: [{ path: '/work/large.bin' }] },
      exec(),
    )
    expect(rig.fake.maxUploadInFlight()).toBe(2)
  })

  it('㉑j a failure on the SECOND file cancels the first file already staged', async () => {
    const files = new Map([
      ['/work/a.txt', Buffer.from('first')],
      ['/work/b.txt', Buffer.from('second')],
    ])
    const rig = await makeRig({ files })
    rig.fake.failUploadAckAfter(1, { reason: 'RESOURCE_EXHAUSTED', message: 'staging full' })

    const verdict = (await rig.call(
      'cherry_send',
      {
        device: 'dev-A',
        sessionId: 's-1',
        text: '',
        attachments: [{ path: '/work/a.txt' }, { path: '/work/b.txt' }],
      },
      exec(),
    )) as Record<string, unknown>
    expect(verdict['error']).toBe('upload-failed')
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(2)
    expect(rig.fake.methodCount('agent.messages.send')).toBe(0)
    // One cancel for the failing upload, one for the file it left behind.
    expect(rig.fake.uploadCancelCount()).toBe(2)
  })

  it('㉑k a refused present is best-effort: the send still carries the attachments, without a selectionId', async () => {
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    const rig = await makeRig({ files })
    rig.fake.failNextPresent({ reason: 'INTERNAL', message: 'presence unavailable' })

    const result = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '', wait: false, attachments: [{ path: '/work/a.txt' }] },
      exec(),
    )) as { attachments: unknown[] }
    expect(result.attachments).toHaveLength(1)
    expect(rig.fake.methodCount('agent.messages.send')).toBe(1)
    expect(rig.fake.presentedSelections()).toHaveLength(0)
    const sent = rig.fake.commandCallsFor('agent.messages.send')[0]!
    expect(sent['attachments']).toHaveLength(1)
    expect(sent).not.toHaveProperty('selectionId')
  })

  it('㉑l text over the protocol cap is refused before any upload, even with attachments', async () => {
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    const rig = await makeRig({ files })
    const verdict = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: 'x'.repeat(32_769), attachments: [{ path: '/work/a.txt' }] },
      exec(),
    )) as Record<string, unknown>
    expect(verdict['error']).toBe('text-too-long')
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(0)
  })

  it('㉒a a rejected send cancels the staged uploads and suppresses the attachment echo', async () => {
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    const rig = await makeRig({ files, sendOutcome: 'busy' })

    const verdict = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '', attachments: [{ path: '/work/a.txt' }] },
      exec(),
    )) as Record<string, unknown>

    expect(verdict['status']).toBe('rejected')
    expect(verdict).not.toHaveProperty('attachments')
    // The refusal never consumed the staging record: the tool frees it.
    expect(rig.fake.uploadCancelCount()).toBe(1)
  })

  it('㉒b an interrupted send keeps the staged uploads and the attachment echo', async () => {
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    const rig = await makeRig({ files, sendOutcome: 'interrupted' })

    const verdict = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '', attachments: [{ path: '/work/a.txt' }] },
      exec(),
    )) as Record<string, unknown>

    expect(verdict['status']).toBe('interrupted')
    // `interrupted` is the command's outcome being UNDETERMINED: the desktop
    // may already have pinned the staging record to the run it started, so
    // cancelling would free bytes a live child is using, and suppressing the
    // echo would lose the only ids the caller can reconcile against.
    expect(verdict['attachments']).toEqual([
      { filename: 'a.txt', mediaType: 'application/octet-stream', byteLength: 5, uploadId: expect.any(String) },
    ])
    expect(rig.fake.uploadCancelCount()).toBe(0)
  })

  it('㉒c a declined present still sends the attachments, without a selectionId', async () => {
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    const rig = await makeRig({ files, presentAccepted: false })

    const verdict = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '', wait: false, attachments: [{ path: '/work/a.txt' }] },
      exec(),
    )) as { attachments: unknown[] }

    expect(verdict.attachments).toHaveLength(1)
    expect(rig.fake.presentedSelections()).toHaveLength(1)
    const sent = rig.fake.commandCallsFor('agent.messages.send')[0]!
    expect(sent['attachments']).toHaveLength(1)
    expect(sent).not.toHaveProperty('selectionId')
  })

  it('㉒d a failed chunk drains the sibling writes before cancelling', async () => {
    // THREE chunks, so a sibling is still in flight when the second ack fails.
    const files = new Map([['/work/big.bin', Buffer.alloc(2_500_000, 7)]])
    const rig = await makeRig({ files, ackDelayMs: 30 })
    rig.fake.failEveryUploadAckAfter(1, { reason: 'INTERNAL', message: 'ack lost' })

    const rejections: unknown[] = []
    const observe = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', observe)
    try {
      const verdict = (await rig.call(
        'cherry_send',
        { device: 'dev-A', sessionId: 's-1', text: '', attachments: [{ path: '/work/big.bin' }] },
        exec(),
      )) as Record<string, unknown>
      expect(verdict['error']).toBe('upload-failed')
      expect(verdict['reason']).toBe('INTERNAL')
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', observe)
    }

    // The drain settled the sibling BEFORE the cancel, and no rejection escaped.
    expect(rig.fake.uploadCancelCount()).toBe(1)
    expect(rig.fake.cancelledWithUploadsInFlight()).toBe(0)
    expect(rejections).toEqual([])
  })

  it('㉓a a same-id attachment retry reuses the remembered uploads and echo', async () => {
    const files = new Map([
      ['/work/a.txt', Buffer.from('hello')],
      ['/work/b.txt', Buffer.from('other')],
    ])
    const rig = await makeRig({ files })
    const args = {
      device: 'dev-A',
      sessionId: 's-1',
      text: '',
      wait: false,
      commandId: 'cmd-1',
      attachments: [{ path: '/work/a.txt' }],
    }

    const first = (await rig.call('cherry_send', args, exec())) as {
      commandId: string
      attachments: Array<{ uploadId: string; filename: string; mediaType: string; byteLength: number }>
    }
    const retry = (await rig.call('cherry_send', args, exec())) as typeof first
    // A replay rewrites the memory entry; a SECOND retry pins that the local
    // source survives that rewrite instead of being dropped on the first one.
    const retryAgain = (await rig.call('cherry_send', args, exec())) as typeof first

    expect(retry.commandId).toBe('cmd-1')
    // The echo is the ORIGINAL staging record, not a second upload's.
    expect(retry.attachments).toEqual(first.attachments)
    expect(retryAgain.attachments).toEqual(first.attachments)
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(1)
    expect(rig.fake.methodCount('agent.attachments.present')).toBe(1)
    // The whole point of the replay: the peer still holds ONE command record.
    expect(rig.fake.admittedCommands.size).toBe(1)
  })

  it('㉓b a different attachment under the same id is refused before any upload', async () => {
    const files = new Map([
      ['/work/a.txt', Buffer.from('hello')],
      ['/work/b.txt', Buffer.from('other')],
    ])
    const rig = await makeRig({ files })
    await rig.call(
      'cherry_send',
      {
        device: 'dev-A',
        sessionId: 's-1',
        text: '',
        wait: false,
        commandId: 'cmd-1',
        attachments: [{ path: '/work/a.txt' }],
      },
      exec(),
    )

    await expect(
      rig.call(
        'cherry_send',
        {
          device: 'dev-A',
          sessionId: 's-1',
          text: '',
          wait: false,
          commandId: 'cmd-1',
          attachments: [{ path: '/work/b.txt' }],
        },
        exec(),
      ),
    ).rejects.toThrow(/^Command body differs from the recorded command/)
    // The conflict is decided locally: no second prepare, no second send.
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(1)
    expect(rig.fake.methodCount('agent.messages.send')).toBe(1)
  })

  it('㉓c a NEW commandId uploads again and gets fresh ids', async () => {
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    const rig = await makeRig({ files })
    const send = (commandId: string) =>
      rig.call(
        'cherry_send',
        {
          device: 'dev-A',
          sessionId: 's-1',
          text: '',
          wait: false,
          commandId,
          attachments: [{ path: '/work/a.txt' }],
        },
        exec(),
      ) as Promise<{ attachments: Array<{ uploadId: string }> }>

    const first = await send('cmd-1')
    const second = await send('cmd-2')

    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(2)
    expect(second.attachments[0]!.uploadId).not.toBe(first.attachments[0]!.uploadId)
  })

  // Issue #312: ONE verdict, `upload-failed`, with the peer's code preserved in
  // `reason`. The four codes are not separate errors; these cases pin that the
  // code is never dropped or rewritten on the way out.
  async function refusedUpload(reason: string): Promise<Record<string, unknown>> {
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    const rig = await makeRig({ files })
    rig.fake.failNextUploadAck({ reason, message: `peer refused: ${reason}` })
    return (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '', attachments: [{ path: '/work/a.txt' }] },
      exec(),
    )) as Record<string, unknown>
  }

  it('㉔a a NOT_FOUND upload failure keeps the peer code in reason', async () => {
    const verdict = await refusedUpload('NOT_FOUND')
    expect(verdict['error']).toBe('upload-failed')
    expect(verdict['reason']).toBe('NOT_FOUND')
  })

  it('㉔b a CHECKSUM_MISMATCH verification failure keeps the peer code in reason', async () => {
    // This code cannot ride an upload ACK (the protocol's ack enum has no
    // CHECKSUM_MISMATCH): the desktop reports it on `agent.uploads.get` after
    // `complete`, which is the path this case drives.
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    const rig = await makeRig({ files })
    rig.fake.failNextUploadVerification('CHECKSUM_MISMATCH')

    const verdict = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '', attachments: [{ path: '/work/a.txt' }] },
      exec(),
    )) as Record<string, unknown>

    expect(verdict['error']).toBe('upload-failed')
    expect(verdict['reason']).toBe('CHECKSUM_MISMATCH')
  })

  it('㉔c a RESOURCE_EXHAUSTED upload failure keeps the peer code in reason', async () => {
    const verdict = await refusedUpload('RESOURCE_EXHAUSTED')
    expect(verdict['error']).toBe('upload-failed')
    expect(verdict['reason']).toBe('RESOURCE_EXHAUSTED')
  })

  it('㉔d a GRANT_REVOKED upload failure keeps the peer code in reason', async () => {
    const verdict = await refusedUpload('GRANT_REVOKED')
    expect(verdict['error']).toBe('upload-failed')
    expect(verdict['reason']).toBe('GRANT_REVOKED')
  })

  it('㉕a a rejected send replay does not echo the uploads the first send cancelled', async () => {
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    const rig = await makeRig({ files, sendOutcome: 'busy' })
    const args = {
      device: 'dev-A',
      sessionId: 's-1',
      text: '',
      wait: false,
      commandId: 'cmd-1',
      attachments: [{ path: '/work/a.txt' }],
    }

    const first = (await rig.call('cherry_send', args, exec())) as Record<string, unknown>
    const retry = (await rig.call('cherry_send', args, exec())) as Record<string, unknown>

    expect(first['status']).toBe('rejected')
    expect(first).not.toHaveProperty('attachments')
    expect(retry['status']).toBe('rejected')
    // The first branch freed these ids; advertising them beside a rejection
    // would tell the caller they are attached to the run.
    expect(retry).not.toHaveProperty('attachments')
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(1)
    // The replay must NOT cancel again: the first branch already did.
    expect(rig.fake.uploadCancelCount()).toBe(1)
  })

  it('㉕b a text-only send cannot be retried as an attachment send under the same id', async () => {
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    const rig = await makeRig({ files })
    await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: 'hello', wait: false, commandId: 'cmd-1' },
      exec(),
    )

    await expect(
      rig.call(
        'cherry_send',
        {
          device: 'dev-A',
          sessionId: 's-1',
          text: 'hello',
          wait: false,
          commandId: 'cmd-1',
          attachments: [{ path: '/work/a.txt' }],
        },
        exec(),
      ),
    ).rejects.toThrow(/^Command body differs from the recorded command/)
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(0)
  })

  it('㉕c an attachment send cannot be retried as text-only under the same id', async () => {
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    // A declined presence keeps `selectionId` out of the remembered body, so
    // the ATTACHMENTS comparison is the only thing that can catch this retry.
    const rig = await makeRig({ files, presentAccepted: false })
    await rig.call(
      'cherry_send',
      {
        device: 'dev-A',
        sessionId: 's-1',
        text: 'hello',
        wait: false,
        commandId: 'cmd-1',
        attachments: [{ path: '/work/a.txt' }],
      },
      exec(),
    )

    await expect(
      rig.call(
        'cherry_send',
        { device: 'dev-A', sessionId: 's-1', text: 'hello', wait: false, commandId: 'cmd-1' },
        exec(),
      ),
    ).rejects.toThrow(/^Command body differs from the recorded command/)
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(1)
    // Refused LOCALLY: the peer never sees a second send under this id.
    expect(rig.fake.methodCount('agent.messages.send')).toBe(1)
  })

  it('㉖a an evicted command entry re-uploads, and the peer rejects the new body', async () => {
    const files = new Map([['/work/a.txt', Buffer.from('hello')]])
    const rig = await makeRig({ files })
    const args = {
      device: 'dev-A',
      sessionId: 's-1',
      text: '',
      wait: false,
      commandId: 'cmd-1',
      attachments: [{ path: '/work/a.txt' }],
    }
    await rig.call('cherry_send', args, exec())
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(1)

    // The engine's own FIFO: one entry per id, 128 per device. The first send
    // was the OLDEST entry, so filling the bound evicts it.
    for (let index = 0; index < 128; index += 1) {
      rig.engine.rememberCommandBodyForTest('dev-A', `filler-${index}`)
    }
    expect(rig.engine.rememberedCommandIds('dev-A')).not.toContain('cmd-1')

    // With no memory, the retry uploads again (fresh uploadIds), so its body
    // differs from the ledger's and the PEER decides: an idempotency conflict,
    // not a silent replay and not a second successful send.
    await expect(rig.call('cherry_send', args, exec())).rejects.toThrow(
      /^Command body differs from the recorded command/,
    )
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(2)
    expect(rig.fake.methodCount('agent.messages.send')).toBe(2)
  })
})

/** The same in-memory files, read with a delay, so a drop can land between writes. */
function slowFs(files: Map<string, Uint8Array>, delayMs: number): CherryFsLike {
  return {
    async resolve(path) {
      return { displayPath: path } satisfies CherryFsTargetLike
    },
    async stat(target) {
      const bytes = files.get(target.displayPath)
      return bytes === undefined ? undefined : { type: 'file', size: bytes.length }
    },
    async readByteRange(target, range) {
      const bytes = files.get(target.displayPath)
      if (bytes === undefined) throw new Error('missing')
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      return bytes.slice(range.offset, range.offset + range.length)
    },
  }
}

/**
 * Issue #327: a link lost MID-TRANSFER resumes from the peer's committed offset
 * instead of throwing the transfer away.
 *
 * The protocol's `agent.uploads.resume` exists for exactly this; the official
 * mobile client uses it (`remoteUploads.ts:155-168`). Before this the client
 * cancelled and the caller had to re-upload every byte.
 */
describe('issue #327: an interrupted upload resumes', () => {
  it('㉘a a link drop mid-upload resumes from the committed offset, never from zero', async () => {
    // Two 1 MiB chunks, read slowly: the drop lands while the client is between
    // writes, so the chunk after the committed prefix is never pushed into the
    // dead socket's queue (a write racing a close leaves the transport's own
    // send queue rejecting unobserved, which is not this ticket's subject).
    const bytes = Buffer.alloc(2 * 1024 * 1024, 9)
    const files = new Map([['/work/big.bin', bytes]])
    const rig = await makeRig({ fs: slowFs(files, 120) })
    // The FIRST chunk is staged, then the link dies before its ack: the peer
    // has a committed prefix the resume must skip.
    rig.fake.dropLinkAfterUploadChunks(1)

    const result = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '', wait: false, attachments: [{ path: '/work/big.bin' }] },
      exec(),
    )) as Record<string, unknown>

    // ONE upload: no second `prepare`, no cancel, exactly one resume.
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(1)
    expect(rig.fake.uploadCancelCount()).toBe(0)
    const resumes = rig.fake.uploadResumes()
    expect(resumes).toHaveLength(1)
    expect(resumes[0]!['expectedWriterEpoch']).toBe('0')
    expect(typeof resumes[0]!['resumeId']).toBe('string')

    // The peer ended up with the whole file, certified by its own digest.
    const uploadId = ((result['attachments'] as Array<{ uploadId: string }>)[0]!).uploadId
    expect(uploadId).toBe(String(resumes[0]!['uploadId']))
    expect(rig.fake.uploadedBytes(uploadId)?.equals(bytes)).toBe(true)
    expect(rig.fake.uploadedSha256(uploadId)).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('㉘b a drop while `complete` is answered certifies the bytes instead of re-sending them', async () => {
    // The peer finishes the upload and dies before the answer lands: every byte
    // is already there, so a resume must certify, never transfer.
    const bytes = Buffer.alloc(2 * 1024 * 1024, 4)
    const files = new Map([['/work/done.bin', bytes]])
    const rig = await makeRig({ files })
    rig.fake.dropLinkAfterUploadComplete()

    const result = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '', wait: false, attachments: [{ path: '/work/done.bin' }] },
      exec(),
    )) as Record<string, unknown>

    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(1)
    // The `ready` branch: no second `complete`, no `resume`, no cancel.
    expect(rig.fake.methodCount('agent.uploads.complete')).toBe(1)
    expect(rig.fake.uploadResumes()).toHaveLength(0)
    expect(rig.fake.uploadCancelCount()).toBe(0)

    const uploadId = ((result['attachments'] as Array<{ uploadId: string }>)[0]!).uploadId
    expect(rig.fake.uploadedBytes(uploadId)?.equals(bytes)).toBe(true)
    expect(rig.fake.uploadedSha256(uploadId)).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('㉘c a peer that ROTATED its writer epoch is never resumed onto', async () => {
    // The peer reports a different `writerEpoch` than the one the upload was
    // staged under — its writer was replaced, so the staged bytes are no longer
    // the ones this file describes. A resume must be abandoned (and the staged
    // record cancelled), NOT carried over into the new writer.
    const bytes = Buffer.alloc(2 * 1024 * 1024, 7)
    const files = new Map([['/work/rotated.bin', bytes]])
    const rig = await makeRig({ fs: slowFs(files, 120) })
    rig.fake.dropLinkAfterUploadChunks(1)
    rig.fake.reportUploadWriterEpochOnGet('7')

    const verdict = (await rig.call(
      'cherry_send',
      { device: 'dev-A', sessionId: 's-1', text: '', wait: false, attachments: [{ path: '/work/rotated.bin' }] },
      exec(),
    )) as Record<string, unknown>

    // The ORIGINAL link-loss verdict stands, and nothing was written twice.
    expect(verdict['error']).toBe('upload-failed')
    expect(rig.fake.methodCount('agent.uploads.prepare')).toBe(1)
    expect(rig.fake.uploadResumes()).toHaveLength(0)
    expect(rig.fake.uploadCancelCount()).toBe(1)
    expect(rig.fake.methodCount('agent.messages.send')).toBe(0)
  })
})
