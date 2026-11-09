import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'

/**
 * Workers, deliberately not left to the default.
 *
 * vitest defaults `maxWorkers` to `cores - 1`. On a two-core machine that is
 * ONE worker, so the whole suite queues behind itself: 70 files, 238 s of
 * measured test time, ~300 s wall. Two workers ran the same suite in 158 s
 * with no test changed.
 *
 * `--no-isolate` is faster still (125 s) and is NOT an option here: five tests
 * in different files share module state and fail without isolation. Isolation
 * stays on.
 *
 * The floor of 2 only lifts the machines where the default collapses to a
 * single worker; anything wider keeps vitest's own `cores - 1`.
 */
const workers = Math.max(2, availableParallelism() - 1)

export default defineConfig({
  test: {
    maxWorkers: workers,
    include: ['tests/**/*.test.ts'],
    // `exclude` is stated explicitly rather than left to the default because it
    // is load-bearing here, not boilerplate: `_research/cherry-studio` is a
    // vendored upstream checkout that carries its own test files. Without this
    // entry vitest's default `**/node_modules/**`-shaped exclusion is the only
    // thing keeping them out, and they would be collected the moment anyone
    // widened the default — running a third party's suite against our config.
    // `node_modules` is repeated for the same reason: an explicit list is also
    // the documentation of what is deliberately not collected.
    exclude: ['_research/**', 'node_modules/**'],
  },
})
