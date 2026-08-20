import { routeApi } from './api.js';
import { collectAll } from './collector.js';
import { sendDailyDigest } from './email.js';

async function ensureInitialData(env) {
  if (!env.DB) return;
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) as count FROM topics').first();
    if (!row || Number(row.count || 0) === 0) {
      await collectAll(env);
    }
  } catch (err) {
    console.error('initial collection failed', err);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/dashboard') {
      await ensureInitialData(env);
    }
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
