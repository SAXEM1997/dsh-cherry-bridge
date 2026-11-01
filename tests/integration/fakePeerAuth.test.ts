import { once } from 'node:events'
import type { ComponentLogger, Logger } from '@libp2p/interface'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectSecureChannel,
  createDeviceIdentity,
  RemoteSocketStream,
} from '@cherrystudio/remote-transport'
import { JsonRpcClient, JsonRpcRequestError } from '../../src/rpc/jsonRpcClient.js'
import { toRemoteSocket } from '../../src/rpc/wsAdapter.js'
import { FakeCherry } from '../loopback/fakeCherry.js'
import type { FakeCherryOptions } from '../loopback/fakeCherry.js'

/**
 * The fake peer's AUTHENTICATED STATE, modelled on the desktop's own state
 * machine (issue #183).
 *
 * `RemoteConnection.ts` has TWO ways into the authenticated state, and both set
 * `this.authentication`:
 *
 *  - `connection.authenticate` (its own handler), and
 *  - the APPROVED `pairing.get` branch, which ends in `authenticate(...)`.
 *
 * Once `this.authentication` is set, `connection.authenticate` and
 * `pairing.claim` both refuse with `INVALID_CONNECTION_STATE` /
 * `'Connection is already authenticated'`. The fake used to set its per-socket
 * flag only from the first face, so "pair, then call a capability-gated method
 * on the same socket" answered `UNAUTHENTICATED` where the desktop would have
 * answered, and a client that re-authenticated on a live socket was not caught
 * at all.
 *
 * These are RAW JsonRpcClient sockets, deliberately: `DeviceConnection` never
 * takes either path (it authenticates once per NEW socket and never pairs), so
 * the only way to drive the state machine is one rpc client over one loopback
 * channel.
 */

const noop = (): void => {}

/** A callable silent libp2p logger, the same shape the unit tests use. */
function makeLogger(name: string): Logger {
  const log = (() => {}) as unknown as Logger
  log.error = noop
  log.trace = noop
  log.enabled = false
  log.newScope = (scope: string) => makeLogger(`${name}:${scope}`)
  return log
}

const componentLogger: ComponentLogger = { forComponent: (name: string) => makeLogger(name) }

interface RawPeer {
  fake: FakeCherry
  client: JsonRpcClient
  close: () => Promise<void>
}

const openPeers: RawPeer[] = []

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(async () => {
  for (const peer of openPeers.splice(0)) await peer.close()
  vi.restoreAllMocks()
})

/**
 * One loopback socket, helloed by the caller. Noise-XX is the only handshake
 * here: no `DeviceConnection`, no pool, no record — just the client protocol
 * face the desktop answers.
 */
async function openRaw(options: FakeCherryOptions = {}): Promise<RawPeer> {
  const fake = new FakeCherry({ pairingDecision: 'approved', ...options })
  const { host, port } = await fake.start()
  const desktopIdentity = await fake.identityId
  const identity = await createDeviceIdentity()
  const controller = new AbortController()
  const ws = new WebSocket(`ws://${host}:${port}`)
  try {
    await once(ws, 'open')
    const channel = await connectSecureChannel(
      new RemoteSocketStream(toRemoteSocket(ws), componentLogger.forComponent('raw'), 'outbound'),
      {
        identity,
        logger: componentLogger,
        protocolVersions: [1],
        signal: controller.signal,
        remoteIdentity: desktopIdentity,
      },
    )
    const client = new JsonRpcClient(channel, {})
    const peer: RawPeer = {
      fake,
      client,
      close: async () => {
        client.dispose()
        controller.abort()
        ws.close()
        await fake.stop()
      },
    }
    openPeers.push(peer)
    return peer
  } catch (error) {
    controller.abort()
    ws.close()
    await fake.stop()
    throw error
  }
}

/** The desktop refuses claim/get/authenticate until hello confirmed the offer. */
async function greet(client: JsonRpcClient): Promise<void> {
  await client.request('connection.hello', { protocolVersions: [1] })
}

interface ClaimReceipt {
  claimId: string
  verificationCode: string
}

interface ApprovalReceipt {
  status: string
  deviceId: string
}

/** Claim + approve the fake's one invitation, which AUTHENTICATES the socket. */
async function pairThrough(client: JsonRpcClient): Promise<ApprovalReceipt> {
  const claim = await client.request<ClaimReceipt>('pairing.claim', {
    invitationId: 'invitation-1',
    invitationSecret: 'secret-1',
    deviceName: 'raw-client',
    platform: 'desktop',
    capabilities: ['agent'],
  })
  const approval = await client.request<ApprovalReceipt>('pairing.get', { claimId: claim.claimId })
  expect(approval.status).toBe('approved')
  return approval
}

/** The rejection a request settled with, or `undefined` if it resolved. */
async function failureOf(request: Promise<unknown>): Promise<unknown> {
  return request.then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe('the fake peer after pairing.get approves a device (issue #183)', () => {
  it('#183a the approved pairing branch AUTHENTICATES the socket: a capability-gated connection.endpoints answers on it', async () => {
    const peer = await openRaw({})
    await greet(peer.client)
    await pairThrough(peer.client)

    // The desktop's `connection.endpoints` runs `requireAuthentication` first,
    // so this answer is only possible if the pairing approval set the flag.
    const answer = await peer.client.request<{ desktopIdentity: string; endpoints: unknown[] }>(
      'connection.endpoints',
      { domain: 'agent' },
    )
    expect(answer.desktopIdentity).toBe(await peer.fake.identityId)
    expect(answer.endpoints).toEqual([])
  })

  it('#183b a SECOND connection.authenticate is refused with the desktop verdict, and the first still issues a token', async () => {
    const peer = await openRaw({})
    await greet(peer.client)

    const first = await peer.client.request<{ accessToken: string }>('connection.authenticate', {
      deviceId: 'dev-raw',
    })
    expect(typeof first.accessToken).toBe('string')

    const error = await failureOf(
      peer.client.request('connection.authenticate', { deviceId: 'dev-raw' }),
    )
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'INVALID_CONNECTION_STATE' })
    // The desktop's own wording (RemoteConnection.ts), not a paraphrase.
    expect((error as JsonRpcRequestError).message).toBe('Connection is already authenticated')
    // POSITION, not just the verdict: the desktop's guard sits BEFORE the
    // `authenticate()` helper, so a refused second call mints NO token. A gate
    // moved after the mint would still throw and still pass the assertions
    // above, so the peer's own ledger is what pins the order (review finding).
    expect(peer.fake.tokenIssues).toHaveLength(1)
  })

  it('#183c pairing.get is the other door into that state: connection.authenticate is refused after it', async () => {
    const peer = await openRaw({})
    await greet(peer.client)
    const approval = await pairThrough(peer.client)

    const error = await failureOf(
      peer.client.request('connection.authenticate', { deviceId: approval.deviceId }),
    )
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'INVALID_CONNECTION_STATE' })
    expect((error as JsonRpcRequestError).message).toBe('Connection is already authenticated')
  })

  it('#183d pairing.claim is refused on an authenticated socket too, exactly like the desktop', async () => {
    const peer = await openRaw({})
    await greet(peer.client)
    await peer.client.request('connection.authenticate', { deviceId: 'dev-raw' })

    const error = await failureOf(
      peer.client.request('pairing.claim', {
        invitationId: 'invitation-2',
        invitationSecret: 'secret-2',
        deviceName: 'raw-client',
        platform: 'desktop',
        capabilities: ['agent'],
      }),
    )
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'INVALID_CONNECTION_STATE' })
    expect((error as JsonRpcRequestError).message).toBe('Connection is already authenticated')
  })
})

/**
 * The DESKTOP's other handshake gates (issue #186). #183 modelled the
 * authenticated STATE; these pin the preconditions around it, which the fake
 * used to skip:
 *
 *  - `connection.authenticate` runs its own `requireHello()` inside the
 *    `authenticate()` helper (`RemoteConnection.ts:84`), AFTER the handler's
 *    already-authenticated check;
 *  - `connection.refresh` runs `requireAuthentication(true)`
 *    (`RemoteConnection.ts:101-104, 209-219`), whose first act is
 *    `requireHello()` and whose second is the unauthenticated refusal.
 *
 * Both gates sit BEFORE the mint, so "refused" and "refused after minting"
 * are told apart by the peer's own ledgers, not by the error alone.
 */
describe("the fake peer's pre-authentication gates (issue #186)", () => {
  it('#186a connection.authenticate on an un-greeted socket answers the hello verdict and authenticates nothing', async () => {
    const peer = await openRaw({})

    // The handler checks "already authenticated" FIRST (covered by #183b), so
    // this fresh socket reaches the helper's hello gate, not that one.
    const error = await failureOf(
      peer.client.request('connection.authenticate', { deviceId: 'dev-raw' }),
    )
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'INVALID_CONNECTION_STATE' })
    expect((error as JsonRpcRequestError).message).toBe('Hello is required')
    // POSITION: the gate sits before the mint, like the desktop's helper.
    expect(peer.fake.tokenIssues).toHaveLength(0)

    // …and the refusal must not have flipped the state it gates: if it had,
    // this second call would be answered "already authenticated" instead.
    await greet(peer.client)
    const accepted = await peer.client.request<{ accessToken: string }>('connection.authenticate', {
      deviceId: 'dev-raw',
    })
    expect(typeof accepted.accessToken).toBe('string')
    expect(peer.fake.tokenIssues).toHaveLength(1)
  })

  it('#186b connection.refresh requires the authenticated state: a helloed-but-unauthenticated socket is refused before the mint', async () => {
    const peer = await openRaw({})
    await greet(peer.client)

    const error = await failureOf(peer.client.request('connection.refresh', {}))
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'UNAUTHENTICATED' })
    // The desktop's own `requireAuthentication` wording (RemoteConnection.ts).
    expect((error as JsonRpcRequestError).message).toBe('Device authentication is required')
    // `requireAuthentication` runs before `tokens.issue`, so a refused refresh
    // leaves no trace in either of the peer's ledgers.
    expect(peer.fake.refreshCalls).toHaveLength(0)
    expect(peer.fake.tokenIssues).toHaveLength(0)

    // The same call is legal ONCE the socket is authenticated, and it mints.
    await peer.client.request('connection.authenticate', { deviceId: 'dev-raw' })
    const refreshed = await peer.client.request<{ accessToken: string }>('connection.refresh', {})
    expect(typeof refreshed.accessToken).toBe('string')
    expect(peer.fake.refreshCalls).toHaveLength(1)
  })

  it('#186c connection.refresh on an un-greeted socket answers the hello verdict first', async () => {
    const peer = await openRaw({})

    // `requireAuthentication` is hello THEN authentication; a socket missing
    // both must be judged by the earlier gate.
    const error = await failureOf(peer.client.request('connection.refresh', {}))
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'INVALID_CONNECTION_STATE' })
    expect((error as JsonRpcRequestError).message).toBe('Hello is required')
    expect(peer.fake.refreshCalls).toHaveLength(0)
  })

  it('#186d a stored token the peer does not hold is refused with the desktop\'s TOKEN_EXPIRED verdict, before the mint', async () => {
    const peer = await openRaw({ staleAccessToken: true })
    await greet(peer.client)

    // The exact verdict matters: the client retries on TOKEN_EXPIRED *or*
    // UNAUTHENTICATED, so a retry-only case (⑩b) cannot tell the two apart.
    // `tokens.validate` says both the reason and the message (RemoteTokens.ts).
    const error = await failureOf(
      peer.client.request('connection.authenticate', { deviceId: 'dev-raw', accessToken: 'tok-held-by-nobody' }),
    )
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'TOKEN_EXPIRED' })
    expect((error as JsonRpcRequestError).message).toBe('Device token expired')
    // The refusal is the PEER's, not a mint: no token exists afterwards.
    expect(peer.fake.tokenIssues).toHaveLength(0)
    expect(peer.fake.authenticateAttempts.map((attempt) => attempt.accessToken)).toEqual(['tok-held-by-nobody'])
  })
})

/**
 * Every `agent.*` face is wrapped in the desktop's `requireAgent()` →
 * `requireCapability('agent')` → `requireAuthentication()`
 * (`RemoteConnection.ts:50-52, 198-204`), so the WHOLE namespace is
 * unreachable before the socket authenticates (issue #187).
 *
 * One case per FACE CLASS (read / command / subscription) rather than per
 * method: the gate is one namespace-wide check, and the dispatch arm is what a
 * later face inherits. Each case seeds the peer with the fixture the handler
 * WOULD have answered, so "refused" and "never reached the handler" are told
 * apart by the peer's own ledger — not by the verdict alone.
 */
const agentFixture = {
  agents: [{ agentId: 'agent-1', name: 'Agent One' }],
  sessions: [
    {
      sessionId: 'session-1',
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      title: 'A session',
      historyRevision: '1',
    },
  ],
}

describe('the agent faces require the authenticated session (issue #187)', () => {
  it('#187a a READ face answers UNAUTHENTICATED before the handler reads the fixture', async () => {
    const peer = await openRaw({ agent: agentFixture })
    await greet(peer.client)

    const error = await failureOf(peer.client.request('agent.sessions.get', { sessionId: 'session-1' }))
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'UNAUTHENTICATED' })
    expect((error as JsonRpcRequestError).message).toBe('Device authentication is required')
    // POSITION: `session-1` EXISTS, so a handler-first implementation would
    // have answered it. Only the gate can leave the read ledger empty.
    expect(peer.fake.readCalls).toHaveLength(0)

    await peer.client.request('connection.authenticate', { deviceId: 'dev-raw' })
    const answer = await peer.client.request<{ session: { sessionId: string } }>('agent.sessions.get', {
      sessionId: 'session-1',
    })
    expect(answer.session.sessionId).toBe('session-1')
    expect(peer.fake.readCalls).toHaveLength(1)
  })

  it('#187b a COMMAND face answers UNAUTHENTICATED before the command is recorded', async () => {
    const peer = await openRaw({ agent: agentFixture })
    await greet(peer.client)

    const send = {
      commandId: 'cmd-187',
      sessionId: 'session-1',
      text: 'hello',
      expectedIdleRevision: '1',
    }
    const error = await failureOf(peer.client.request('agent.messages.send', send))
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'UNAUTHENTICATED' })
    expect((error as JsonRpcRequestError).message).toBe('Device authentication is required')
    // A command that reached the handler would be in the ledger (and would
    // have been APPLIED — the fixture admits this body).
    expect(peer.fake.commandCalls).toHaveLength(0)

    await peer.client.request('connection.authenticate', { deviceId: 'dev-raw' })
    const receipt = await peer.client.request<{ status: string }>('agent.messages.send', send)
    expect(receipt.status).toBe('applied')
    expect(peer.fake.commandCalls).toHaveLength(1)
  })

  it('#187c a SUBSCRIPTION face answers UNAUTHENTICATED before a subscription is opened', async () => {
    const peer = await openRaw({ agent: agentFixture })
    await greet(peer.client)

    const error = await failureOf(peer.client.request('agent.sessions.subscribe', { sessionId: 'session-1' }))
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'UNAUTHENTICATED' })
    expect((error as JsonRpcRequestError).message).toBe('Device authentication is required')
    // Checkpoint mode would have opened a real subscription and written its
    // descriptor; neither may exist.
    expect(peer.fake.subscribeCalls).toHaveLength(0)

    await peer.client.request('connection.authenticate', { deviceId: 'dev-raw' })
    const subscription = await peer.client.request<{ subscriptionId: string }>('agent.sessions.subscribe', {
      sessionId: 'session-1',
    })
    expect(typeof subscription.subscriptionId).toBe('string')
    expect(peer.fake.subscribeCalls).toHaveLength(1)
  })
})
