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

const STRIP_FROM_REQUEST = new Set([
  ...HOP_BY_HOP,
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
    // x-vercel-* and x-forwarded-host describe our infrastructure, not the client's intent.
    if (STRIP_FROM_REQUEST.has(key) || key.startsWith('x-vercel-') || key === 'x-forwarded-host') {
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
