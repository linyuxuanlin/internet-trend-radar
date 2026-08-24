import { json, fingerprintTitle, safeJsonParse, categoryFor } from './utils.js';
import { collectAll, ingestExternal } from './collector.js';
import { isStoredAIValid, isStoredAIUsable } from './ai.js';
import { currentSourcePredicate, SOURCE_FRESHNESS_HOURS } from './source-health.js';
import { officialMetricUpstreamPredicate } from './source-metadata.js';

const DEFAULT_REAL_DASHBOARD_FALLBACK = 'https://linyuxuanlin.github.io/internet-trend-radar/data/dashboard.json';
const DEFAULT_AI_REFRESH_HOURS = 6;
const DATA_CONTRACT = {
  raw_fields: ['rank', 'heat', 'engagement', 'captured_at', 'raw_json.trendRadarUpstream', 'raw_json.trendRadarMetrics', 'observed_upstreams', 'peak_evidence'],
  raw_field_semantics: 'heat and engagement are source-native values; null means the source did not provide that metric; peak_evidence also retains the selected metric path',
  derived_fields: ['trend_score', 'current_score', 'breakout_score'],
  derived_score_method: 'within-source current-window rank_score*0.72 + within-source current-24h heat_percentile*24 + engagement_percentile*18; then source_weight*0.82, cross-source coverage bonus (log2(source_count)*10, max 25), persistence bonus (log2(mentions)*3, max 12), clamped to 0-100; raw platform counters are never compared across sources',
  breakout_score_method: '42 + score_delta*2.4 + new_source_delta*13 + log2(mention_delta+1)*7 + novelty*0.65, clamped to 0-100',
  provenance_requirement: 'every persisted raw item must include a valid HTTPS upstream or a registered external-bridge identifier',
  metric_provenance_requirement: 'a non-null heat or engagement value must include its raw.trendRadarMetrics field path; null means unavailable, not zero',
  source_kind_semantics: 'raw_signals.source_kind and peak_evidence.source_kind are derived from the observed upstream for that evidence, not copied from the current source status',
  coverage_semantics: 'ready means at least one real topic exists; coverage.active_* reports the actual enabled source scope'
};

function notReady(error, extra = {}) {
  return {
    generatedAt: new Date().toISOString(),
    ready: false,
    preview: false,
    error,
    topics: [],
    categories: [],
    timeline: [],
    sources: [],
    ...extra
  };
}

async function loadRawSignals(env, topics) {
  const ids = [...new Set((topics || []).map(topic => String(topic?.id || topic?.fingerprint || '')).filter(Boolean))];
  if (!env.DB || !ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const { results = [] } = await env.DB.prepare(`
    WITH scoped AS (
      SELECT r.* FROM raw_items r
       JOIN sources active_source ON active_source.id = r.source_id
        AND ${currentSourcePredicate('active_source')}
       WHERE fingerprint IN (${placeholders})
         AND julianday(captured_at) >= julianday('now','-24 hours')
    ), latest AS (
      SELECT fingerprint, source_id, MAX(captured_at) AS latest_captured_at
        FROM scoped
       GROUP BY fingerprint, source_id
    ), heat_peaks AS (
      SELECT fingerprint, source_id, captured_at AS peak_captured_at,
             json_extract(raw_json, '$.trendRadarUpstream') AS peak_upstream,
             json_extract(raw_json, '$.trendRadarMetrics.heat_path') AS peak_metric_path,
             CASE
               WHEN source_id='xiaohongshu' OR json_extract(raw_json,'$.trendRadarUpstream') LIKE 'xiaohongshu-mcp:%' THEN 'external-bridge'
               WHEN json_extract(raw_json,'$.trendRadarUpstream') LIKE '%api-hot.imsyy.top%' OR json_extract(raw_json,'$.trendRadarUpstream') LIKE '%api.guole.fun%' THEN 'aggregator-fallback'
               WHEN json_extract(raw_json,'$.trendRadarUpstream') LIKE '%aa1.cn%' OR json_extract(raw_json,'$.trendRadarUpstream') LIKE '%luochen.sbs%' OR json_extract(raw_json,'$.trendRadarUpstream') LIKE '%fanyia.cn%' THEN 'mirror-fallback'
               WHEN source_id='36kr' AND json_extract(raw_json,'$.trendRadarUpstream') LIKE 'https://www.36kr.com/feed%' THEN 'official-rss'
               WHEN source_id IN ('hackernews','github','weibo','zhihu','douyin','v2ex','juejin','36kr','bilibili') THEN 'official-api'
               ELSE 'source-api'
             END AS peak_kind
        FROM (
          SELECT fingerprint, source_id, captured_at, raw_json,
                 ROW_NUMBER() OVER (PARTITION BY fingerprint, source_id ORDER BY heat DESC, captured_at DESC) AS peak_row
            FROM scoped
           WHERE heat IS NOT NULL
        )
       WHERE peak_row = 1
    ), engagement_peaks AS (
      SELECT fingerprint, source_id, captured_at AS peak_captured_at,
             json_extract(raw_json, '$.trendRadarUpstream') AS peak_upstream,
             json_extract(raw_json, '$.trendRadarMetrics.engagement_path') AS peak_metric_path,
             CASE
               WHEN source_id='xiaohongshu' OR json_extract(raw_json,'$.trendRadarUpstream') LIKE 'xiaohongshu-mcp:%' THEN 'external-bridge'
               WHEN json_extract(raw_json,'$.trendRadarUpstream') LIKE '%api-hot.imsyy.top%' OR json_extract(raw_json,'$.trendRadarUpstream') LIKE '%api.guole.fun%' THEN 'aggregator-fallback'
               WHEN json_extract(raw_json,'$.trendRadarUpstream') LIKE '%aa1.cn%' OR json_extract(raw_json,'$.trendRadarUpstream') LIKE '%luochen.sbs%' OR json_extract(raw_json,'$.trendRadarUpstream') LIKE '%fanyia.cn%' THEN 'mirror-fallback'
               WHEN source_id='36kr' AND json_extract(raw_json,'$.trendRadarUpstream') LIKE 'https://www.36kr.com/feed%' THEN 'official-rss'
               WHEN source_id IN ('hackernews','github','weibo','zhihu','douyin','v2ex','juejin','36kr','bilibili') THEN 'official-api'
               ELSE 'source-api'
             END AS peak_kind
        FROM (
          SELECT fingerprint, source_id, captured_at, raw_json,
                 ROW_NUMBER() OVER (PARTITION BY fingerprint, source_id ORDER BY engagement DESC, captured_at DESC) AS peak_row
            FROM scoped
           WHERE engagement IS NOT NULL
        )
       WHERE peak_row = 1
    )
    SELECT r.fingerprint AS topic_id,
           r.source_id,
           COALESCE(s.name, r.source_id) AS source_name,
           MAX(CASE WHEN r.captured_at = latest.latest_captured_at THEN CASE
             WHEN r.source_id='xiaohongshu' OR json_extract(r.raw_json,'$.trendRadarUpstream') LIKE 'xiaohongshu-mcp:%' THEN 'external-bridge'
             WHEN json_extract(r.raw_json,'$.trendRadarUpstream') LIKE '%api-hot.imsyy.top%' OR json_extract(r.raw_json,'$.trendRadarUpstream') LIKE '%api.guole.fun%' THEN 'aggregator-fallback'
             WHEN json_extract(r.raw_json,'$.trendRadarUpstream') LIKE '%aa1.cn%' OR json_extract(r.raw_json,'$.trendRadarUpstream') LIKE '%luochen.sbs%' OR json_extract(r.raw_json,'$.trendRadarUpstream') LIKE '%fanyia.cn%' THEN 'mirror-fallback'
             WHEN r.source_id='36kr' AND json_extract(r.raw_json,'$.trendRadarUpstream') LIKE 'https://www.36kr.com/feed%' THEN 'official-rss'
             WHEN r.source_id IN ('hackernews','github','weibo','zhihu','douyin','v2ex','juejin','36kr','bilibili') THEN 'official-api'
             ELSE 'source-api' END END) AS source_kind,
           COALESCE(s.weight, 1) AS source_weight,
           s.metadata_json,
           MAX(r.heat) AS raw_heat_max,
           MAX(r.engagement) AS raw_engagement_max,
           MAX(CASE WHEN r.captured_at = latest.latest_captured_at THEN r.heat END) AS raw_heat_latest,
           MAX(CASE WHEN r.captured_at = latest.latest_captured_at THEN r.engagement END) AS raw_engagement_latest,
           MIN(COALESCE(r.rank, 999)) AS best_rank,
           COUNT(*) AS observations,
           json_group_array(DISTINCT json_extract(r.raw_json, '$.trendRadarUpstream')) AS observed_upstreams,
           latest.latest_captured_at,
           heat_peaks.peak_captured_at AS heat_peak_captured_at,
           heat_peaks.peak_upstream AS heat_peak_upstream,
           heat_peaks.peak_metric_path AS heat_peak_metric_path,
           heat_peaks.peak_kind AS heat_peak_kind,
           engagement_peaks.peak_captured_at AS engagement_peak_captured_at,
           engagement_peaks.peak_upstream AS engagement_peak_upstream,
           engagement_peaks.peak_metric_path AS engagement_peak_metric_path,
           engagement_peaks.peak_kind AS engagement_peak_kind,
           MAX(CASE WHEN r.captured_at = latest.latest_captured_at
                    THEN COALESCE(json_extract(r.raw_json, '$.trendRadarUpstream'), '') END) AS upstream,
           MAX(CASE WHEN r.captured_at = latest.latest_captured_at
                    THEN json_extract(r.raw_json, '$.trendRadarMetrics.heat_path') END) AS heat_metric_path,
           MAX(CASE WHEN r.captured_at = latest.latest_captured_at
                    THEN json_extract(r.raw_json, '$.trendRadarMetrics.engagement_path') END) AS engagement_metric_path
      FROM scoped r
      LEFT JOIN sources s ON s.id = r.source_id
      JOIN latest ON latest.fingerprint = r.fingerprint
                 AND latest.source_id = r.source_id
      LEFT JOIN heat_peaks ON heat_peaks.fingerprint = r.fingerprint
                          AND heat_peaks.source_id = r.source_id
      LEFT JOIN engagement_peaks ON engagement_peaks.fingerprint = r.fingerprint
                                AND engagement_peaks.source_id = r.source_id
     GROUP BY r.fingerprint, r.source_id, s.name, s.weight, s.metadata_json, latest.latest_captured_at,
              heat_peaks.peak_captured_at, heat_peaks.peak_upstream, heat_peaks.peak_metric_path, heat_peaks.peak_kind,
              engagement_peaks.peak_captured_at, engagement_peaks.peak_upstream, engagement_peaks.peak_metric_path, engagement_peaks.peak_kind
  `).bind(...ids).all();
  const byTopic = new Map();
  for (const row of results) {
    const list = byTopic.get(row.topic_id) || [];
    list.push({
      source_id: row.source_id,
      source_name: row.source_name,
      source_kind: row.source_kind || null,
      source_weight: Number(row.source_weight || 1),
      metric_definition: safeJsonParse(row.metadata_json, null),
      raw_heat_max: row.raw_heat_max == null ? null : Number(row.raw_heat_max),
      raw_engagement_max: row.raw_engagement_max == null ? null : Number(row.raw_engagement_max),
      raw_heat_latest: row.raw_heat_latest == null ? null : Number(row.raw_heat_latest),
      raw_engagement_latest: row.raw_engagement_latest == null ? null : Number(row.raw_engagement_latest),
      best_rank: Number(row.best_rank || 0),
      observations: Number(row.observations || 0),
      observed_upstreams: (safeJsonParse(row.observed_upstreams, []) || []).filter(Boolean),
      latest_captured_at: row.latest_captured_at || null,
      peak_evidence: {
        heat: row.heat_peak_captured_at || row.heat_peak_upstream ? {
          captured_at: row.heat_peak_captured_at || null,
          upstream: row.heat_peak_upstream || null,
          metric_path: row.heat_peak_metric_path || null,
          source_kind: row.heat_peak_kind || null
        } : null,
        engagement: row.engagement_peak_captured_at || row.engagement_peak_upstream ? {
          captured_at: row.engagement_peak_captured_at || null,
          upstream: row.engagement_peak_upstream || null,
          metric_path: row.engagement_peak_metric_path || null,
          source_kind: row.engagement_peak_kind || null
        } : null
      },
      upstream: row.upstream || null,
      metric_paths: {
        heat: row.heat_peak_metric_path || row.heat_metric_path || null,
        engagement: row.engagement_peak_metric_path || row.engagement_metric_path || null
      },
      units: 'source-native; not comparable across platforms'
    });
    byTopic.set(row.topic_id, list);
  }
  return byTopic;
}

function publicTopic(topic, rawSignals = [], aiRefreshHours = DEFAULT_AI_REFRESH_HOURS) {
  const qualityValid = isStoredAIValid(topic);
  const aiUsable = isStoredAIUsable(topic, aiRefreshHours);
  const publicData = aiUsable ? { ...topic, opportunities: safeJsonParse(topic.ai_opportunities_json, []) || [] } : {
    ...topic,
    ai_summary: null,
    ai_why_now: null,
    ai_risks: null,
    opportunities: [],
    ai_verified: false
  };
  return {
    ...publicData,
    ai_status: aiUsable ? 'verified' : qualityValid ? 'stale' : 'unavailable',
    ai_freshness_hours: Number(aiRefreshHours),
    trend_score: Number(topic.current_score || 0),
    score_semantics: 'derived trend index; not an upstream platform heat value',
    score_method: DATA_CONTRACT.derived_score_method,
    raw_signals: rawSignals
  };
}

function hasCompleteCurrentEvidence(topic, rawSignals = []) {
  const expected = Math.max(1, Number(topic?.source_count || 1));
  return Array.isArray(rawSignals) && rawSignals.length >= expected;
}

function publicSource(source) {
  const { metadata_json, ...publicData } = source;
  const enabled = source.enabled === undefined ? true : Boolean(Number(source.enabled));
  const hasSuccess = Boolean(source.last_success_at);
  const hasError = Boolean(source.last_error_at && (!source.last_success_at || source.last_error_at >= source.last_success_at));
  const ageHours = hasSuccess ? Math.max(0, (Date.now() - Date.parse(source.last_success_at)) / 3600000) : null;
  const freshness_status = !enabled ? 'disabled' : hasError ? 'error' : !hasSuccess ? 'pending' : ageHours > SOURCE_FRESHNESS_HOURS ? 'stale' : 'healthy';
  const currentUpstream = hasError ? null : source.latest_upstream || null;
  const currentUpstreamCapturedAt = hasError ? null : source.latest_upstream_captured_at || null;
  return {
    ...publicData,
    latest_upstream: currentUpstream,
    latest_upstream_captured_at: currentUpstreamCapturedAt,
    enabled,
    metric_definition: safeJsonParse(metadata_json, null),
    last_error: freshness_status === 'disabled'
      ? (source.last_error || 'disabled: not enabled in current collector configuration')
      : freshness_status === 'stale' && !source.last_error ? `stale: no successful update within ${SOURCE_FRESHNESS_HOURS}h` : source.last_error,
    freshness_status,
    freshness_hours: ageHours == null ? null : Number(ageHours.toFixed(2))
  };
}

function nextBudgetReleaseIso(now = new Date()) {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.toISOString();
}

function nextUtcDayIso(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

export async function aiBudgetStatus(env, now = new Date()) {
  if (!env.DB) return { ok: false, error: 'missing DB binding' };
  const dailyBudget = Math.max(24, Math.min(240, Number(env.AI_DAILY_MODEL_CALL_BUDGET || 96)));
  const maxCallsPerTopic = env.AI_DISABLE_FALLBACK === '1' ? 1 : 2;
  const utcHour = now.getUTCHours();
  const cumulativeBudget = Math.ceil(dailyBudget * (utcHour + 1) / 24);
  const row = await env.DB.prepare(`
    SELECT count(*) AS attempts FROM ai_attempts
    WHERE substr(attempted_at,1,10)=substr(datetime('now'),1,10)
  `).first();
  const attemptsToday = Math.max(0, Number(row?.attempts || 0));
  const remainingHeadroom = Math.max(0, cumulativeBudget - attemptsToday);
  const remainingDaily = Math.max(0, dailyBudget - attemptsToday);
  const topicHeadroom = Math.floor(remainingHeadroom / maxCallsPerTopic);
  return {
    ok: true,
    generatedAt: now.toISOString(),
    timezone: 'UTC',
    daily_budget: dailyBudget,
    attempts_today: attemptsToday,
    cumulative_budget: cumulativeBudget,
    remaining_headroom: remainingHeadroom,
    remaining_daily: remainingDaily,
    topic_headroom: topicHeadroom,
    max_calls_per_topic: maxCallsPerTopic,
    paced: remainingHeadroom === 0 && remainingDaily > 0,
    exhausted: remainingDaily === 0,
    next_release_at: remainingHeadroom === 0 && remainingDaily > 0 ? nextBudgetReleaseIso(now) : null
  };
}

async function providerQuotaStatus(env, now = new Date()) {
  if (!env.DB) return { exhausted: false, detected_at: null, retry_after: null, failure_reason: null };
  const row = await env.DB.prepare(`
    SELECT attempted_at, failure_reason FROM ai_attempts
    WHERE success=0
      AND (failure_reason LIKE 'inference-error:quota-or-capacity%' OR failure_reason LIKE 'fallback-inference-error:quota-or-capacity%')
      AND substr(attempted_at,1,10)=substr(datetime('now'),1,10)
    ORDER BY attempted_at DESC LIMIT 1
  `).first();
  return {
    exhausted: Boolean(row?.attempted_at),
    detected_at: row?.attempted_at || null,
    retry_after: row?.attempted_at ? nextUtcDayIso(now) : null,
    failure_reason: row?.failure_reason || null
  };
}

export async function aiAvailabilityStatus(env, now = new Date()) {
  const generatedAt = now.toISOString();
  if (!env.DB) {
    return {
      ok: false,
      generatedAt,
      available: false,
      effective_blocker: 'missing-db-binding',
      binding: Boolean(env.AI),
      provider_quota: { exhausted: false, detected_at: null, retry_after: null, failure_reason: null },
      pacing: { ok: false, error: 'missing DB binding' }
    };
  }

  const [pacing, providerQuota] = await Promise.all([
    aiBudgetStatus(env, now),
    providerQuotaStatus(env, now)
  ]);

  let effectiveBlocker = null;
  if (!env.AI) effectiveBlocker = 'missing-ai-binding';
  else if (providerQuota.exhausted) effectiveBlocker = 'provider-daily-quota-exhausted';
  else if (pacing.exhausted) effectiveBlocker = 'daily-ai-budget-exhausted';
  else if (pacing.paced || pacing.topic_headroom < 1) effectiveBlocker = 'daily-ai-budget-paced';

  return {
    ok: true,
    generatedAt,
    available: effectiveBlocker === null,
    effective_blocker: effectiveBlocker,
    binding: Boolean(env.AI),
    provider_quota: providerQuota,
    pacing
  };
}

async function fetchRealDashboardFallback(env, category, reason) {
  const fallbackUrl = String(env.PUBLIC_FALLBACK_DASHBOARD_URL || DEFAULT_REAL_DASHBOARD_FALLBACK).trim();
  const maxAgeMs = Math.max(1, Number(env.FALLBACK_MAX_AGE_HOURS || 4)) * 60 * 60 * 1000;
  if (!fallbackUrl) return null;

  try {
    const response = await fetch(fallbackUrl, {
      headers: { accept: 'application/json', 'user-agent': 'internet-trend-radar-worker-fallback/1.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data?.preview !== false || data?.ready !== true) throw new Error('fallback snapshot is not real-data ready');
    if (!Array.isArray(data?.topics) || data.topics.length < 1) throw new Error('fallback snapshot has no topics');
    if (!Array.isArray(data?.sources) || data.sources.length < 1) throw new Error('fallback snapshot has no sources');

    const generatedAt = Date.parse(data.generatedAt || '');
    if (!Number.isFinite(generatedAt)) throw new Error('fallback snapshot has invalid generatedAt');
    const age = Date.now() - generatedAt;
    if (age < -5 * 60 * 1000) throw new Error('fallback snapshot is materially in the future');
    if (age > maxAgeMs) throw new Error(`fallback snapshot is stale (${Math.round(age / 60000)}m)`);

    const fallbackTopics = data.topics;
    for (const topic of fallbackTopics) {
      const refs = new Set((Array.isArray(topic?.sources) ? topic.sources : []).map(ref => String(ref?.source_id || '').trim()).filter(Boolean));
      const signals = Array.isArray(topic?.raw_signals) ? topic.raw_signals : [];
      if (!signals.length || refs.size !== signals.length || [...refs].some(id => !signals.some(signal => signal?.source_id === id))) {
        throw new Error(`fallback topic ${topic?.id || topic?.canonical_title || '<unknown>'} has incomplete raw provenance`);
      }
      for (const signal of signals) {
        const upstream = String(signal?.upstream || '').trim();
        if (!/^https:\/\//.test(upstream) && !/^xiaohongshu-mcp:\/\//.test(upstream)) {
          throw new Error(`fallback topic ${topic?.id || '<unknown>'} has invalid upstream`);
        }
        if (!Array.isArray(signal?.observed_upstreams) || !signal.observed_upstreams.includes(upstream)) {
          throw new Error(`fallback topic ${topic?.id || '<unknown>'} is missing observed upstream history`);
        }
        const capturedAt = Date.parse(String(signal?.latest_captured_at || ''));
        if (!Number.isFinite(capturedAt) || capturedAt - Date.now() > 5 * 60 * 1000 || Date.now() - capturedAt > maxAgeMs) {
          throw new Error(`fallback topic ${topic?.id || '<unknown>'} has stale or invalid latest capture`);
        }
        const paths = signal.metric_paths || {};
        const definition = signal.metric_definition || {};
        for (const [valueField, pathField] of [['raw_heat_max', 'heat'], ['raw_engagement_max', 'engagement']]) {
          const latestField = valueField.replace('_max', '_latest');
          const hasMax = signal[valueField] !== null && signal[valueField] !== undefined;
          const hasLatest = signal[latestField] !== null && signal[latestField] !== undefined;
          if ((hasMax || hasLatest) && !String(paths[pathField] || '').trim()) {
            throw new Error(`fallback topic ${topic?.id || '<unknown>'} has ${valueField} without metric path`);
          }
          if ((hasMax || hasLatest) && definition[pathField] === null) {
            throw new Error(`fallback topic ${topic?.id || '<unknown>'} has ${valueField} despite NULL metric definition`);
          }
          if (hasMax) {
            const peak = signal.peak_evidence?.[pathField];
            const peakAt = Date.parse(String(peak?.captured_at || ''));
            const peakUpstream = String(peak?.upstream || '').trim();
            if (!Number.isFinite(peakAt) || !peakUpstream || (!/^https:\/\//.test(peakUpstream) && !/^xiaohongshu-mcp:\/\//.test(peakUpstream))) {
              throw new Error(`fallback topic ${topic?.id || '<unknown>'} has ${valueField} without peak evidence`);
            }
          }
        }
      }
    }

    const topics = category && category !== '全部'
      ? data.topics.filter(topic => topic.category === category)
      : data.topics;

    return {
      ...data,
      ready: true,
      preview: false,
      topics,
      fallback: {
        active: true,
        kind: 'github-pages-real-snapshot',
        source: fallbackUrl,
        reason: String(reason || 'worker D1 unavailable'),
        fetchedAt: new Date().toISOString(),
        maxAgeHours: maxAgeMs / 3600000
      }
    };
  } catch (error) {
    console.warn('real dashboard fallback unavailable', error);
    return null;
  }
}

async function dashboard(env, url) {
  const category = url.searchParams.get('category') || '';
  if (!env.DB) {
    const fallback = await fetchRealDashboardFallback(env, category, 'missing DB binding');
    return fallback ? json(fallback) : json(notReady('missing DB binding and no fresh real fallback snapshot'), { status: 503 });
  }

  try {
    const where = category && category !== '全部'
      ? "WHERE category=? AND julianday(last_seen_at) >= julianday('now','-24 hours')"
      : "WHERE julianday(last_seen_at) >= julianday('now','-24 hours')";
    const stmt = env.DB.prepare(`SELECT * FROM topics ${where} ORDER BY current_score DESC, breakout_score DESC LIMIT 80`);
    const { results: topics = [] } = category && category !== '全部' ? await stmt.bind(category).all() : await stmt.all();
    const { results: sources = [] } = await env.DB.prepare(`
      SELECT s.id,s.name,s.region,s.kind,s.enabled,s.last_success_at,s.last_error_at,s.last_error,s.last_item_count,s.metadata_json,
             (SELECT json_extract(r.raw_json, '$.trendRadarUpstream')
                FROM raw_items r
               WHERE r.source_id=s.id
               ORDER BY r.captured_at DESC LIMIT 1) AS latest_upstream,
             (SELECT r.captured_at
                FROM raw_items r
               WHERE r.source_id=s.id
               ORDER BY r.captured_at DESC LIMIT 1) AS latest_upstream_captured_at
        FROM sources s
       ORDER BY s.region DESC,s.name
    `).all();

    if (!topics.length) {
      const fallback = await fetchRealDashboardFallback(env, category, 'D1 has no real topics');
      return fallback ? json(fallback) : json(notReady('no real topics available yet', { sources }), { status: 503 });
    }

    const dataQuality = await env.DB.prepare(`
      /* data_quality_contract_probe */
      SELECT
        SUM(CASE WHEN json_extract(r.raw_json,'$.trendRadarUpstream') IS NULL OR length(trim(json_extract(r.raw_json,'$.trendRadarUpstream'))) = 0 THEN 1 ELSE 0 END) AS missing_upstream,
        SUM(CASE WHEN json_extract(r.raw_json,'$.trendRadarUpstream') IS NOT NULL
                  AND json_extract(r.raw_json,'$.trendRadarUpstream') NOT LIKE 'https://%'
                  AND json_extract(r.raw_json,'$.trendRadarUpstream') NOT LIKE 'xiaohongshu-mcp:%' THEN 1 ELSE 0 END) AS invalid_upstream,
        SUM(CASE WHEN r.heat IS NOT NULL AND (json_extract(r.raw_json,'$.trendRadarMetrics.heat_path') IS NULL OR length(trim(json_extract(r.raw_json,'$.trendRadarMetrics.heat_path'))) = 0) THEN 1 ELSE 0 END) AS heat_path_violations,
        SUM(CASE WHEN r.engagement IS NOT NULL AND (json_extract(r.raw_json,'$.trendRadarMetrics.engagement_path') IS NULL OR length(trim(json_extract(r.raw_json,'$.trendRadarMetrics.engagement_path'))) = 0) THEN 1 ELSE 0 END) AS engagement_path_violations,
        SUM(CASE WHEN json_type(s.metadata_json,'$.heat') = 'null' AND r.heat IS NOT NULL THEN 1 ELSE 0 END) AS contract_heat_violations,
        SUM(CASE WHEN json_type(s.metadata_json,'$.engagement') = 'null' AND r.engagement IS NOT NULL THEN 1 ELSE 0 END) AS contract_engagement_violations,
        SUM(CASE WHEN r.heat IS NOT NULL AND ${officialMetricUpstreamPredicate('s.id')}
                  AND CASE WHEN json_type(s.metadata_json,'$.heat_paths') = 'array'
                           THEN NOT EXISTS (SELECT 1 FROM json_each(s.metadata_json,'$.heat_paths') p
                                            WHERE p.value = json_extract(r.raw_json,'$.trendRadarMetrics.heat_path'))
                           ELSE json_extract(r.raw_json,'$.trendRadarMetrics.heat_path') != json_extract(s.metadata_json,'$.heat')
                      END THEN 1 ELSE 0 END) AS definition_heat_path_violations,
        SUM(CASE WHEN r.engagement IS NOT NULL AND ${officialMetricUpstreamPredicate('s.id')}
                  AND CASE WHEN json_type(s.metadata_json,'$.engagement_paths') = 'array'
                           THEN NOT EXISTS (SELECT 1 FROM json_each(s.metadata_json,'$.engagement_paths') p
                                            WHERE p.value = json_extract(r.raw_json,'$.trendRadarMetrics.engagement_path'))
                           ELSE json_extract(r.raw_json,'$.trendRadarMetrics.engagement_path') != json_extract(s.metadata_json,'$.engagement')
                      END THEN 1 ELSE 0 END) AS definition_engagement_path_violations
      FROM raw_items r
      LEFT JOIN sources s ON s.id=r.source_id
    `).first();
    const dataQualityPayload = {
      raw_items_missing_upstream: Number(dataQuality?.missing_upstream || 0),
      raw_items_invalid_upstream: Number(dataQuality?.invalid_upstream || 0),
      metric_path_violations: {
        heat: Number(dataQuality?.heat_path_violations || 0),
        engagement: Number(dataQuality?.engagement_path_violations || 0)
      },
      contract_violations: {
        heat: Number(dataQuality?.contract_heat_violations || 0),
        engagement: Number(dataQuality?.contract_engagement_violations || 0),
        heat_path: Number(dataQuality?.definition_heat_path_violations || 0),
        engagement_path: Number(dataQuality?.definition_engagement_path_violations || 0)
      }
    };
    dataQualityPayload.ok = dataQualityPayload.raw_items_missing_upstream === 0
      && dataQualityPayload.raw_items_invalid_upstream === 0
      && dataQualityPayload.metric_path_violations.heat === 0
      && dataQualityPayload.metric_path_violations.engagement === 0
      && dataQualityPayload.contract_violations.heat === 0
      && dataQualityPayload.contract_violations.engagement === 0
      && dataQualityPayload.contract_violations.heat_path === 0
      && dataQualityPayload.contract_violations.engagement_path === 0;
    if (!dataQualityPayload.ok) {
      return json({ ready: false, preview: false, error: 'data-quality-contract-violation', data_quality: dataQualityPayload }, { status: 503 });
    }

    const rawSignals = await loadRawSignals(env, topics);
    const currentTopics = topics.filter(topic => hasCompleteCurrentEvidence(topic, rawSignals.get(topic.id) || []));
    if (!currentTopics.length) {
      const fallback = await fetchRealDashboardFallback(env, category, 'D1 topic index is awaiting a fresh source rebuild');
      return fallback ? json(fallback) : json(notReady('topic index is awaiting a fresh source rebuild', { sources }), { status: 503 });
    }
    const categoryRows = new Map();
    for (const topic of currentTopics) {
      const row = categoryRows.get(topic.category || '综合') || { category: topic.category || '综合', count: 0, total: 0 };
      row.count += 1;
      row.total += Number(topic.current_score || 0);
      categoryRows.set(row.category, row);
    }
    const categories = [...categoryRows.values()]
      .map(row => ({ category: row.category, count: row.count, avg_score: Math.round((row.total / row.count) * 10) / 10 }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
    const topicPlaceholders = currentTopics.map(() => '?').join(',');
    const { results: timeline = [] } = await env.DB.prepare(`SELECT substr(captured_at,1,13)||':00:00Z' t, ROUND(AVG(score),1) score, ROUND(AVG(breakout_score),1) breakout FROM topic_snapshots WHERE topic_id IN (${topicPlaceholders}) AND julianday(captured_at) >= julianday('now','-24 hours') GROUP BY t ORDER BY t`).bind(...currentTopics.map(topic => topic.id)).all();
    const aiRefreshHours = Math.max(1, Number(env.AI_REFRESH_HOURS || DEFAULT_AI_REFRESH_HOURS));
    const publicSources = sources.map(publicSource);
    const enabledSources = publicSources.filter(source => source.enabled !== false);
    const healthySources = enabledSources.filter(source => source.freshness_status === 'healthy');
    const coverage = {
      active_sources: enabledSources.length,
      active_cn_sources: enabledSources.filter(source => String(source.region || '').toLowerCase() === 'cn').length,
      active_global_sources: enabledSources.filter(source => String(source.region || '').toLowerCase() !== 'cn').length,
      healthy_active_sources: healthySources.length,
      degraded_active_sources: enabledSources.length - healthySources.length
    };
    return json({ generatedAt: new Date().toISOString(), ready:true, preview:false, coverage, data_quality: dataQualityPayload, data_contract: { ...DATA_CONTRACT, source_freshness_hours: SOURCE_FRESHNESS_HOURS, ai_freshness_hours: aiRefreshHours }, topics: currentTopics.map(topic => publicTopic(topic, rawSignals.get(topic.id) || [], aiRefreshHours)), sources: publicSources, categories, timeline });
  } catch (error) {
    console.error('dashboard real-data query failed', error);
    const fallback = await fetchRealDashboardFallback(env, category, `D1 dashboard query failed: ${String(error?.message || error)}`);
    return fallback ? json(fallback) : json(notReady(String(error?.message || error)), { status: 503 });
  }
}

async function publishedBuildSha(env, request) {
  const configured = String(env.BUILD_SHA || '').trim().toLowerCase();
  if (/^[0-9a-f]{40}$/.test(configured)) return configured;
  if (!env.ASSETS?.fetch) return null;
  try {
    const base = request?.url || 'https://radar.wiki-power.com/data/opportunities.json';
    const url = new URL('/data/dashboard.json', base);
    const response = await env.ASSETS.fetch(new Request(url));
    if (!response.ok) return null;
    const dashboard = await response.json();
    const buildSha = String(dashboard?.buildSha || '').trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(buildSha) ? buildSha : null;
  } catch {
    return null;
  }
}

export async function opportunitiesSnapshot(env, request) {
  const buildSha = await publishedBuildSha(env, request);
  if (!env.DB) return json({ ready: false, status: 'degraded', buildSha, source: 'worker-d1', opportunities: [] }, { status: 503 });
  try {
    const { results = [] } = await env.DB.prepare(`
      SELECT * FROM topics
       WHERE julianday(last_seen_at) >= julianday('now','-24 hours')
         AND ai_updated_at IS NOT NULL
         AND length(trim(COALESCE(ai_summary,''))) >= 20
         AND ai_opportunities_json IS NOT NULL
         AND ai_opportunities_json != '[]'
       ORDER BY breakout_score DESC, current_score DESC
       LIMIT 20
    `).all();
    const rawSignalsByTopic = await loadRawSignals(env, results);
    const opportunities = results
      .filter(topic => hasCompleteCurrentEvidence(topic, rawSignalsByTopic.get(topic.id) || []))
      .map(topic => publicTopic(topic, rawSignalsByTopic.get(topic.id) || [], Math.max(1, Number(env.AI_REFRESH_HOURS || DEFAULT_AI_REFRESH_HOURS))))
      .filter(topic => topic.opportunities.length > 0)
      .slice(0, 5)
      .map(topic => ({
        title: topic.canonical_title,
        evidence: [
          `${topic.source_count || 0} 个真实来源覆盖`,
          `趋势指数 ${Math.round(topic.current_score || 0)}（派生指标）`,
          `突破指数 ${Math.round(topic.breakout_score || 0)}`
        ],
        provenance: topic.raw_signals,
        analysis: {
          summary: topic.ai_summary,
          why_now: topic.ai_why_now,
          ideas: topic.opportunities.slice(0, 3),
          risks: topic.ai_risks || ''
        }
      }));
    if (!buildSha) {
      return json({ ready: false, status: 'degraded', source: 'worker-d1', opportunities: [] }, { status: 503 });
    }
    return json({
      generatedAt: new Date().toISOString(),
      buildSha,
      source: 'worker-d1',
      status: opportunities.length ? 'healthy' : 'degraded',
      provider: 'cloudflare-workers-ai',
      opportunities
    });
  } catch (error) {
    return json({ ready: false, status: 'degraded', error: String(error?.message || error), opportunities: [] }, { status: 503 });
  }
}

async function topicDetail(env, id) {
  const topic = await env.DB.prepare(`
    SELECT * FROM topics
     WHERE id=? AND julianday(last_seen_at) >= julianday('now','-24 hours')
  `).bind(id).first();
  if (!topic) return json({ error: 'not found' }, { status: 404 });
  const rawSignals = await loadRawSignals(env, [topic]);
  if (!hasCompleteCurrentEvidence(topic, rawSignals.get(topic.id) || [])) {
    return json({ error: 'topic evidence is stale; waiting for a fresh source rebuild' }, { status: 410 });
  }
  const { results: sources = [] } = await env.DB.prepare(`
    SELECT ts.source_id,ts.title,ts.url,ts.rank,ts.captured_at
     FROM topic_sources ts
      JOIN sources active_source ON active_source.id = ts.source_id
       AND ${currentSourcePredicate('active_source')}
     WHERE ts.topic_id=?
       AND julianday(ts.captured_at) >= julianday('now','-24 hours')
     ORDER BY ts.captured_at DESC LIMIT 50
  `).bind(id).all();
  const { results: snapshots = [] } = await env.DB.prepare(`SELECT captured_at,score,breakout_score,source_count,mention_count FROM topic_snapshots WHERE topic_id=? ORDER BY captured_at ASC LIMIT 96`).bind(id).all();
  return json({ ...publicTopic(topic, rawSignals.get(topic.id) || [], Math.max(1, Number(env.AI_REFRESH_HOURS || DEFAULT_AI_REFRESH_HOURS))), sources, snapshots });
}

async function subscribe(env, request) {
  const body = await request.json();
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: 'invalid email' }, { status: 400 });
  if (!env.DB) return json({ ok: false, error: 'missing DB binding' }, { status: 503 });
  const categories = Array.isArray(body.categories) && body.categories.length ? body.categories.slice(0, 12) : ['综合'];
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO subscribers(email,categories_json,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET active=1,categories_json=excluded.categories_json,updated_at=excluded.updated_at`).bind(email, JSON.stringify(categories), now, now).run();
  return json({ ok: true });
}

async function externalIngest(env, request, sourceId) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) return json({ error: 'unauthorized' }, { status: 401 });
  const body = await request.json();
  const items = (body.items || []).map(x => ({ ...x, fingerprint: x.fingerprint || fingerprintTitle(x.title), category: x.category || categoryFor(sourceId, x.title) }));
  const count = await ingestExternal(env, sourceId, items);
  return json({ ok: true, count });
}

export async function routeApi(env, request) {
  const url = new URL(request.url);
  if (url.pathname === '/api/health') return json({ ok: true, time: new Date().toISOString() });
  if (url.pathname === '/api/ai-budget' && request.method === 'GET') {
    try {
      return json(await aiBudgetStatus(env));
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error), generatedAt: new Date().toISOString() }, { status: 503 });
    }
  }
  if (url.pathname === '/api/ai-availability' && request.method === 'GET') {
    try {
      return json(await aiAvailabilityStatus(env));
    } catch (error) {
      return json({ ok: false, available: false, effective_blocker: 'availability-probe-failed', error: String(error?.message || error), generatedAt: new Date().toISOString() }, { status: 503 });
    }
  }
  if (url.pathname === '/api/dashboard' && request.method === 'GET') return dashboard(env, url);
  if (url.pathname.startsWith('/api/topic/') && request.method === 'GET') return topicDetail(env, decodeURIComponent(url.pathname.slice('/api/topic/'.length)));
  if (url.pathname === '/api/subscribe' && request.method === 'POST') return subscribe(env, request);
  if (url.pathname.startsWith('/api/ingest/') && request.method === 'POST') return externalIngest(env, request, decodeURIComponent(url.pathname.slice('/api/ingest/'.length)));
  if (url.pathname === '/api/admin/collect' && request.method === 'POST') {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
    const openPreview = env.ALLOW_OPEN_COLLECT === '1';
    if (!openPreview && (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, { status: 401 });
    try {
      return json(await collectAll(env));
    } catch (error) {
      return json({ ok: false, error: String(error?.message || error) }, { status: 503 });
    }
  }
  return json({ error: 'not found' }, { status: 404 });
}
