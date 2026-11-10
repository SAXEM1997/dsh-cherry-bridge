import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceIdentity } from '@cherrystudio/remote-transport'
import { DeviceStore } from '../../src/deviceStore.js'
import { DeviceConnection } from '../../src/connection.js'
import { SessionSubscriptions } from '../../src/subscriptions.js'
import { registerCherryTools } from '../../src/tools.js'
import type {
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
} = {}): Promise<Rig> {
  const uploads = options.uploads ?? true
  const fake = new FakeCherry({
    ...(uploads ? { hello: { capabilities: { agentUploadsVersion: 1 } } } : {}),
    ...(options.ackDelayMs === undefined ? {} : { uploadAckDelayMs: options.ackDelayMs }),
    agent: {
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
  registerCherryTools(ctx, deps, {})
  await connection.connect()
  const rig: Rig = {
    fake,
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
    const rig = await makeRig({ files, ackDelayMs: 25 })
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
})
