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
 * The desktop's ping handler starts with `requireHello()`
 * (`RemoteConnection.ts:111-114`), so a ping on a socket that never helloed is
 * refused with INVALID_CONNECTION_STATE there and was ANSWERED here — the last
 * method in the fake that the desktop gates and this peer did not (issue #192).
 *
 * Unobservable through `DeviceConnection`, which pings only on an established
 * link; the divergence still matters, because a fixture that pings early would
 * be asserting the fake's permissiveness rather than the desktop's contract.
 */
/**
 * The desktop's `authenticate()` looks the APPROVAL up before it looks at the
 * token (`RemoteConnection.ts:84-90`):
 *
 *     this.requireHello()
 *     const authorization = apiGatewayPairedDeviceService.getRemoteAuthorization(deviceId, channel.remoteIdentity)
 *     if (!authorization) throw new RemoteRpcError('UNAUTHENTICATED', 'Device has no approved capabilities')
 *     if (accessToken) tokens.validate(accessToken, deviceId, channel.remoteIdentity, authorization)
 *
 * so a device the desktop never approved is refused there, while the fake minted
 * it a token and granted `agent` (issue #191). The knob is OPT-IN on purpose:
 * every existing fixture invents a device id, and an unset knob must leave every
 * path byte-identical.
 */
describe("the fake peer's device-approval gate on authenticate (issue #191)", () => {
  it('#191a an id the peer never approved answers UNAUTHENTICATED before the token gate, and mints nothing', async () => {
    const peer = await openRaw({ approvedDeviceIds: ['dev-approved'], staleAccessToken: true })
    await greet(peer.client)

    // The TOKEN gate would also reject this call (`staleAccessToken`), so the
    // verdict pins the ORDER: the approval lookup speaks first, the token second.
    const error = await failureOf(
      peer.client.request('connection.authenticate', { deviceId: 'dev-invented', accessToken: 'tok-held-by-nobody' }),
    )
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'UNAUTHENTICATED' })
    expect((error as JsonRpcRequestError).message).toBe('Device has no approved capabilities')
    // POSITION: refused before the mint — and the call DID reach the handler.
    expect(peer.fake.tokenIssues).toHaveLength(0)
    expect(peer.fake.authenticateAttempts.map((attempt) => attempt.deviceId)).toEqual(['dev-invented'])

    const issued = await peer.client.request<{ deviceId: string }>('connection.authenticate', {
      deviceId: 'dev-approved',
    })
    expect(issued.deviceId).toBe('dev-approved')
    expect(peer.fake.tokenIssues).toHaveLength(1)
  })
})

describe("the fake peer's ping gate (issue #192)", () => {
  it('#192a connection.ping answers the hello verdict on an un-greeted socket, and the nonce after it', async () => {
    const peer = await openRaw({})

    const error = await failureOf(peer.client.request('connection.ping', { nonce: 'n-early' }))
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'INVALID_CONNECTION_STATE' })
    expect((error as JsonRpcRequestError).message).toBe('Hello is required')

    await greet(peer.client)
    const answer = await peer.client.request<{ nonce: string }>('connection.ping', { nonce: 'n-late' })
    expect(answer.nonce).toBe('n-late')
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
    // descriptor before the ledger records the call, so `subscribeCalls` alone
    // is not the entry-point pin on that path: the subscription set is.
    expect(peer.fake.subscribeCalls).toHaveLength(0)
    expect(peer.fake.subscriptions).toHaveLength(0)

    await peer.client.request('connection.authenticate', { deviceId: 'dev-raw' })
    const subscription = await peer.client.request<{ subscriptionId: string }>('agent.sessions.subscribe', {
      sessionId: 'session-1',
    })
    expect(typeof subscription.subscriptionId).toBe('string')
    expect(peer.fake.subscribeCalls).toHaveLength(1)
    expect(peer.fake.subscriptions).toHaveLength(1)
  })
})

/**
 * The GRANT half of the same gate (issue #194). The desktop's `requireAgent()`
 * is `requireCapability('agent')`, and `requireCapability` checks BOTH the
 * authenticated state AND the grant the pairing approved
 * (`RemoteConnection.ts:198-204`):
 *
 *     requireCapability(domain) {
 *       const auth = this.requireAuthentication()
 *       const grant = auth.authorization.grants.find((value) => value.domain === domain)
 *       if (!grant) throw new RemoteRpcError('FORBIDDEN', 'Capability was not approved during pairing')
 *       return { deviceId: auth.deviceId, grantId: grant.grantId }
 *     }
 *
 * #187 modelled the authentication half only — an `authenticated` boolean — so a
 * device the desktop approved NOTHING for was still served every agent face.
 * `approvedGrants` is the knob that already produces that shape; these two cases
 * make the fake able to tell a granted device from an ungranted one, one case per
 * door into the authenticated state (#183 named them: `connection.authenticate`
 * and the approved `pairing.get` branch).
 */
describe('the agent faces require the grant the pairing approved (issue #194)', () => {
  it('#194a a socket holding a grant OTHER than agent answers FORBIDDEN, and reads nothing', async () => {
    // `configuration` is a real domain of the pinned protocol
    // (`remoteCapabilitySchema = ['configuration', 'agent']`), so this device
    // HOLDS a grant. A gate that only asks "any grants?" answers here; only the
    // domain check refuses — which is what `requireCapability('agent')` does.
    const peer = await openRaw({ agent: agentFixture, approvedGrants: ['configuration'] })
    await greet(peer.client)

    // ORDER, before any session exists: the desktop's `requireCapability` runs
    // `requireAuthentication()` FIRST, so an unauthenticated socket hears
    // UNAUTHENTICATED even though it also holds no `agent` grant. A gate that
    // judged the grant first would answer FORBIDDEN here.
    const beforeAuth = await failureOf(peer.client.request('agent.sessions.get', { sessionId: 'session-1' }))
    expect(beforeAuth).toBeInstanceOf(JsonRpcRequestError)
    expect((beforeAuth as JsonRpcRequestError).data).toMatchObject({ reason: 'UNAUTHENTICATED' })
    expect((beforeAuth as JsonRpcRequestError).message).toBe('Device authentication is required')
    expect(peer.fake.readCalls).toHaveLength(0)

    const issued = await peer.client.request<{ authorization: { grants: { domain: string }[] } }>(
      'connection.authenticate',
      { deviceId: 'dev-raw' },
    )
    // ONE SOURCE: the reply hands out the domains this socket is judged on. A
    // reply hard-coded to `agent` beside a `configuration` socket is the peer
    // contradicting itself, and a client would archive a grant it does not hold.
    expect(issued.authorization.grants.map((grant) => grant.domain)).toEqual(['configuration'])
    // The SESSION is real — a token was issued — so the refusal below can only
    // be the grant. Without this, a fake that authenticated nothing would refuse
    // for the wrong reason and still look green on the verdict alone.
    expect(peer.fake.tokenIssues).toHaveLength(1)

    const error = await failureOf(peer.client.request('agent.sessions.get', { sessionId: 'session-1' }))
    expect(error).toBeInstanceOf(JsonRpcRequestError)
    expect((error as JsonRpcRequestError).data).toMatchObject({ reason: 'FORBIDDEN' })
    expect((error as JsonRpcRequestError).message).toBe('Capability was not approved during pairing')
    // POSITION: `session-1` EXISTS, so a handler-first implementation answers it.
    expect(peer.fake.readCalls).toHaveLength(0)
  })

  it('#194b the pairing door records the grant: an agent-granted approval serves the agent face', async () => {
    // The default grant (`['agent']`) through the OTHER door. Without recording
    // the grants there, `live.grants` stays undefined and this answer becomes
    // FORBIDDEN — the shape #194a pins from the opposite side. WHICH domains are
    // recorded is #194a's claim (it supplies `configuration`); this case is the
    // recording itself.
    const peer = await openRaw({ agent: agentFixture })
    await greet(peer.client)
    await pairThrough(peer.client)

    const answer = await peer.client.request<{ session: { sessionId: string } }>('agent.sessions.get', {
      sessionId: 'session-1',
    })
    expect(answer.session.sessionId).toBe('session-1')
    expect(peer.fake.readCalls).toHaveLength(1)
  })

  it('#194c connection.endpoints is judged per DOMAIN, not on the agent namespace', async () => {
    // `connection.endpoints` runs `requireCapability(domain)` for the REQUESTED
    // domain (RemoteConnection.ts:107-112). The fake hardcoded `agent` while
    // grants were fixed, so a configuration-only device was refused the domain
    // it holds and SERVED the one it does not (review finding on #194).
    const peer = await openRaw({
      approvedGrants: ['configuration'],
      endpoints: { endpoints: [{ host: 'endpoint.example', port: 23333 }] },
    })
    await greet(peer.client)
    await peer.client.request('connection.authenticate', { deviceId: 'dev-raw' })

    const refused = await failureOf(peer.client.request('connection.endpoints', { domain: 'agent' }))
    expect(refused).toBeInstanceOf(JsonRpcRequestError)
    expect((refused as JsonRpcRequestError).data).toMatchObject({ reason: 'FORBIDDEN' })
    expect((refused as JsonRpcRequestError).message).toBe('Capability was not approved during pairing')

    // The domain it HOLDS answers — the half a hardcoded `agent` gateway could
    // never serve, so the two directions cannot both pass by accident.
    const served = await peer.client.request<{ endpoints: { host: string }[] }>('connection.endpoints', {
      domain: 'configuration',
    })
    expect(served.endpoints.map((endpoint) => endpoint.host)).toEqual(['endpoint.example'])
  })
})
