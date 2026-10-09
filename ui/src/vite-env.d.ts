/**
 * Vite asset-module declarations for the UI sources.
 *
 * `?inline` yields the stylesheet as a string, which is what the published
 * bundle needs (the host's module loader has no co-located-stylesheet notion);
 * the bare import is the dev harness's normal stylesheet link.
 */
declare module '*.css?inline' {
  const content: string
  export default content
}

declare module '*.css' {
  const content: string
  export default content
}
