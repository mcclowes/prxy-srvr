import { isAuthorized } from './auth.js';
import type { ProxyConfig } from './config.js';
import { buildResponseHeaders, buildUpstreamHeaders, corsHeaders } from './headers.js';
import { extractTarget, resolveTarget } from './target.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);

function errorResponse(
  status: number,
  message: string,
  request: Request,
  config: ProxyConfig,
): Response {
  const headers = corsHeaders(request, config);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify({ error: message, proxy: config.proxyId }), {
    status,
    headers,
  });
}

/**
 * Redirects are followed by the client, not by us, so every hop is re-checked
 * against the allowlist instead of letting a 302 escape it.
 */
function rewriteRedirect(
  upstream: Response,
  target: URL,
  proxyOrigin: string,
  request: Request,
  config: ProxyConfig,
): Response | null {
  const location = upstream.headers.get('location');
  if (!REDIRECT_STATUSES.has(upstream.status) || !location) return null;

  const absolute = new URL(location, target).toString();
  const headers = buildResponseHeaders(upstream, request, config);
  headers.set('location', `${proxyOrigin}/?url=${encodeURIComponent(absolute)}`);

  return new Response(null, { status: upstream.status, headers });
}

export async function handleProxy(
  request: Request,
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  // Preflight is answered before auth: browsers don't send x-proxy-key on OPTIONS.
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, config) });
  }

  if (!isAuthorized(request, config.proxyKey)) {
    return errorResponse(401, 'Missing or invalid x-proxy-key header.', request, config);
  }

  const requestUrl = new URL(request.url);
  const target = resolveTarget(extractTarget(requestUrl), config.allowedTargets);
  if (!target.ok) {
    return errorResponse(target.status, target.message, request, config);
  }

  const hasBody = !METHODS_WITHOUT_BODY.has(request.method) && request.body !== null;

  let upstream: Response;
  try {
    upstream = await fetchImpl(target.url, {
      method: request.method,
      headers: buildUpstreamHeaders(request, target.url),
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      // Required by undici when streaming a request body.
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return errorResponse(
      timedOut ? 504 : 502,
      timedOut
        ? `Upstream did not respond within ${config.upstreamTimeoutMs}ms.`
        : `Could not reach upstream: ${error instanceof Error ? error.message : String(error)}`,
      request,
      config,
    );
  }

  const redirect = rewriteRedirect(upstream, target.url, requestUrl.origin, request, config);
  if (redirect) return redirect;

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: buildResponseHeaders(upstream, request, config),
  });
}
