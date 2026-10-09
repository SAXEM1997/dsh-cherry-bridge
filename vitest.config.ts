import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
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
