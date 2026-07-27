import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time key comparison. Every route that accepts a target URL must go
 * through this - an unauthenticated route is an open proxy, whoever wrote it.
 */
export function keysMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the request carries the configured key. */
export function isAuthorized(request: Request, proxyKey: string): boolean {
  const provided = request.headers.get('x-proxy-key');
  return Boolean(provided) && keysMatch(provided as string, proxyKey);
}
