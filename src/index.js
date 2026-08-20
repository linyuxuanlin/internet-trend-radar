import { routeApi } from './api.js';
import { collectAll } from './collector.js';
import { sendDailyDigest } from './email.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return routeApi(env, request);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    if (controller.cron === '5 0 * * *') {
      ctx.waitUntil(sendDailyDigest(env).catch(err => console.error('daily digest failed', err)));
      return;
    }
    ctx.waitUntil(collectAll(env).catch(err => console.error('collection failed', err)));
  }
};
