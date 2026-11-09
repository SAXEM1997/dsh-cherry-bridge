import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Applies the plugin and SETTLES the identity bootstrap `apply` starts.
 *
 * `apply` is synchronous by host contract, so it cannot await
 * `loadOrCreateIdentity`. On a fresh data directory that promise generates an
 * Ed25519 key and writes `identity.key` roughly **12 ms after `apply`
 * returns** (measured; the delay is `createDeviceIdentity()`).
 *
 * A test that removes its data directory inside that window races the write:
 * `generateIdentity` calls `mkdir(dataDir, { recursive: true })` and then
 * writes, so the directory is RECREATED after `rm` has walked it, and `rm`'s
 * final `rmdir` fails with `ENOTEMPTY`. That is issue #269 — the flake that
 * only ever appeared in a full-suite run, where the 12 ms stretches under load.
 *
 * Every test that applies the assembly against a directory it later removes
 * must go through here (or call `waitForIdentityFile`). Waiting for the file is
 * the honest settlement of the promise the test started — it is the same write,
 * not a sleep.
 */
export async function applyAssembly(
  ctx: unknown,
  config: { dataDir: string } & Record<string, unknown>,
): Promise<void> {
  const index = await import('../../src/index.js')
  index.apply(ctx as never, config)
  await waitForIdentityFile(config.dataDir)
}

/**
 * Waits until `dataDir/identity.key` exists — the observable end of the
 * bootstrap `apply` starts. Used directly by the cases that must keep a
 * synchronous `expect(() => index.apply(…)).not.toThrow()` assertion around the
 * call and settle afterwards.
 */
export async function waitForIdentityFile(dataDir: string, timeoutMs = 5_000): Promise<void> {
  const path = join(dataDir, 'identity.key')
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`identity.key did not appear in ${dataDir} within ${timeoutMs} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
