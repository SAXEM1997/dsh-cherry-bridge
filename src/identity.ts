import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDeviceIdentity, deviceIdentityId } from '@cherrystudio/remote-transport'

export interface DeviceIdentity {
  key: Uint8Array
  id: string
}

const IDENTITY_FILENAME = 'identity.key'
const IDENTITY_MODE = 0o600

function identityPath(dataDir: string): string {
  return join(dataDir, IDENTITY_FILENAME)
}

/**
 * Parses raw private key bytes through the transport's identity reader.
 * Throws when the bytes are not a valid Ed25519 private key.
 */
function parseIdentity(bytes: Uint8Array): DeviceIdentity {
  return { key: bytes, id: deviceIdentityId(bytes) }
}

async function persistIdentity(path: string, key: Uint8Array): Promise<void> {
  // `mode` only applies when the file is created; overwriting an existing file
  // keeps its old permissions, so chmod explicitly afterwards.
  await writeFile(path, key, { mode: IDENTITY_MODE })
  await chmod(path, IDENTITY_MODE)
}

/**
 * Loads the persistent Ed25519 device identity from `dataDir/identity.key`,
 * generating and persisting a new one when the file is missing or corrupt.
 *
 * The file holds the raw protobuf-encoded private key bytes with 0600
 * permissions.
 */
export async function loadOrCreateIdentity(dataDir: string): Promise<DeviceIdentity> {
  const path = identityPath(dataDir)

  let stored: Uint8Array
  try {
    stored = new Uint8Array(await readFile(path))
  } catch {
    return generateIdentity(dataDir, path)
  }

  try {
    return parseIdentity(stored)
  } catch {
    return generateIdentity(dataDir, path)
  }
}

async function generateIdentity(dataDir: string, path: string): Promise<DeviceIdentity> {
  const key = await createDeviceIdentity()
  await mkdir(dataDir, { recursive: true })
  await persistIdentity(path, key)
  return parseIdentity(key)
}
