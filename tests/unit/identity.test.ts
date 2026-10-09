import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deviceIdentityId } from '@cherrystudio/remote-transport'
import { loadOrCreateIdentity } from '../../src/identity.js'

const dataDirs: string[] = []

beforeEach(() => {
  // A corrupt identity is traced on stderr by design (F3), and tests below
  // exercise that path — including the best-effort preservation copy, which
  // WARNS when it cannot copy (a non-ENOENT read failure has no bytes to
  // preserve). Silence both so the suite output stays pristine; the tests that
  // ASSERT on the trace re-spy inside themselves.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  while (dataDirs.length > 0) await rm(dataDirs.pop()!, { recursive: true, force: true })
})

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-identity-'))
  dataDirs.push(dir)
  return dir
}

function keyPath(dataDir: string): string {
  return join(dataDir, 'identity.key')
}

function permissions(mode: number): number {
  return mode & 0o777
}

describe('loadOrCreateIdentity', () => {
  it('generates and persists a raw Ed25519 private key with 0600 permissions', async () => {
    const dataDir = await makeDataDir()

    const identity = await loadOrCreateIdentity(dataDir)

    expect(identity.key).toBeInstanceOf(Uint8Array)
    expect(identity.key.length).toBeGreaterThan(0)
    expect(identity.id).toBe(deviceIdentityId(identity.key))

    const stored = await readFile(keyPath(dataDir))
    expect(new Uint8Array(stored)).toEqual(identity.key)

    // Raw protobuf bytes, not a text encoding: real protobuf keys contain bytes above 0x7f.
    expect(stored.some((byte) => byte > 0x7f)).toBe(true)
    expect(() => JSON.parse(stored.toString('utf8'))).toThrow()

    const { mode } = await stat(keyPath(dataDir))
    expect(permissions(mode)).toBe(0o600)
  })

  it('reloads the persisted identity and returns the same id', async () => {
    const dataDir = await makeDataDir()

    const first = await loadOrCreateIdentity(dataDir)
    const second = await loadOrCreateIdentity(dataDir)

    expect(second.id).toBe(first.id)
    expect(second.key).toEqual(first.key)
    expect(new Uint8Array(await readFile(keyPath(dataDir)))).toEqual(first.key)
  })

  it('regenerates a fresh identity when the stored bytes are corrupt, restoring 0600', async () => {
    const dataDir = await makeDataDir()
    const previous = await loadOrCreateIdentity(dataDir)

    const corrupt = new TextEncoder().encode('this is not a protobuf ed25519 private key')
    await writeFile(keyPath(dataDir), corrupt)
    // writeFile's mode is masked by umask, so force looser permissions to prove
    // the regenerate path actively re-applies 0600 over an existing file.
    await chmod(keyPath(dataDir), 0o644)
    expect(permissions((await stat(keyPath(dataDir))).mode)).toBe(0o644)
    expect(() => deviceIdentityId(corrupt)).toThrow()

    const recovered = await loadOrCreateIdentity(dataDir)

    expect(recovered.id).not.toBe(previous.id)
    expect(recovered.id).toBe(deviceIdentityId(recovered.key))
    expect(new Uint8Array(await readFile(keyPath(dataDir)))).toEqual(recovered.key)
    expect(permissions((await stat(keyPath(dataDir))).mode)).toBe(0o600)

    const reloaded = await loadOrCreateIdentity(dataDir)
    expect(reloaded.id).toBe(recovered.id)
  })

  it('(F3) traces a corrupt identity: error logged, original preserved, fresh key returned', async () => {
    const dataDir = await makeDataDir()
    const previous = await loadOrCreateIdentity(dataDir)

    const corrupt = new TextEncoder().encode('this is not a protobuf ed25519 private key')
    await writeFile(keyPath(dataDir), corrupt)
    expect(() => deviceIdentityId(corrupt)).toThrow()

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const recovered = await loadOrCreateIdentity(dataDir)

    // The regeneration is DESTRUCTIVE for every stored pairing (the desktop
    // pins the old identity, so every authenticate will now be rejected). That
    // consequence must be visible in the log, not silent — it is the operator's
    // only clue that a whole round of re-pairing is about to be needed.
    expect(error).toHaveBeenCalled()
    const joined = error.mock.calls.flat().map(String).join(' | ')
    expect(joined).toContain(keyPath(dataDir))
    expect(joined).toMatch(/parse|corrupt|invalid/i)
    expect(joined).toMatch(/re-approval|re-pair|re-approve/i)

    // The original bytes survive as `<file>.corrupt`, byte-for-byte.
    const preserved = new Uint8Array(await readFile(`${keyPath(dataDir)}.corrupt`))
    expect(preserved).toEqual(corrupt)

    // A fresh, working identity was still returned and is stable on reload.
    expect(recovered.id).not.toBe(previous.id)
    expect(recovered.id).toBe(deviceIdentityId(recovered.key))
    const reloaded = await loadOrCreateIdentity(dataDir)
    expect(reloaded.id).toBe(recovered.id)
    expect(reloaded.key).toEqual(recovered.key)
  })

  it('(F3) does not quarantine or log for a genuinely absent key (normal first run)', async () => {
    const dataDir = await makeDataDir()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const identity = await loadOrCreateIdentity(dataDir)

    expect(identity.id).toBe(deviceIdentityId(identity.key))
    // First run is not corruption: no error, no `.corrupt` file.
    expect(error).not.toHaveBeenCalled()
    await expect(readFile(`${keyPath(dataDir)}.corrupt`)).rejects.toThrow()
  })

  it('treats a non-ENOENT read failure as corruption, never as a silent first run', async () => {
    // ONLY `ENOENT` means "nothing here yet". Every other read failure — EACCES,
    // EISDIR, EIO, a transient mount error — means bytes ARE there and this
    // process could not read them. Regenerating silently would leave the operator
    // with a fresh key and no explanation, while the desktop still pins the OLD
    // public key and will refuse every stored pairing. The honest reading is
    // CORRUPTION: preserve, complain loudly, then regenerate.
    //
    // A DIRECTORY at the key path makes `readFile` fail with EISDIR — a
    // deterministic, privilege-independent non-ENOENT read error.
    const dataDir = await makeDataDir()
    await mkdir(keyPath(dataDir))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    // The regeneration write cannot succeed (a directory occupies the path), so
    // the call rejects; what this test pins is WHICH path was taken on the way.
    await expect(loadOrCreateIdentity(dataDir)).rejects.toThrow()

    expect(error).toHaveBeenCalled()
    const messages = error.mock.calls.flat().map(String).join('\n')
    expect(messages).toContain(keyPath(dataDir))
    // The CORRUPTION report — not the silent first-run path. It names the
    // consequence the operator has to act on (the desktop still pins the old key).
    expect(messages).toMatch(/corrupt/i)
    expect(messages).toMatch(/re-approval|re-pair|pin/i)
  })
})
