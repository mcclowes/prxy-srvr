import { isAuthorized } from './auth.js';
import type { ProxyConfig } from './config.js';
import { buildUpstreamHeaders, corsHeaders } from './headers.js';
import { buildIssue, correlationIdFor, ISSUE, type Issue } from './issues.js';
import { resolveTarget } from './target.js';

/**
 * Fetch many targets in one invocation.
 *
 * The single-target endpoint pays the full round trip per request - caller to
 * here, here to upstream, and back twice. Against a high-latency path that
 * overhead, not the upstream, is what caps throughput. Batching pays it once
 * for the whole group, and collapses N function invocations into one.
 */

/**
 * Cap on targets per batch. Each result carries its upstream body, and a
 * serverless response has a hard size ceiling - a few hundred typical JSON
 * documents is comfortable, a few thousand is not.
 */
export const MAX_BATCH_SIZE = 200;

/** In-flight upstream requests per invocation, so one batch can't open 200 sockets at once. */
const UPSTREAM_CONCURRENCY = 32;

interface BatchRequestItem {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

/**
 * Either the upstream answered - `status` and `body`, whatever it said - or we
 * never got that far, and `issues` says why. An upstream 403 is a result, not
 * an issue: the relay did its job and this is the answer.
 */
interface BatchResult {
  index: number;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  issues?: Issue[];
}

function jsonResponse(
  body: unknown,
  status: number,
  request: Request,
  config: ProxyConfig,
): Response {
  const headers = corsHeaders(request, config);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

function failBatch(issue: Issue, status: number, request: Request, config: ProxyConfig): Response {
  return jsonResponse({ proxy: config.proxyId, issues: [issue] }, status, request, config);
}

/** Response headers worth passing back. The body is already decoded, so encoding headers would lie. */
function collectHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of response.headers) {
    const key = name.toLowerCase();
    if (key === 'content-encoding' || key === 'content-length' || key === 'set-cookie') continue;
    out[key] = value;
  }
  return out;
}

async function fetchOne(
  item: BatchRequestItem,
  index: number,
  request: Request,
  config: ProxyConfig,
  correlationId: string,
  fetchImpl: typeof fetch,
): Promise<BatchResult> {
  // Every target goes through the same resolver the single endpoint uses. Skip
  // it and the batch route becomes a way around the allowlist and the
  // private-network guard.
  const target = resolveTarget(item.url ?? null, config.allowedTargets);
  if (!target.ok) {
    return {
      index,
      issues: [buildIssue(ISSUE.targetRejected, 'Target rejected', target.message, correlationId)],
    };
  }

  const headers = buildUpstreamHeaders(request, target.url);
  for (const [name, value] of Object.entries(item.headers ?? {})) {
    headers.set(name, value);
  }

  try {
    const response = await fetchImpl(target.url.toString(), {
      method: item.method ?? 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });

    return {
      index,
      status: response.status,
      headers: collectHeaders(response),
      body: await response.text(),
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      index,
      issues: [
        buildIssue(
          timedOut ? ISSUE.upstreamTimeout : ISSUE.upstreamUnreachable,
          timedOut ? 'Upstream timed out' : 'Upstream unreachable',
          timedOut
            ? `No response within ${config.upstreamTimeoutMs}ms.`
            : error instanceof Error
              ? error.message
              : String(error),
          correlationId,
        ),
      ],
    };
  }
}

/** Run `work` over every item with a bounded number in flight. */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T, index);
    }
  });

  await Promise.all(workers);
  return results;
}

function readItems(payload: unknown): BatchRequestItem[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const requests = (payload as { requests?: unknown }).requests;
  if (!Array.isArray(requests)) return null;

  return requests.map((entry) =>
    typeof entry === 'string' ? { url: entry } : (entry as BatchRequestItem),
  );
}

export async function handleBatch(
  request: Request,
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const correlationId = correlationIdFor(request);

  // Preflight is answered before auth: browsers don't send x-proxy-key on OPTIONS.
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, config) });
  }

  if (!isAuthorized(request, config.proxyKey)) {
    return failBatch(
      buildIssue(
        ISSUE.authInvalidKey,
        'Not authorized',
        'Missing or invalid x-proxy-key header.',
        correlationId,
      ),
      401,
      request,
      config,
    );
  }

  if (request.method !== 'POST') {
    return failBatch(
      buildIssue(
        ISSUE.batchMalformedBody,
        'Method not allowed',
        'Batch takes POST with a JSON body of { "requests": [...] }.',
        correlationId,
      ),
      405,
      request,
      config,
    );
  }

  let items: BatchRequestItem[] | null;
  try {
    items = readItems(await request.json());
  } catch {
    items = null;
  }

  if (!items) {
    return failBatch(
      buildIssue(
        ISSUE.batchMalformedBody,
        'Malformed batch body',
        'Expected JSON of the form { "requests": ["https://example.com", ...] }.',
        correlationId,
      ),
      400,
      request,
      config,
    );
  }

  if (items.length === 0) {
    return failBatch(
      buildIssue(
        ISSUE.batchEmpty,
        'Empty batch',
        'A batch needs at least one request.',
        correlationId,
      ),
      400,
      request,
      config,
    );
  }

  if (items.length > MAX_BATCH_SIZE) {
    return failBatch(
      buildIssue(
        ISSUE.batchTooLarge,
        'Batch too large',
        `A batch takes at most ${MAX_BATCH_SIZE} requests, got ${items.length}.`,
        correlationId,
      ),
      413,
      request,
      config,
    );
  }

  const results = await mapBounded(items, UPSTREAM_CONCURRENCY, (item, index) =>
    fetchOne(item, index, request, config, correlationId, fetchImpl),
  );

  // 200 even when individual targets failed: the batch itself succeeded, and
  // each result carries its own outcome. A non-2xx here would mean the caller
  // has to guess whether anything at all came back.
  return jsonResponse({ proxy: config.proxyId, correlationId, results }, 200, request, config);
}
