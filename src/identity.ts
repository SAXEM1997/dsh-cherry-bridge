import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
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
 *
 * The two failure modes are deliberately NOT treated alike:
 *
 *  - MISSING (`ENOENT`) is the normal first run: a new identity is generated
 *    silently, which is exactly what the caller asked for.
 *  - CORRUPT is a data-loss event with a consequence the operator cannot infer
 *    from a fresh key alone: the desktop pinned the OLD public key, so every
 *    stored pairing is now invalid and will be refused until re-approved. The
 *    original bytes are preserved as `<file>.corrupt` and the regeneration is
 *    traced on stderr BEFORE it happens, because regenerating silently would
 *    destroy the only evidence of what the previous identity was.
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
  } catch (error) {
    // Preserve first, then complain, then regenerate: a failed copy must not
    // stop the plugin from starting, but it must be visible too.
    const reserved = await quarantineIdentity(path)
    console.error(
      `[cherry-remote] device identity ${path} is corrupt and could not be parsed ` +
        `(${error instanceof Error ? error.message : String(error)}); ` +
        `it was preserved as ${reserved ?? `${path}.corrupt`} (best effort) and a NEW ` +
        'identity is being generated — every paired device will need re-approval, ' +
        'because the desktop still pins the old public key.',
    )
    return generateIdentity(dataDir, path)
  }
}

/**
 * Copies an unparsable identity file to `<path>.corrupt` so the original bytes
 * survive the regeneration. Best effort by design: this runs on the startup
 * path, and failing to make a copy must not stop the identity from being
 * replaced — the caller reports whatever this returns either way.
 */
async function quarantineIdentity(path: string): Promise<string | undefined> {
  const target = `${path}.corrupt`
  try {
    await copyFile(path, target)
    await chmod(target, IDENTITY_MODE)
    return target
  } catch (error) {
    console.warn(`[cherry-remote] identity ${path} could not be preserved as ${target}:`, error)
    return undefined
  }
}

async function generateIdentity(dataDir: string, path: string): Promise<DeviceIdentity> {
  const key = await createDeviceIdentity()
  await mkdir(dataDir, { recursive: true })
  await persistIdentity(path, key)
  return parseIdentity(key)
}
