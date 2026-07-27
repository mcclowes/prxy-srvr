export type TargetResult = { ok: true; url: URL } | { ok: false; status: number; message: string };

/**
 * Vercel's router collapses `//` in a path, so `/https://x.com` arrives as
 * `/https:/x.com`. Put the slash back.
 */
const repairScheme = (raw: string): string => raw.replace(/^(https?):\/{1,2}/i, '$1://');

/** Reads the target from `?url=`, falling back to the cors-anywhere-style path. */
export function extractTarget(requestUrl: URL): string | null {
  const fromQuery = requestUrl.searchParams.get('url');
  if (fromQuery) return fromQuery.trim();

  const path = requestUrl.pathname.slice(1);
  if (!path) return null;

  return repairScheme(path + requestUrl.search);
}

const PRIVATE_V4 =
  /^(?:0|10|127)\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\.|^192\.168\.|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa'];

const BLOCKED_EXACT = new Set(['localhost', 'metadata.google.internal', 'instance-data']);

/**
 * `::ffff:127.0.0.1` is normalized to `::ffff:7f00:1` by the URL parser, so an
 * IPv4-mapped address has to be read back out of the hex groups.
 */
function mappedIpv4(inner: string): string | null {
  const dotted = inner.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) return dotted[1];

  const hex = inner.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex?.[1] || !hex[2]) return null;

  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (BLOCKED_EXACT.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (PRIVATE_V4.test(host)) return true;

  // URL.hostname keeps IPv6 in brackets.
  if (host.startsWith('[')) {
    const inner = host.slice(1, -1);
    // Loopback, unique-local (fc00::/7), and link-local (fe80::/10).
    if (inner === '::1' || inner === '::' || /^(?:f[cd]|fe[89ab])/.test(inner)) return true;

    const mapped = mappedIpv4(inner);
    if (mapped && PRIVATE_V4.test(mapped)) return true;
  }

  return false;
}

/** Matches `example.com` exactly, and `*.example.com` against any subdomain. */
function matchesAllowlist(hostname: string, allowedTargets: string[]): boolean {
  const host = hostname.toLowerCase();

  return allowedTargets.some((pattern) =>
    pattern.startsWith('*.')
      ? host === pattern.slice(2) || host.endsWith(pattern.slice(1))
      : host === pattern,
  );
}

export function resolveTarget(raw: string | null, allowedTargets: string[]): TargetResult {
  if (!raw) {
    return {
      ok: false,
      status: 400,
      message: 'No target URL. Use /https://example.com/path or /?url=https%3A%2F%2Fexample.com.',
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, status: 400, message: `Not a valid URL: ${raw}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, status: 400, message: `Unsupported protocol: ${url.protocol}` };
  }

  if (isPrivateHost(url.hostname)) {
    return { ok: false, status: 403, message: 'Target host is private or link-local.' };
  }

  if (allowedTargets.length > 0 && !matchesAllowlist(url.hostname, allowedTargets)) {
    return { ok: false, status: 403, message: `Target host is not allowlisted: ${url.hostname}` };
  }

  return { ok: true, url };
}
