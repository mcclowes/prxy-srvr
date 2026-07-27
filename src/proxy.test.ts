import { describe, expect, it, vi } from 'vitest';
import { loadConfig, type ProxyConfig } from './config.js';
import { handleProxy } from './proxy.js';

const KEY = 'test-key';

const configWith = (env: Record<string, string> = {}): ProxyConfig =>
  loadConfig({ PROXY_KEY: KEY, PROXY_ID: 'proxy-a', ...env });

const authed = (url: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { 'x-proxy-key': KEY, ...(init.headers ?? {}) } });

const stubFetch = (response: Response) => vi.fn<typeof fetch>().mockResolvedValue(response);

describe('auth', () => {
  it('answers preflight without a key, because browsers cannot send one', async () => {
    const upstream = stubFetch(new Response('should not be called'));
    const response = await handleProxy(
      new Request('https://proxy.test/https://api.example.com/', { method: 'OPTIONS' }),
      configWith(),
      upstream,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['no key', {}],
    ['a wrong key', { 'x-proxy-key': 'nope' }],
    ['a key of the wrong length', { 'x-proxy-key': 'test-key-longer' }],
  ])('rejects a request with %s', async (_label, headers) => {
    const upstream = stubFetch(new Response('should not be called'));
    const response = await handleProxy(
      new Request('https://proxy.test/https://api.example.com/', { headers }),
      configWith(),
      upstream,
    );

    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('proxying', () => {
  it('passes the upstream status, body, and headers back', async () => {
    const upstream = stubFetch(
      new Response('{"ok":true}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await handleProxy(
      authed('https://proxy.test/https://api.example.com/things'),
      configWith(),
      upstream,
    );

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"ok":true}');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-proxy-id')).toBe('proxy-a');
    expect(upstream.mock.calls[0]?.[0]?.toString()).toBe('https://api.example.com/things');
  });

  it('forwards the method and body', async () => {
    const upstream = stubFetch(new Response(null, { status: 204 }));

    await handleProxy(
      authed('https://proxy.test/https://api.example.com/things', {
        method: 'POST',
        body: '{"name":"x"}',
        headers: { 'content-type': 'application/json' },
      }),
      configWith(),
      upstream,
    );

    const init = upstream.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).not.toBeUndefined();
  });

  it('does not send a body on GET', async () => {
    const upstream = stubFetch(new Response('ok'));
    await handleProxy(
      authed('https://proxy.test/https://api.example.com/'),
      configWith(),
      upstream,
    );
    expect(upstream.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it('refuses a target outside the allowlist before calling out', async () => {
    const upstream = stubFetch(new Response('should not be called'));
    const response = await handleProxy(
      authed('https://proxy.test/https://evil.com/'),
      configWith({ ALLOWED_TARGETS: 'api.example.com' }),
      upstream,
    );

    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('explains itself at the root instead of proxying nothing', async () => {
    const response = await handleProxy(
      authed('https://proxy.test/'),
      configWith(),
      stubFetch(new Response('should not be called')),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ proxy: 'proxy-a' });
  });
});

describe('redirects', () => {
  it('routes the redirect back through the proxy so the allowlist still applies', async () => {
    const upstream = stubFetch(
      new Response(null, { status: 302, headers: { location: '/moved' } }),
    );

    const response = await handleProxy(
      authed('https://proxy.test/https://api.example.com/old'),
      configWith(),
      upstream,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `https://proxy.test/?url=${encodeURIComponent('https://api.example.com/moved')}`,
    );
  });

  it('resolves an absolute redirect target', async () => {
    const upstream = stubFetch(
      new Response(null, {
        status: 301,
        headers: { location: 'https://other.example.com/new' },
      }),
    );

    const response = await handleProxy(
      authed('https://proxy.test/https://api.example.com/old'),
      configWith(),
      upstream,
    );

    expect(response.headers.get('location')).toBe(
      `https://proxy.test/?url=${encodeURIComponent('https://other.example.com/new')}`,
    );
  });
});

describe('upstream failures', () => {
  it('reports a timeout as 504', async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));

    const response = await handleProxy(
      authed('https://proxy.test/https://api.example.com/'),
      configWith(),
      upstream,
    );

    expect(response.status).toBe(504);
  });

  it('reports an unreachable upstream as 502', async () => {
    const upstream = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await handleProxy(
      authed('https://proxy.test/https://api.example.com/'),
      configWith(),
      upstream,
    );

    expect(response.status).toBe(502);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});
