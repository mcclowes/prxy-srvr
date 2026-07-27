import { describe, expect, it, vi } from 'vitest';
import { handleBatch, MAX_BATCH_SIZE } from './batch.js';
import { loadConfig, type ProxyConfig } from './config.js';

const configWith = (env: Record<string, string> = {}): ProxyConfig =>
  loadConfig({ PROXY_KEY: 'secret', PROXY_ID: 'prxy-a', ...env });

const batchRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://proxy.test/batch', {
    method: 'POST',
    headers: { 'x-proxy-key': 'secret', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

interface BatchIssue {
  issue: string;
}

interface BatchResultBody {
  index: number;
  status?: number;
  body?: string;
  issues?: BatchIssue[];
}

interface BatchBody {
  proxy: string;
  correlationId?: string;
  results: BatchResultBody[];
  issues?: BatchIssue[];
}

const readBody = async (response: Response): Promise<BatchBody> =>
  (await response.json()) as BatchBody;

/** Typed stand-in for fetch, so mock.calls keeps its argument types. */
const mockFetch = (impl: (url: string) => Response) =>
  vi.fn(async (input: string | URL, _init?: RequestInit) => impl(String(input)));

const okFetch = (body = '{"ok":true}') =>
  vi.fn(
    async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
  );

describe('handleBatch', () => {
  it('fetches every target and returns them in request order', async () => {
    const upstream = mockFetch((url) => new Response(`body for ${url}`, { status: 200 }));

    const response = await handleBatch(
      batchRequest({
        requests: ['https://a.example.com/1', 'https://b.example.com/2'],
      }),
      configWith(),
      upstream as unknown as typeof fetch,
    );

    expect(response.status).toBe(200);
    const payload = await readBody(response);
    expect(payload.results.map((r: { index: number }) => r.index)).toEqual([0, 1]);
    expect(payload.results[0]?.body).toContain('a.example.com/1');
    expect(payload.results[1]?.body).toContain('b.example.com/2');
  });

  it('accepts objects as well as bare URL strings', async () => {
    const upstream = okFetch();

    const response = await handleBatch(
      batchRequest({ requests: [{ url: 'https://a.example.com/1', method: 'GET' }] }),
      configWith(),
      upstream as unknown as typeof fetch,
    );

    expect((await readBody(response)).results[0]?.status).toBe(200);
  });

  // An upstream that answers 403 is a result, not a failure of ours. The caller
  // needs the status to decide whether to retry that one target.
  it('reports an upstream error status as a result, not an issue', async () => {
    const upstream = mockFetch(() => new Response('nope', { status: 403 }));

    const response = await handleBatch(
      batchRequest({ requests: ['https://a.example.com/1'] }),
      configWith(),
      upstream as unknown as typeof fetch,
    );

    const [result] = (await readBody(response)).results;
    expect(result?.status).toBe(403);
    expect(result?.issues).toBeUndefined();
  });

  it('carries on when one target fails, so a batch is not all-or-nothing', async () => {
    const upstream = mockFetch((url) => {
      if (url.includes('bad')) throw new Error('ECONNREFUSED');
      return new Response('fine', { status: 200 });
    });

    const response = await handleBatch(
      batchRequest({
        requests: ['https://a.example.com/bad', 'https://a.example.com/good'],
      }),
      configWith(),
      upstream as unknown as typeof fetch,
    );

    const { results } = await readBody(response);
    expect(results[0]?.issues?.[0]?.issue).toBe('batch.upstream.unreachable');
    expect(results[1]?.status).toBe(200);
  });

  // The single-target route refuses private hosts and honours the allowlist.
  // A batch route that skipped either would be a way straight around both.
  it('applies the private-host guard to every target', async () => {
    const upstream = okFetch();

    const response = await handleBatch(
      batchRequest({ requests: ['http://169.254.169.254/latest/meta-data/'] }),
      configWith(),
      upstream as unknown as typeof fetch,
    );

    const [result] = (await readBody(response)).results;
    expect(result?.issues?.[0]?.issue).toBe('batch.request.invalid_target');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('applies the target allowlist to every target', async () => {
    const upstream = okFetch();

    const response = await handleBatch(
      batchRequest({
        requests: ['https://allowed.example.com/x', 'https://elsewhere.example.com/y'],
      }),
      configWith({ ALLOWED_TARGETS: 'allowed.example.com' }),
      upstream as unknown as typeof fetch,
    );

    const { results } = await readBody(response);
    expect(results[0]?.status).toBe(200);
    expect(results[1]?.issues?.[0]?.issue).toBe('batch.request.invalid_target');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('refuses an unauthenticated batch', async () => {
    const upstream = okFetch();

    const response = await handleBatch(
      new Request('https://proxy.test/batch', {
        method: 'POST',
        body: JSON.stringify({ requests: ['https://a.example.com'] }),
      }),
      configWith(),
      upstream as unknown as typeof fetch,
    );

    expect(response.status).toBe(401);
    expect((await readBody(response)).issues?.[0]?.issue).toBe('proxy.auth.invalid_key');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('answers preflight before asking for a key', async () => {
    const response = await handleBatch(
      new Request('https://proxy.test/batch', { method: 'OPTIONS' }),
      configWith(),
      okFetch() as unknown as typeof fetch,
    );

    expect(response.status).toBe(204);
  });

  it.each([
    [{ requests: [] }, 400, 'batch.validation.empty'],
    [{ nope: true }, 400, 'batch.validation.malformed_body'],
  ])('rejects %j with %i', async (body, status, issue) => {
    const response = await handleBatch(
      batchRequest(body),
      configWith(),
      okFetch() as unknown as typeof fetch,
    );

    expect(response.status).toBe(status);
    expect((await readBody(response)).issues?.[0]?.issue).toBe(issue);
  });

  it('rejects a batch over the size cap rather than trying to answer it', async () => {
    const requests = Array.from(
      { length: MAX_BATCH_SIZE + 1 },
      (_, i) => `https://a.example.com/${i}`,
    );

    const response = await handleBatch(
      batchRequest({ requests }),
      configWith(),
      okFetch() as unknown as typeof fetch,
    );

    expect(response.status).toBe(413);
    expect((await readBody(response)).issues?.[0]?.issue).toBe('batch.validation.too_large');
  });

  it('echoes the callerʼs correlation id so their logs line up with ours', async () => {
    const response = await handleBatch(
      batchRequest({ requests: ['https://a.example.com'] }, { 'x-correlation-id': 'abc-123' }),
      configWith(),
      okFetch() as unknown as typeof fetch,
    );

    expect((await readBody(response)).correlationId).toBe('abc-123');
  });

  it('does not leak the callerʼs address to the upstream', async () => {
    const upstream = mockFetch(() => new Response('ok', { status: 200 }));

    await handleBatch(
      batchRequest(
        { requests: ['https://a.example.com'] },
        { forwarded: 'for=203.0.113.7', 'x-forwarded-for': '203.0.113.7' },
      ),
      configWith(),
      upstream as unknown as typeof fetch,
    );

    const sent = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(sent.get('forwarded')).toBeNull();
    expect(sent.get('x-forwarded-for')).toBeNull();
  });
});
