/**
 * Renders a host as a URL authority component. The device archive and pairing
 * flow store BARE hosts (plan-mandated normalization), so a bare IPv6 literal
 * must be bracketed before it is spliced into a URL — `ws://::1:35543/...`
 * is not a valid URL and `new WebSocket(...)` throws synchronously on it.
 *
 * Shared home for the dial sites: both `connection.ts` (per-device dial) and
 * `pairing.ts` (candidate dial) splice hosts into URLs and must bracket the
 * same way.
 */
export function urlHost(host: string): string {
  // A colon can only mean IPv6 here: a `host:port` pair never reaches this
  // layer (the port travels separately).
  return host.includes(':') ? `[${host}]` : host
}
