import { describe, expect, it } from 'vitest';
import { extractTarget, resolveTarget } from './target.js';

const extract = (url: string) => extractTarget(new URL(url, 'https://proxy.test'));

describe('extractTarget', () => {
  it('reads the cors-anywhere style path', () => {
    expect(extract('/https://api.example.com/foo')).toBe('https://api.example.com/foo');
  });

  it('repairs the slash Vercel collapses out of the path', () => {
    expect(extract('/https:/api.example.com/foo')).toBe('https://api.example.com/foo');
  });

  it('carries the query string through to the target', () => {
    expect(extract('/https://api.example.com/foo?a=1&b=2')).toBe(
      'https://api.example.com/foo?a=1&b=2',
    );
  });

  it('prefers an explicit url param', () => {
    expect(extract('/?url=https%3A%2F%2Fapi.example.com%2Ffoo%3Fa%3D1')).toBe(
      'https://api.example.com/foo?a=1',
    );
  });

  it('returns null at the root', () => {
    expect(extract('/')).toBeNull();
  });
});

describe('resolveTarget', () => {
  it('accepts a public https target', () => {
    const result = resolveTarget('https://api.example.com/foo', []);
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects a missing target with 400', () => {
    expect(resolveTarget(null, [])).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects an unparseable target with 400', () => {
    expect(resolveTarget('not-a-url', [])).toMatchObject({ ok: false, status: 400 });
  });

  it.each(['file:///etc/passwd', 'ftp://example.com', 'gopher://example.com'])(
    'rejects the %s protocol',
    (raw) => {
      expect(resolveTarget(raw, [])).toMatchObject({ ok: false, status: 400 });
    },
  );

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://metadata.google.internal/',
    'http://db.internal/',
    'http://printer.local/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
  ])('blocks the private target %s', (raw) => {
    expect(resolveTarget(raw, [])).toMatchObject({ ok: false, status: 403 });
  });

  it('allows public addresses that merely look adjacent to private ranges', () => {
    expect(resolveTarget('http://172.32.0.1/', [])).toMatchObject({ ok: true });
    expect(resolveTarget('http://11.0.0.1/', [])).toMatchObject({ ok: true });
  });

  it('enforces an exact-host allowlist', () => {
    expect(resolveTarget('https://api.example.com/', ['api.example.com'])).toMatchObject({
      ok: true,
    });
    expect(resolveTarget('https://evil.com/', ['api.example.com'])).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('matches wildcard allowlist entries against subdomains and the apex', () => {
    const allowlist = ['*.example.com'];
    expect(resolveTarget('https://api.example.com/', allowlist)).toMatchObject({ ok: true });
    expect(resolveTarget('https://example.com/', allowlist)).toMatchObject({ ok: true });
    expect(resolveTarget('https://notexample.com/', allowlist)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('is case insensitive about the host', () => {
    expect(resolveTarget('https://API.Example.COM/', ['api.example.com'])).toMatchObject({
      ok: true,
    });
  });
});
