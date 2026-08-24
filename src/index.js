import { routeApi } from './api.js';
import { collectAll } from './collector.js';
import { enrichTopTopics } from './ai.js';
import { sendDailyDigest } from './email.js';
import { ensureSchema } from './schema.js';
import { safeJsonParse } from './utils.js';
import { officialMetricUpstreamPredicate } from './source-metadata.js';

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
  if (ai.quota_exhausted) return 'daily-ai-quota-exhausted';
  if ((ai.attempted_topics || 0) === 0) return 'inference-not-run';
  if ((ai.verified_topics || 0) === 0) return 'outputs-failed-quality-gate';
  return 'partial-ai-coverage';
}

function captureBootstrapError(schemaStatus, err) {
  schemaStatus.bootstrap_ok = false;
  schemaStatus.bootstrap_error = String(err?.message || err);
  schemaStatus.bootstrap_error_code = err?.code || null;
  schemaStatus.bootstrap_failed_statement_index = Number.isFinite(Number(err?.statementIndex)) ? Number(err.statementIndex) : null;
  schemaStatus.bootstrap_statement_count = Number.isFinite(Number(err?.statementCount)) ? Number(err.statementCount) : null;
  schemaStatus.bootstrap_failed_statement = err?.statementPreview || null;
  schemaStatus.bootstrap_cause = err?.causeMessage || String(err?.cause?.message || '') || null;
}

function summarizeModelAttempts(rows) {
  const byModel = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const model = String(row?.model || 'unknown');
    const reason = String(row?.reason || 'unknown');
    const count = Number(row?.count || 0);
    if (!byModel.has(model)) byModel.set(model, { model, attempts: 0, successes: 0, failures: 0, success_rate: 0, last_at: null, failure_reasons: [] });
    const item = byModel.get(model);
    item.attempts += count;
    if (reason === 'success') item.successes += count;
    else {
      item.failures += count;
      item.failure_reasons.push({ reason, count, last_at: row?.last_at || null });
    }
    if (!item.last_at || (row?.last_at && row.last_at > item.last_at)) item.last_at = row?.last_at || item.last_at;
  }
  return [...byModel.values()]
    .map(item => ({
      ...item,
      success_rate: item.attempts ? Math.round((item.successes / item.attempts) * 1000) / 10 : 0,
      failure_reasons: item.failure_reasons.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 6)
    }))
    .sort((a, b) => b.attempts - a.attempts || a.model.localeCompare(b.model));
}

function summarizeReasonWindow(rows) {
  const reasonRows = Array.isArray(rows) ? rows : [];
  const attempts = reasonRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const successes = reasonRows.filter(row => row.reason === 'success').reduce((sum, row) => sum + Number(row.count || 0), 0);
  return {
    attempts,
    successes,
    failures: Math.max(0, attempts - successes),
    failure_reasons: reasonRows.filter(row => row.reason !== 'success').slice(0, 8).map(row => ({
      reason: row.reason || 'unknown',
      count: Number(row.count || 0),
      last_at: row.last_at || null
    }))
  };
}

function buildAttemptReasonsProbe(env, hours, byModel = false) {
  const group = byModel ? 'model, reason' : 'reason';
  const selectModel = byModel ? 'model, ' : '';
  return Promise.resolve()
    .then(() => env.DB.prepare(`SELECT ${selectModel}CASE WHEN success=1 THEN 'success' ELSE COALESCE(failure_reason,'unknown') END AS reason, COUNT(*) AS count, MAX(attempted_at) AS last_at FROM ai_attempts WHERE julianday(attempted_at) >= julianday('now','-${hours} hours') GROUP BY ${group} ORDER BY ${byModel ? 'model ASC, ' : ''}count DESC, reason ASC`).all())
    .catch(() => ({ results: [] }));
}

function buildDailyQuotaProbe(env) {
  return Promise.resolve()
    .then(() => env.DB.prepare(`
      SELECT attempted_at, failure_reason FROM ai_attempts
      WHERE success=0
        AND (failure_reason LIKE 'inference-error:quota-or-capacity%' OR failure_reason LIKE 'fallback-inference-error:quota-or-capacity%')
        AND substr(attempted_at,1,10)=substr(datetime('now'),1,10)
      ORDER BY attempted_at DESC LIMIT 1
    `).first())
    .catch(() => null);
}

function nextUtcDayIso(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

async function debugStatus(env) {
  const status = {
    db: Boolean(env.DB),
    schema: {
      ok: false,
      error: null,
      tables: {},
      bootstrap_attempted: false,
      bootstrap_ok: null,
      bootstrap_error: null,
      bootstrap_error_code: null,
      bootstrap_failed_statement_index: null,
      bootstrap_statement_count: null,
      bootstrap_failed_statement: null,
      bootstrap_cause: null
    },
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
      blocked_reason: null,
      quota_exhausted: false,
      quota_detected_at: null,
      quota_retry_after: null,
      quota_failure_reason: null,
      recent_attempts_1h: 0,
      recent_successes_1h: 0,
      recent_failures_1h: 0,
      recent_failure_reasons_1h: [],
      model_stats_1h: [],
      recent_attempts_24h: 0,
      recent_successes_24h: 0,
      recent_failures_24h: 0,
      recent_failure_reasons: [],
      model_stats_24h: []
    },
    ready: false,
    raw_items: null,
    data_quality: {
      raw_items_missing_upstream: null,
      raw_items_invalid_upstream: null,
      raw_items_missing_heat: null,
      raw_items_missing_engagement: null,
      metric_path_violations: {
        heat: null,
        engagement: null
      },
      contract_violations: {
        heat: null,
        engagement: null,
        heat_path: null,
        engagement_path: null
      },
      ok: null
    },
    topics: null,
    sources: null,
    healthy_sources: null,
    stale_sources: null,
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

  status.schema.bootstrap_attempted = true;
  try {
    await ensureSchema(env);
    status.schema.bootstrap_ok = true;
  } catch (err) {
    captureBootstrapError(status.schema, err);
  }

  const requiredTables = ['sources', 'raw_items', 'topics', 'topic_snapshots', 'topic_sources'];
  try {
    const { results = [] } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${requiredTables.map(() => '?').join(',')}) ORDER BY name`).bind(...requiredTables).all();
    const present = new Set(results.map(row => row.name));
    for (const table of requiredTables) status.schema.tables[table] = present.has(table);
    status.schema.ok = requiredTables.every(table => status.schema.tables[table]);
    if (!status.schema.ok) {
      status.schema.error = `missing tables: ${requiredTables.filter(table => !status.schema.tables[table]).join(', ')}`;
      if (status.schema.bootstrap_error) status.schema.error += `; bootstrap failed: ${status.schema.bootstrap_error}`;
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
    const attemptedProbe = Promise.resolve()
      .then(() => env.DB.prepare(`SELECT COUNT(*) as count FROM topics WHERE current_score >= 45 AND ai_updated_at IS NOT NULL`).first())
      .catch(() => ({ count: null }));
    const quotaProbe = buildDailyQuotaProbe(env);
    const attemptReasons1hProbe = buildAttemptReasonsProbe(env, 1, false);
    const modelReasons1hProbe = buildAttemptReasonsProbe(env, 1, true);
    const attemptReasons24hProbe = buildAttemptReasonsProbe(env, 24, false);
    const modelReasons24hProbe = buildAttemptReasonsProbe(env, 24, true);
    const [raw, topics, sources, healthy, stale, failed, lastSuccess, errors, aiEligible, aiAttempted, aiVerified, aiStale, aiLastUpdated, aiQuota, aiAttemptReasons1h, aiModelReasons1h, aiAttemptReasons24h, aiModelReasons24h] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as count FROM raw_items').first(),
      env.DB.prepare('SELECT COUNT(*) as count FROM topics').first(),
      env.DB.prepare('SELECT COUNT(*) as count FROM sources').first(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM sources WHERE enabled=1 AND last_success_at IS NOT NULL AND julianday(last_success_at) >= julianday('now','-2 hours') AND (last_error_at IS NULL OR last_success_at >= last_error_at)`).first(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM sources WHERE enabled=1 AND last_success_at IS NOT NULL AND julianday(last_success_at) < julianday('now','-2 hours') AND (last_error_at IS NULL OR last_success_at >= last_error_at)`).first(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM sources WHERE enabled=1 AND last_error_at IS NOT NULL AND (last_success_at IS NULL OR last_success_at <= last_error_at)`).first(),
      env.DB.prepare('SELECT MAX(CASE WHEN enabled=1 THEN last_success_at END) as value FROM sources').first(),
      env.DB.prepare(`SELECT id,last_error,last_error_at FROM sources WHERE last_error IS NOT NULL ORDER BY last_error_at DESC LIMIT 6`).all(),
      env.DB.prepare(`SELECT COUNT(*) as count FROM topics WHERE current_score >= 45`).first(),
      attemptedProbe,
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
      env.DB.prepare(`SELECT MAX(ai_updated_at) as value FROM topics WHERE ai_updated_at IS NOT NULL`).first(),
      quotaProbe,
      attemptReasons1hProbe,
      modelReasons1hProbe,
      attemptReasons24hProbe,
      modelReasons24hProbe
    ]);

    status.raw_items = Number(raw?.count || 0);
    const provenance = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN json_extract(raw_json,'$.trendRadarUpstream') IS NULL OR length(trim(json_extract(raw_json,'$.trendRadarUpstream'))) = 0 THEN 1 ELSE 0 END) AS missing_upstream,
        SUM(CASE WHEN json_extract(raw_json,'$.trendRadarUpstream') IS NOT NULL
                  AND json_extract(raw_json,'$.trendRadarUpstream') NOT LIKE 'https://%'
                  AND json_extract(raw_json,'$.trendRadarUpstream') NOT LIKE 'xiaohongshu-mcp:%' THEN 1 ELSE 0 END) AS invalid_upstream,
        SUM(CASE WHEN heat IS NULL THEN 1 ELSE 0 END) AS missing_heat,
        SUM(CASE WHEN engagement IS NULL THEN 1 ELSE 0 END) AS missing_engagement,
        SUM(CASE WHEN heat IS NOT NULL AND (json_extract(raw_json,'$.trendRadarMetrics.heat_path') IS NULL OR length(trim(json_extract(raw_json,'$.trendRadarMetrics.heat_path'))) = 0) THEN 1 ELSE 0 END) AS heat_path_violations,
        SUM(CASE WHEN engagement IS NOT NULL AND (json_extract(raw_json,'$.trendRadarMetrics.engagement_path') IS NULL OR length(trim(json_extract(raw_json,'$.trendRadarMetrics.engagement_path'))) = 0) THEN 1 ELSE 0 END) AS engagement_path_violations
      FROM raw_items
    `).first().catch(() => null);
    status.data_quality = {
      raw_items_missing_upstream: Number(provenance?.missing_upstream || 0),
      raw_items_invalid_upstream: Number(provenance?.invalid_upstream || 0),
      raw_items_missing_heat: Number(provenance?.missing_heat || 0),
      raw_items_missing_engagement: Number(provenance?.missing_engagement || 0),
      metric_path_violations: {
        heat: Number(provenance?.heat_path_violations || 0),
        engagement: Number(provenance?.engagement_path_violations || 0)
      },
      contract_violations: { heat: 0, engagement: 0 },
      ok: true
    };
    let sourceMetricRows = [];
    let sourceMetricProbeOk = true;
    try {
      const result = await env.DB.prepare(`
        SELECT s.id,s.name,s.region,s.kind,s.enabled,s.metadata_json,
               COUNT(r.id) AS raw_items,
               SUM(CASE WHEN r.id IS NOT NULL AND r.heat IS NULL THEN 1 ELSE 0 END) AS missing_heat,
               SUM(CASE WHEN r.id IS NOT NULL AND r.engagement IS NULL THEN 1 ELSE 0 END) AS missing_engagement,
               SUM(CASE WHEN r.id IS NOT NULL AND r.heat = 0 THEN 1 ELSE 0 END) AS zero_heat,
               SUM(CASE WHEN r.id IS NOT NULL AND r.engagement = 0 THEN 1 ELSE 0 END) AS zero_engagement,
               SUM(CASE WHEN r.id IS NOT NULL AND json_type(s.metadata_json,'$.heat') = 'null' AND r.heat IS NOT NULL THEN 1 ELSE 0 END) AS contract_heat_violations,
               SUM(CASE WHEN r.id IS NOT NULL AND json_type(s.metadata_json,'$.engagement') = 'null' AND r.engagement IS NOT NULL THEN 1 ELSE 0 END) AS contract_engagement_violations,
               SUM(CASE WHEN r.id IS NOT NULL AND r.heat IS NOT NULL AND ${officialMetricUpstreamPredicate('s.id')}
                         AND json_extract(r.raw_json,'$.trendRadarMetrics.heat_path') != json_extract(s.metadata_json,'$.heat') THEN 1 ELSE 0 END) AS definition_heat_path_violations,
               SUM(CASE WHEN r.id IS NOT NULL AND r.engagement IS NOT NULL AND ${officialMetricUpstreamPredicate('s.id')}
                         AND json_extract(r.raw_json,'$.trendRadarMetrics.engagement_path') != json_extract(s.metadata_json,'$.engagement') THEN 1 ELSE 0 END) AS definition_engagement_path_violations,
               SUM(CASE WHEN r.id IS NOT NULL AND r.heat IS NOT NULL AND (json_extract(r.raw_json,'$.trendRadarMetrics.heat_path') IS NULL OR length(trim(json_extract(r.raw_json,'$.trendRadarMetrics.heat_path'))) = 0) THEN 1 ELSE 0 END) AS heat_path_violations,
               SUM(CASE WHEN r.id IS NOT NULL AND r.engagement IS NOT NULL AND (json_extract(r.raw_json,'$.trendRadarMetrics.engagement_path') IS NULL OR length(trim(json_extract(r.raw_json,'$.trendRadarMetrics.engagement_path'))) = 0) THEN 1 ELSE 0 END) AS engagement_path_violations,
               COUNT(DISTINCT CASE WHEN json_extract(r.raw_json,'$.trendRadarUpstream') IS NOT NULL
                                    THEN json_extract(r.raw_json,'$.trendRadarUpstream') END) AS upstream_count,
               MAX(r.captured_at) AS latest_captured_at
          FROM sources s
          LEFT JOIN raw_items r ON r.source_id = s.id
         GROUP BY s.id,s.name,s.region,s.kind,s.enabled,s.metadata_json
         ORDER BY s.enabled DESC,s.region,s.id
      `).all();
      sourceMetricRows = result?.results || [];
    } catch (error) {
      console.warn('source metric quality probe failed; keeping debug endpoint available', error);
      sourceMetricProbeOk = false;
    }
    status.source_metric_quality = sourceMetricRows.map(row => ({
      id: row.id,
      name: row.name,
      region: row.region,
      kind: row.kind,
      enabled: Boolean(Number(row.enabled ?? 1)),
      metric_definition: safeJsonParse(row.metadata_json, null),
      raw_items: Number(row.raw_items || 0),
      missing_heat: Number(row.missing_heat || 0),
      missing_engagement: Number(row.missing_engagement || 0),
      zero_heat: Number(row.zero_heat || 0),
      zero_engagement: Number(row.zero_engagement || 0),
      contract_heat_violations: Number(row.contract_heat_violations || 0),
      contract_engagement_violations: Number(row.contract_engagement_violations || 0),
      definition_heat_path_violations: Number(row.definition_heat_path_violations || 0),
      definition_engagement_path_violations: Number(row.definition_engagement_path_violations || 0),
      heat_path_violations: Number(row.heat_path_violations || 0),
      engagement_path_violations: Number(row.engagement_path_violations || 0),
      upstream_count: Number(row.upstream_count || 0),
      latest_captured_at: row.latest_captured_at || null
    }));
    const contractHeatViolations = sourceMetricRows.reduce((sum, row) => sum + Number(row.contract_heat_violations || 0), 0);
    const contractEngagementViolations = sourceMetricRows.reduce((sum, row) => sum + Number(row.contract_engagement_violations || 0), 0);
    const definitionHeatPathViolations = sourceMetricRows.reduce((sum, row) => sum + Number(row.definition_heat_path_violations || 0), 0);
    const definitionEngagementPathViolations = sourceMetricRows.reduce((sum, row) => sum + Number(row.definition_engagement_path_violations || 0), 0);
    status.data_quality.contract_violations = {
      heat: contractHeatViolations,
      engagement: contractEngagementViolations,
      heat_path: definitionHeatPathViolations,
      engagement_path: definitionEngagementPathViolations
    };
    status.data_quality.ok = (
      sourceMetricProbeOk &&
      status.data_quality.raw_items_missing_upstream === 0 &&
      status.data_quality.raw_items_invalid_upstream === 0 &&
      status.data_quality.metric_path_violations.heat === 0 &&
      status.data_quality.metric_path_violations.engagement === 0 &&
      contractHeatViolations === 0 &&
      contractEngagementViolations === 0
      && definitionHeatPathViolations === 0
      && definitionEngagementPathViolations === 0
    );
    status.topics = Number(topics?.count || 0);
    status.sources = Number(sources?.count || 0);
    status.healthy_sources = Number(healthy?.count || 0);
    status.stale_sources = Number(stale?.count || 0);
    status.failed_sources = Number(failed?.count || 0);
    status.last_success_at = lastSuccess?.value || null;
    status.recent_errors = errors?.results || [];
    status.ai.eligible_topics = Number(aiEligible?.count || 0);
    status.ai.verified_topics = Number(aiVerified?.count || 0);
    const attemptedCount = aiAttempted?.count == null ? status.ai.verified_topics : Number(aiAttempted.count || 0);
    status.ai.attempted_topics = Math.max(status.ai.verified_topics, attemptedCount);
    status.ai.pending_topics = Math.max(0, status.ai.eligible_topics - status.ai.verified_topics);
    status.ai.stale_topics = Number(aiStale?.count || 0);
    status.ai.last_updated_at = aiLastUpdated?.value || null;
    if (aiQuota?.attempted_at) {
      status.ai.quota_exhausted = true;
      status.ai.quota_detected_at = aiQuota.attempted_at;
      status.ai.quota_retry_after = nextUtcDayIso();
      status.ai.quota_failure_reason = aiQuota.failure_reason || 'inference-error:quota-or-capacity';
    }

    const oneHour = summarizeReasonWindow(aiAttemptReasons1h?.results || []);
    status.ai.recent_attempts_1h = oneHour.attempts;
    status.ai.recent_successes_1h = oneHour.successes;
    status.ai.recent_failures_1h = oneHour.failures;
    status.ai.recent_failure_reasons_1h = oneHour.failure_reasons;
    status.ai.model_stats_1h = summarizeModelAttempts(aiModelReasons1h?.results || []);

    const day = summarizeReasonWindow(aiAttemptReasons24h?.results || []);
    status.ai.recent_attempts_24h = day.attempts;
    status.ai.recent_successes_24h = day.successes;
    status.ai.recent_failures_24h = day.failures;
    status.ai.recent_failure_reasons = day.failure_reasons;
    status.ai.model_stats_24h = summarizeModelAttempts(aiModelReasons24h?.results || []);

    status.ai.ready_for_inference = status.ai.binding && status.ai.eligible_topics > 0 && status.ai.pending_topics > 0 && !status.ai.quota_exhausted;
    status.ai.blocked_reason = classifyAIBlocker(status.ai, true);
    status.ready = status.raw_items > 0 && status.topics > 0 && status.healthy_sources > 0 && status.data_quality.ok === true;
  } catch (err) {
    status.error = String(err?.message || err);
    status.ai.blocked_reason = 'ai-readiness-query-failed';
  }
  return status;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/debug') {
      return Response.json(await debugStatus(env));
    }
    if (url.pathname === '/api/health') {
      return routeApi(env, request);
    }

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
      if (env.DB) {
        try {
          await ensureSchema(env);
        } catch (err) {
          console.error('dashboard D1 schema bootstrap failed; trying real snapshot fallback', err);
        }
      }
      // Dashboard reads must be side-effect free. Collection and AI enrichment
      // are owned by the scheduled/admin paths so monitoring, users, or crawlers
      // cannot start competing D1 rebuilds or spend the AI budget by reading.
    }

    if (url.pathname.startsWith('/api/')) return routeApi(env, request);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      if (controller.cron === '0 1 * * *') {
        await sendDailyDigest(env);
        return;
      }
      const collection = await collectAll(env);
      if (!env.AI) {
        console.warn('scheduled AI backfill skipped: missing AI binding');
        return { collection, ai: { skipped: true, reason: 'missing-ai-binding' } };
      }
      try {
        const ai = await enrichTopTopics(env, { backfillOnly: true });
        console.log('scheduled AI backfill', ai);
        return { collection, ai };
      } catch (err) {
        console.error('scheduled AI backfill failed; real collection already completed', err);
        return { collection, ai: { failed: true, error: String(err?.message || err) } };
      }
    })().catch(err => console.error('scheduled job failed', err)));
  }
};
