import { handleBatch } from '../src/batch.js';
import { ConfigError, loadConfig } from '../src/config.js';

// Longer than the single-target route: one invocation now waits on a whole
// batch of upstream requests rather than one.
export const config = { maxDuration: 60 };

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleBatch(request, loadConfig());
    } catch (error) {
      if (error instanceof ConfigError) {
        return Response.json({ error: error.message }, { status: 503 });
      }
      throw error;
    }
  },
};
