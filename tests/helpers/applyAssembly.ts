/**
 * Applies the plugin and SETTLES the identity bootstrap `apply` starts.
 *
 * `apply` is synchronous by host contract, so it cannot await
 * `loadOrCreateIdentity`. That leaves two windows a test can fall into, and both
 * of them were live flake instances in #269:
 *
 *  1. **The write is still in flight when the test tears down.** On a fresh data
 *     directory the bootstrap generates an Ed25519 key (~12 ms) and only then
 *     calls `mkdir(dataDir, { recursive: true })` and writes `identity.key`.
 *     A teardown that removes the directory inside that window gets the
 *     directory RECREATED under it and the final `rmdir` fails `ENOTEMPTY`
 *     (`toolsManage` ③aa).
 *  2. **The file exists but the identity is not readable yet.** `persistIdentity`
 *     writes `identity.key` BEFORE `state.identity` is assigned, so a watcher
 *     that wakes on the file can still be answered "the device identity is still
 *     loading; retry in a moment" by the next tool call (`toolsManage` ③k).
 *
 * Both are the same mistake — waiting for the wrong event. `whenIdentityReady()`
 * is the right one: it settles after the assignment, so there is nothing left in
 * flight and nothing left unreadable.
 *
 * Every test that applies the assembly against a directory it later removes, or
 * that calls a tool needing the identity, must go through here.
 */
export async function applyAssembly(
  ctx: unknown,
  config: { dataDir: string } & Record<string, unknown>,
): Promise<void> {
  const index = await import('../../src/index.js')
  index.apply(ctx as never, config)
  await index.whenIdentityReady()
}

/**
 * Waits for the identity bootstrap to settle. Used directly by the cases that
 * must keep a synchronous `expect(() => index.apply(…)).not.toThrow()` around
 * the call and settle afterwards.
 */
export async function settleIdentity(): Promise<void> {
  const index = await import('../../src/index.js')
  await index.whenIdentityReady()
}
