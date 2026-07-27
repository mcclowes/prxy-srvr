import { ConfigError, loadConfig } from '../src/config.js';
import { handleProxy } from '../src/proxy.js';

export const config = { maxDuration: 30 };

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleProxy(request, loadConfig());
    } catch (error) {
      if (error instanceof ConfigError) {
        return Response.json({ error: error.message }, { status: 503 });
      }
      throw error;
    }
  },
};
