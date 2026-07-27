import { describe, expect, it } from 'vitest';
import { loadConfig, type ProxyConfig } from './config.js';
import { buildResponseHeaders, buildUpstreamHeaders, corsHeaders } from './headers.js';

const configWith = (env: Record<string, string> = {}): ProxyConfig =>
  loadConfig({ PROXY_KEY: 'secret', PROXY_ID: 'proxy-a', ...env });

const target = new URL('https://api.example.com/foo');

describe('buildUpstreamHeaders', () => {
  it('forwards authorization so callers can reach authenticated upstreams', () => {
    const request = new Request('https://proxy.test/', {
      headers: { authorization: 'Bearer upstream-token', 'content-type': 'application/json' },
    });

    const headers = buildUpstreamHeaders(request, target);
    expect(headers.get('authorization')).toBe('Bearer upstream-token');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('strips cookies, our own key, and infrastructure headers', () => {
    const request = new Request('https://proxy.test/', {
      headers: {
        cookie: 'session=abc',
        'x-proxy-key': 'secret',
        'x-vercel-id': 'lhr1::abc',
        'x-forwarded-host': 'proxy.test',
        connection: 'keep-alive',
        'accept-encoding': 'br',
      },
    });

    const headers = buildUpstreamHeaders(request, target);
    for (const name of [
      'cookie',
      'x-proxy-key',
      'x-vercel-id',
      'x-forwarded-host',
      'connection',
      'accept-encoding',
    ]) {
      expect(headers.get(name), name).toBeNull();
    }
  });

  it('rewrites host to the target', () => {
    const request = new Request('https://proxy.test/', { headers: { host: 'proxy.test' } });
    expect(buildUpstreamHeaders(request, target).get('host')).toBe('api.example.com');
  });
});

describe('corsHeaders', () => {
  it('allows any origin when no allowlist is set', () => {
    const request = new Request('https://proxy.test/', { headers: { origin: 'https://any.com' } });
    expect(corsHeaders(request, configWith()).get('access-control-allow-origin')).toBe('*');
  });

  it('echoes an allowlisted origin and refuses the rest', () => {
    const config = configWith({ ALLOWED_ORIGINS: 'https://app.example.com' });

    const allowed = new Request('https://proxy.test/', {
      headers: { origin: 'https://app.example.com' },
    });
    expect(corsHeaders(allowed, config).get('access-control-allow-origin')).toBe(
      'https://app.example.com',
    );

    const denied = new Request('https://proxy.test/', { headers: { origin: 'https://evil.com' } });
    expect(corsHeaders(denied, config).get('access-control-allow-origin')).toBeNull();
  });

  it('reflects requested headers on preflight and tags the deployment', () => {
    const request = new Request('https://proxy.test/', {
      headers: { 'access-control-request-headers': 'x-custom, x-proxy-key' },
    });

    const headers = corsHeaders(request, configWith());
    expect(headers.get('access-control-allow-headers')).toBe('x-custom, x-proxy-key');
    expect(headers.get('x-proxy-id')).toBe('proxy-a');
    expect(headers.get('vary')).toContain('origin');
  });
});

describe('buildResponseHeaders', () => {
  it('drops set-cookie and stale encoding headers from the upstream', () => {
    const upstream = new Response('hi', {
      headers: {
        'set-cookie': 'session=abc',
        'content-encoding': 'gzip',
        'content-type': 'text/plain',
        'x-ratelimit-remaining': '42',
      },
    });

    const headers = buildResponseHeaders(
      upstream,
      new Request('https://proxy.test/'),
      configWith(),
    );
    expect(headers.get('set-cookie')).toBeNull();
    expect(headers.get('content-encoding')).toBeNull();
    expect(headers.get('content-type')).toBe('text/plain');
    expect(headers.get('x-ratelimit-remaining')).toBe('42');
  });

  it('overrides an upstream CORS header with ours', () => {
    const upstream = new Response('hi', {
      headers: { 'access-control-allow-origin': 'https://somewhere-else.com' },
    });

    const headers = buildResponseHeaders(
      upstream,
      new Request('https://proxy.test/'),
      configWith(),
    );
    expect(headers.get('access-control-allow-origin')).toBe('*');
  });
});
