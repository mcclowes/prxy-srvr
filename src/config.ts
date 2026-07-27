export type ProxyConfig = {
  proxyKey: string;
  proxyId: string;
  allowedTargets: string[];
  allowedOrigins: string[];
  upstreamTimeoutMs: number;
};

export class ConfigError extends Error {
  readonly name = 'ConfigError';
}

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

const readInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): ProxyConfig {
  const proxyKey = env.PROXY_KEY?.trim();

  if (!proxyKey) {
    throw new ConfigError(
      'PROXY_KEY is not set. The proxy refuses to run without one, so it never ends up open to the internet.',
    );
  }

  return {
    proxyKey,
    proxyId: env.PROXY_ID?.trim() || 'unnamed',
    allowedTargets: splitList(env.ALLOWED_TARGETS),
    allowedOrigins: splitList(env.ALLOWED_ORIGINS),
    upstreamTimeoutMs: readInt(env.UPSTREAM_TIMEOUT_MS, 20_000),
  };
}
