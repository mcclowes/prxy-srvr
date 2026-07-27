import { loadConfig } from '../src/config.js';

/**
 * Unauthenticated on purpose: the consuming project health-checks this before
 * it has a reason to hold a key. It reports posture, never secrets.
 */
export default {
  fetch(): Response {
    try {
      const config = loadConfig();
      return Response.json({
        ok: true,
        id: config.proxyId,
        region: process.env.VERCEL_REGION ?? 'local',
        targetsAllowlisted: config.allowedTargets.length,
        originsAllowlisted: config.allowedOrigins.length,
      });
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 503 },
      );
    }
  },
};
