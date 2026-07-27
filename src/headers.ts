import type { ProxyConfig } from './config.js';

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * Headers naming the caller. Vercel signs `forwarded` and `x-forwarded-for`
 * onto every inbound request, so passing them on hands the upstream the exact
 * address the proxy exists to stand in front of - and lets it rate limit or
 * block on that address rather than ours, which makes a pool of proxies share
 * one budget instead of having one each.
 */
const CALLER_IDENTIFYING = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
];

const STRIP_FROM_REQUEST = new Set([
  ...HOP_BY_HOP,
  ...CALLER_IDENTIFYING,
  'host',
  'cookie',
  'cookie2',
  'content-length',
  'x-proxy-key',
  // fetch decompresses for us, so asking for an encoding we then re-advertise would lie.
  'accept-encoding',
]);

const STRIP_FROM_RESPONSE = new Set([
  ...HOP_BY_HOP,
  'set-cookie',
  'content-encoding',
  'content-length',
]);

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS';

export function buildUpstreamHeaders(request: Request, target: URL): Headers {
  const headers = new Headers();

  for (const [name, value] of request.headers) {
    const key = name.toLowerCase();
    // x-vercel-* describes our infrastructure, not the client's intent.
    if (STRIP_FROM_REQUEST.has(key) || key.startsWith('x-vercel-')) {
      continue;
    }
    headers.set(name, value);
  }

  headers.set('host', target.host);
  return headers;
}

/** Echoes an allowlisted origin, or `*` when no allowlist is configured. */
function resolveAllowedOrigin(requestOrigin: string | null, config: ProxyConfig): string | null {
  if (config.allowedOrigins.length === 0) return '*';
  if (!requestOrigin) return null;

  return config.allowedOrigins.includes(requestOrigin.toLowerCase()) ? requestOrigin : null;
}

export function corsHeaders(request: Request, config: ProxyConfig): Headers {
  const headers = new Headers();
  const allowedOrigin = resolveAllowedOrigin(request.headers.get('origin'), config);

  if (allowedOrigin) {
    headers.set('access-control-allow-origin', allowedOrigin);
  }

  headers.set('access-control-allow-methods', ALLOWED_METHODS);
  headers.set(
    'access-control-allow-headers',
    request.headers.get('access-control-request-headers') ??
      'authorization, content-type, x-proxy-key, x-requested-with',
  );
  headers.set('access-control-expose-headers', '*');
  headers.set('access-control-max-age', '86400');
  headers.set('vary', 'origin, access-control-request-headers');
  headers.set('x-proxy-id', config.proxyId);

  return headers;
}

export function buildResponseHeaders(
  upstream: Response,
  request: Request,
  config: ProxyConfig,
): Headers {
  const headers = new Headers();

  for (const [name, value] of upstream.headers) {
    if (STRIP_FROM_RESPONSE.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }

  // Our CORS headers win over whatever the upstream set.
  for (const [name, value] of corsHeaders(request, config)) {
    headers.set(name, value);
  }

  return headers;
}
