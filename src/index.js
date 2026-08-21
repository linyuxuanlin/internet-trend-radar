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

function classifyAIBlocker(ai, schemaOk = true) {
  if (!schemaOk) return 'd1-schema-incomplete';
  if (!ai.binding) return 'missing-ai-binding';
  if (ai.eligible_topics === 0) return 'no-eligible-topics';
  if ((ai.pending_topics || 0) === 0) return null;
  if ((ai.attempted_topics || 0) === 0) return 'inference-not-run';
  if ((ai.verified_topics || 0) === 0) return 'outputs-failed-quality-gate';
  return 'partial-ai-coverage';
}

async function debugStatus(env) {
  const status = {
    db: Boolean(env.DB),
    schema: { ok: false, error: null, tables: {} },
    ai: {
      binding: Boolean(env.AI),
      model: env.AI_MODEL || '@cf/zai-org/glm-4.7-flash',
      eligible_topics: null,
      attempted_topics: null,
      verified_topics: null,
      pending_topics: null,
      stale_topics: null,
      last_updated_at: null,
      ready_for_inference: false,
      blocked_reason: null
    },
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
    status.schema.error = 'missing DB binding';
    status.ai.blocked_reason = env.AI ? 'missing-db-binding' : 'missing-ai-and-db-binding';
    return status;
  }

  const requiredTables = ['sources', 'raw_items', 'topics', 'topic_snapshots', 'topic_sources'];
  try {
    const { results = [] } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${requiredTables.map(() => '?').join(',')}) ORDER BY name`).bind(...requiredTables).all();
    const present = new Set(results.map(row => row.name));
    for (const table of requiredTables) status.schema.tables[table] = present.has(table);
    status.schema.ok = requiredTables.every(table => status.schema.tables[table]);
    if (!status.schema.ok) {
      status.schema.error = `missing tables: ${requiredTables.filter(table => !status.schema.tables[table]).join(', ')}`;
      status.ai.blocked_reason = classifyAIBlocker(status.ai, false);
      return status;
    }
  } catch (err) {
    status.schema.error = String(err?.message || err);
    status.error = `schema probe failed: ${status.schema.error}`;
    status.ai.blocked_reason = 'd1-schema-probe-failed';
    return status;
  }

  try {
    const [raw, topics, sources, healthy, failed, lastSuccess, errors, aiEligible, aiAttempted, aiVerified, aiStale, aiLastUpdated] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as count FROM raw_items').first(),
      env.DB.prepare('SELECT COUNT(*) as count FROM topics').first(),
      env.DB.prepare('SELECT COUNT(*) as count FROM sources').first(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM sources WHERE last_success_at IS NOT NULL AND (last_error_at IS NULL OR last_success_at >= last_error_at)`).first(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM sources WHERE last_error_at IS NOT NULL AND (last_success_at IS NULL OR last_error_at > last_success_at)`).first(),
      env.DB.prepare('SELECT MAX(last_success_at) as value FROM sources').first(),
      env.DB.prepare(`SELECT id,last_error,last_error_at FROM sources WHERE last_error IS NOT NULL ORDER BY last_error_at DESC LIMIT 6`).all(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM topics WHERE current_score >= 45`).first(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM topics WHERE current_score >= 45 AND ai_updated_at IS NOT NULL`).first(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM topics
        WHERE current_score >= 45
          AND ai_updated_at IS NOT NULL
          AND length(trim(COALESCE(ai_summary,''))) >= 20
          AND length(trim(COALESCE(ai_why_now,''))) >= 20
          AND ai_opportunities_json IS NOT NULL AND ai_opportunities_json != '[]'
          AND ai_summary NOT LIKE '%值得关注%' AND ai_summary NOT LIKE '%热度较高%' AND ai_summary NOT LIKE '%持续升温%'
          AND ai_summary NOT LIKE '%具有重要意义%' AND ai_summary NOT LIKE '%前景广阔%' AND ai_summary NOT LIKE '%机会巨大%'
          AND ai_why_now NOT LIKE '%值得关注%' AND ai_why_now NOT LIKE '%热度较高%' AND ai_why_now NOT LIKE '%持续升温%'
          AND ai_why_now NOT LIKE '%具有重要意义%' AND ai_why_now NOT LIKE '%前景广阔%' AND ai_why_now NOT LIKE '%机会巨大%'`).first(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM topics WHERE current_score >= 45 AND ai_updated_at IS NOT NULL AND julianday(ai_updated_at) < julianday('now','-6 hours')`).first(),
      env.DB.prepare(`SELECT MAX(ai_updated_at) as value FROM topics WHERE ai_updated_at IS NOT NULL`).first()
    ]);

    status.raw_items = Number(raw?.count || 0);
    status.topics = Number(topics?.count || 0);
    status.sources = Number(sources?.count || 0);
    status.healthy_sources = Number(healthy?.count || 0);
    status.failed_sources = Number(failed?.count || 0);
    status.last_success_at = lastSuccess?.value || null;
    status.recent_errors = errors?.results || [];
    status.ai.eligible_topics = Number(aiEligible?.count || 0);
    status.ai.attempted_topics = Number(aiAttempted?.count || 0);
    status.ai.verified_topics = Number(aiVerified?.count || 0);
    status.ai.pending_topics = Math.max(0, status.ai.eligible_topics - status.ai.verified_topics);
    status.ai.stale_topics = Number(aiStale?.count || 0);
    status.ai.last_updated_at = aiLastUpdated?.value || null;
    status.ai.ready_for_inference = status.ai.binding && status.ai.eligible_topics > 0 && status.ai.pending_topics > 0;
    status.ai.blocked_reason = classifyAIBlocker(status.ai, true);
    status.ready = status.raw_items > 0 && status.topics > 0 && status.healthy_sources > 0;
  } catch (err) {
    status.error = String(err?.message || err);
    status.ai.blocked_reason = 'ai-readiness-query-failed';
  }
  return status;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Debug/health must remain reachable even when D1 schema initialization is the failing dependency.
    if (url.pathname === '/api/debug') {
      return Response.json(await debugStatus(env));
    }
    if (url.pathname === '/api/health') {
      return routeApi(env, request);
    }

    // Non-dashboard APIs require D1 and should fail explicitly when schema bootstrap fails.
    // The dashboard is handled separately below so its verified real Pages fallback stays available.
    if (url.pathname.startsWith('/api/') && env.DB && url.pathname !== '/api/dashboard') {
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
      // A freshly auto-provisioned D1 is empty. Bootstrap the schema before the first
      // readiness query so the Worker can actually self-start and collect real data.
      // If D1 itself is broken, keep the error non-fatal here: routeApi() can still
      // serve the separately CI-gated GitHub Pages real snapshot fallback.
      if (env.DB) {
        try {
          await ensureSchema(env);
        } catch (err) {
          console.error('dashboard D1 schema bootstrap failed; trying real snapshot fallback', err);
        }
      }
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
