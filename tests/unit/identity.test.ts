import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deviceIdentityId } from '@cherrystudio/remote-transport'
import { loadOrCreateIdentity } from '../../src/identity'

const dataDirs: string[] = []

afterEach(async () => {
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
})
