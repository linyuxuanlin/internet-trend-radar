import { routeApi } from './api.js';
import { collectAll } from './collector.js';
import { sendDailyDigest } from './email.js';
import { ensureSchema } from './schema.js';

async function ensureInitialData(env) {
  if (!env.DB) return { ok: false, reason: 'missing-db' };
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) as count FROM topics').first();
    if (row && Number(row.count || 0) > 0) return { ok: true, existing: Number(row.count) };
    const result = await collectAll(env);
    const after = await env.DB.prepare('SELECT COUNT(*) as count FROM topics').first();
    const topics = Number(after?.count || 0);
    return { ok: topics > 0, collected: result, topics };
  } catch (err) {
    console.error('initial collection failed', err);
    return { ok: false, error: String(err?.message || err) };
  }
}

async function debugStatus(env) {
  const status = {
    db: Boolean(env.DB),
    ready: false,
    raw_items: null,
    topics: null,
    sources: null,
    healthy_sources: null,
    failed_sources: null,
    last_success_at: null,
    recent_errors: [],
    error: null,
    generatedAt: new Date().toISOString()
  };
  if (!env.DB) {
    status.error = 'missing DB binding';
    return status;
  }

  try {
    const [raw, topics, sources, healthy, failed, lastSuccess, errors] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as count FROM raw_items').first(),
      env.DB.prepare('SELECT COUNT(*) as count FROM topics').first(),
      env.DB.prepare('SELECT COUNT(*) as count FROM sources').first(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM sources WHERE last_success_at IS NOT NULL AND (last_error_at IS NULL OR last_success_at >= last_error_at)`).first(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM sources WHERE last_error_at IS NOT NULL AND (last_success_at IS NULL OR last_error_at > last_success_at)`).first(),
      env.DB.prepare('SELECT MAX(last_success_at) as value FROM sources').first(),
      env.DB.prepare(`SELECT id,last_error,last_error_at FROM sources WHERE last_error IS NOT NULL ORDER BY last_error_at DESC LIMIT 6`).all()
    ]);

    status.raw_items = Number(raw?.count || 0);
    status.topics = Number(topics?.count || 0);
    status.sources = Number(sources?.count || 0);
    status.healthy_sources = Number(healthy?.count || 0);
    status.failed_sources = Number(failed?.count || 0);
    status.last_success_at = lastSuccess?.value || null;
    status.recent_errors = errors?.results || [];
    status.ready = status.raw_items > 0 && status.topics > 0 && status.healthy_sources > 0;
  } catch (err) {
    status.error = String(err?.message || err);
  }
  return status;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/') && env.DB) {
      try {
        await ensureSchema(env);
      } catch (err) {
        console.error('D1 schema initialization failed', err);
        return Response.json({
          ok: false,
          ready: false,
          error: `D1 schema initialization failed: ${String(err?.message || err)}`,
          generatedAt: new Date().toISOString()
        }, { status: 503 });
      }
    }

    if (url.pathname === '/api/debug') {
      return Response.json(await debugStatus(env));
    }

    if (url.pathname === '/api/bootstrap' && request.method === 'POST') {
      try {
        const result = await collectAll(env);
        const status = await debugStatus(env);
        if (!status.ready) {
          return Response.json({ ok: false, error: 'collection finished but real-data readiness check failed', result, status }, { status: 503 });
        }
        return Response.json({ ok: true, result, status });
      } catch (err) {
        return Response.json({ ok: false, error: String(err?.message || err), status: await debugStatus(env) }, { status: 503 });
      }
    }

    if (url.pathname === '/api/dashboard') {
      await ensureInitialData(env);
    }

    if (url.pathname.startsWith('/api/')) return routeApi(env, request);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      if (controller.cron === '5 0 * * *') {
        await sendDailyDigest(env);
        return;
      }
      await collectAll(env);
    })().catch(err => console.error('scheduled job failed', err)));
  }
};
