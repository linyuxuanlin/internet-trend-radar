import baseWorker from './index.js';
import { aiAvailabilityStatus, opportunitiesSnapshot } from './api.js';
import { collectAll } from './collector.js';
import { sendDailyDigest } from './email.js';
import { ensureSchema } from './schema.js';

const DEFAULT_AI_QUALITY_ROLLOUT_AT = '2026-08-24T03:33:53.000Z';
const STATIC_SNAPSHOT_MAX_AGE_HOURS = 3;

export async function serveFreshStaticAsset(request, env) {
  if (!env.ASSETS?.fetch) return Response.json({ ready: false, preview: false, error: 'missing assets binding' }, { status: 503 });
  const response = await env.ASSETS.fetch(request);
  if (!response.ok) return Response.json({ ready: false, preview: false, error: 'static snapshot asset is unavailable', upstream_status: response.status }, { status: 503 });
  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return Response.json({ ready: false, preview: false, error: 'static snapshot is not valid JSON' }, { status: 503 });
  }
  const timestamp = Date.parse(String(payload?.generatedAt || ''));
  const ageMs = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || ageMs < -5 * 60 * 1000 || ageMs > STATIC_SNAPSHOT_MAX_AGE_HOURS * 3600000) {
    return Response.json({
      generatedAt: payload?.generatedAt || null,
      ready: false,
      preview: false,
      error: 'static snapshot is stale or has an invalid generatedAt',
      maxAgeHours: STATIC_SNAPSHOT_MAX_AGE_HOURS
    }, { status: 503 });
  }
  return response;
}

export function mergeAIAvailabilityIntoDebug(debug, availability) {
  const payload = debug && typeof debug === 'object' ? debug : {};
  payload.ai = payload.ai && typeof payload.ai === 'object' ? payload.ai : {};

  if (!availability || availability.ok !== true) {
    payload.ai.effective_blocker = payload.ai.blocked_reason || availability?.effective_blocker || 'availability-probe-failed';
    payload.ai.availability_ok = false;
    return payload;
  }

  payload.ai.availability_ok = true;
  payload.ai.effective_blocker = availability.effective_blocker || null;
  payload.ai.provider_quota = availability.provider_quota;
  payload.ai.pacing = availability.pacing;
  payload.ai.available = Boolean(availability.available);
  payload.ai.blocked_reason = availability.effective_blocker || null;
  payload.ai.ready_for_inference = Boolean(availability.available);

  return payload;
}

export function isForbiddenPreviewPath(pathname) {
  return pathname.startsWith('/api/topic/preview-');
}

export function isPreviewPayload(payload) {
  return Boolean(payload && typeof payload === 'object' && payload.preview === true);
}

export async function rejectPreviewResponse(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) return response;

  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }

  if (!isPreviewPayload(payload)) return response;

  return Response.json({
    error: 'preview payloads are disabled in production',
    ready: false,
    preview: false,
    upstream_status: response.status
  }, { status: 503 });
}

export async function aiQualityRolloutStats(env) {
  if (!env.DB) return { ok: false, error: 'missing-db-binding', preview: false };
  const since = env.AI_QUALITY_ROLLOUT_AT || DEFAULT_AI_QUALITY_ROLLOUT_AT;
  if (!Number.isFinite(Date.parse(since))) return { ok: false, error: 'invalid-rollout-timestamp', since, preview: false };
  const model = env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';
  const { results = [] } = await env.DB.prepare(`
    SELECT CASE WHEN success=1 THEN 'success' ELSE COALESCE(failure_reason,'unknown') END AS reason,
           COUNT(*) AS count,
           MAX(attempted_at) AS last_at
      FROM ai_attempts
     WHERE attempted_at >= ? AND model = ?
     GROUP BY reason
     ORDER BY count DESC, reason ASC
  `).bind(since, model).all();
  const attempts = results.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const successes = results.filter(row => row.reason === 'success').reduce((sum, row) => sum + Number(row.count || 0), 0);
  const failures = Math.max(0, attempts - successes);
  return {
    ok: true,
    preview: false,
    since,
    model,
    attempts,
    successes,
    failures,
    success_rate: attempts ? Math.round((successes / attempts) * 1000) / 10 : 0,
    failure_reasons: results.filter(row => row.reason !== 'success').map(row => ({
      reason: row.reason || 'unknown',
      count: Number(row.count || 0),
      last_at: row.last_at || null
    }))
  };
}

export function propagateScheduledFailure(error) {
  console.error('scheduled job failed', error);
  throw error;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (isForbiddenPreviewPath(url.pathname)) {
      return Response.json({ error: 'preview topics are disabled in production', ready: false, preview: false }, { status: 404 });
    }
    if (['/data/dashboard.json', '/data/health.json', '/data/release.json'].includes(url.pathname)) {
      return serveFreshStaticAsset(request, env);
    }
    if (url.pathname === '/api/ai-quality-rollout') {
      try {
        await ensureSchema(env);
        return rejectPreviewResponse(Response.json(await aiQualityRolloutStats(env)));
      } catch (error) {
        return Response.json({ ok: false, preview: false, error: String(error?.message || error) }, { status: 503 });
      }
    }
    if (url.pathname === '/data/opportunities.json') {
      try {
        await ensureSchema(env);
        return opportunitiesSnapshot(env, request);
      } catch (error) {
        return Response.json({ ready: false, status: 'degraded', error: String(error?.message || error), opportunities: [] }, { status: 503 });
      }
    }
    if (url.pathname !== '/api/debug') {
      const response = await baseWorker.fetch(request, env, ctx);
      return url.pathname.startsWith('/api/') ? rejectPreviewResponse(response) : response;
    }

    const response = await baseWorker.fetch(request, env, ctx);
    let debug;
    try {
      debug = await response.clone().json();
    } catch {
      return response;
    }

    try {
      const availability = await aiAvailabilityStatus(env);
      return rejectPreviewResponse(Response.json(mergeAIAvailabilityIntoDebug(debug, availability), { status: response.status }));
    } catch (error) {
      debug.ai = debug.ai && typeof debug.ai === 'object' ? debug.ai : {};
      debug.ai.availability_ok = false;
      debug.ai.effective_blocker = debug.ai.blocked_reason || 'availability-probe-failed';
      debug.ai.availability_error = String(error?.message || error);
      return rejectPreviewResponse(Response.json(debug, { status: response.status }));
    }
  },

  async scheduled(controller, env, ctx) {
    const run = (async () => {
      await ensureSchema(env);
      if (controller.cron === '0 1 * * *') {
        await sendDailyDigest(env);
        return;
      }

      const collection = await collectAll(env);
      console.log('scheduled collection with paced AI enrichment', collection.ai);
      return { collection, ai: collection.ai };
    })();

    ctx.waitUntil(run.catch(propagateScheduledFailure));
  }
};
