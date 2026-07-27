/**
 * One shape for everything that went wrong, wherever it went wrong.
 *
 * Errors and warnings share an array and a shape because they share a need:
 * something to branch on, something to show a human, and something to quote
 * when asking for help. Splitting them across fields makes a consumer look in
 * two places for one moment in a request.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  /** `{domain}.{class}.{reason}`, broadest first. Parse by prefix, not equality. */
  issue: string;
  severity: Severity;
  /** Echoes the caller's X-Correlation-ID when they sent one. */
  correlationId: string;
  dateTime: string;
  message?: { title: string; detail: string };
}

/**
 * Deliberately a plain string rather than an enum. The taxonomy will grow, and
 * an exhaustive switch over an enum turns every new code into a breaking change
 * for consumers.
 */
export const ISSUE = {
  authInvalidKey: 'proxy.auth.invalid_key',
  batchMalformedBody: 'batch.validation.malformed_body',
  batchEmpty: 'batch.validation.empty',
  batchTooLarge: 'batch.validation.too_large',
  targetRejected: 'batch.request.invalid_target',
  upstreamTimeout: 'batch.upstream.timeout',
  upstreamUnreachable: 'batch.upstream.unreachable',
} as const;

/** Reuse the caller's correlation id when given one, so their logs line up with ours. */
export function correlationIdFor(request: Request): string {
  return request.headers.get('x-correlation-id')?.trim() || crypto.randomUUID();
}

export function buildIssue(
  issue: string,
  title: string,
  detail: string,
  correlationId: string,
  severity: Severity = 'error',
): Issue {
  return {
    issue,
    severity,
    correlationId,
    dateTime: new Date().toISOString(),
    message: { title, detail },
  };
}
