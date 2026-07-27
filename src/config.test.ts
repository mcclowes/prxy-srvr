import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('refuses to run without a key, so the proxy is never accidentally open', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ PROXY_KEY: '   ' })).toThrow(ConfigError);
  });

  it('applies defaults around a bare key', () => {
    expect(loadConfig({ PROXY_KEY: 'secret' })).toEqual({
      proxyKey: 'secret',
      proxyId: 'unnamed',
      allowedTargets: [],
      allowedOrigins: [],
      upstreamTimeoutMs: 20_000,
    });
  });

  it('normalizes comma separated lists', () => {
    const config = loadConfig({
      PROXY_KEY: 'secret',
      ALLOWED_TARGETS: ' API.Example.com , *.other.com ,, ',
      ALLOWED_ORIGINS: 'https://App.Example.com',
    });

    expect(config.allowedTargets).toEqual(['api.example.com', '*.other.com']);
    expect(config.allowedOrigins).toEqual(['https://app.example.com']);
  });

  it('falls back when the timeout env var is unusable', () => {
    expect(loadConfig({ PROXY_KEY: 'secret', UPSTREAM_TIMEOUT_MS: 'soon' }).upstreamTimeoutMs).toBe(
      20_000,
    );
    expect(loadConfig({ PROXY_KEY: 'secret', UPSTREAM_TIMEOUT_MS: '-1' }).upstreamTimeoutMs).toBe(
      20_000,
    );
    expect(loadConfig({ PROXY_KEY: 'secret', UPSTREAM_TIMEOUT_MS: '5000' }).upstreamTimeoutMs).toBe(
      5000,
    );
  });
});
