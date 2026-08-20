import { routeApi } from './api.js';
import { collectAll } from './collector.js';
import { sendDailyDigest } from './email.js';

async function ensureInitialData(env) {
  if (!env.DB) return { ok: false, reason: 'missing-db' };
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) as count FROM topics').first();
    if (row && Number(row.count || 0) > 0) {
      return { ok: true, existing: Number(row.count) };
    }

    const result = await collectAll(env);
    const after = await env.DB.prepare('SELECT COUNT(*) as count FROM topics').first();
    return {
      ok: true,
      collected: result,
      topics: Number(after?.count || 0)
    };
  } catch (err) {
    console.error('initial collection failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

async function debugStatus(env) {
  const status = {
    db: Boolean(env.DB),
    raw_items: null,
    topics: null,
    sources: null,
    error: null,
    generatedAt: new Date().toISOString()
  };

  if (!env.DB) return status;

  try {
    const [raw, topics, sources] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as count FROM raw_items').first(),
      env.DB.prepare('SELECT COUNT(*) as count FROM topics').first(),
      env.DB.prepare('SELECT COUNT(*) as count FROM sources').first()
    ]);
    status.raw_items = Number(raw?.count || 0);
    status.topics = Number(topics?.count || 0);
    status.sources = Number(sources?.count || 0);
  } catch (err) {
    status.error = String(err?.message || err);
  }

  return status;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/debug') {
      return Response.json(await debugStatus(env));
    }

    if (url.pathname === '/api/dashboard') {
      const init = await ensureInitialData(env);
      request.cfInitStatus = init;
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
