import { collectDailyHot } from './sources/dailyhot.js';
import { collectHackerNews } from './sources/hackernews.js';
import { collectGitHub } from './sources/github.js';
import { rebuildTopics } from './scoring.js';
import { enrichTopTopics } from './ai.js';
import { SOURCE_METRICS, metricMetadata, officialMetricUpstreamPredicate } from './source-metadata.js';

const EXACT_METRIC_PATHS = {
  weibo: { heat: 'adapter item.hot <- data.realtime[].num' },
  zhihu: { heat: 'adapter item.hot <- data[].detail_text (parsed)' },
  douyin: { heat: 'word_list[].hot_value|hot|score (official or fallback)' },
  bilibili: { heat: 'data.list[].stat.view', engagement: 'stat.like+reply+coin+favorite+share+danmaku' },
  v2ex: { heat: null, engagement: 'topics[].replies' },
  juejin: { heat: 'article_info.view_count', engagement: 'digg_count+comment_count+collect_count+share_count' },
  '36kr': { heat: 'templateMaterial.statRead', engagement: 'statCollect+statComment+statPraise' },
  hackernews: { heat: 'item.score', engagement: 'item.descendants' },
  github: { heat: 'repository.stargazers_count', engagement: 'repository.forks_count' },
  xiaohongshu: { heat: 'noteCard.interactInfo.likedCount', engagement: 'likedCount+collectedCount+commentCount' }
};

export function kindFromItems(sourceId, items = []) {
  const upstreams = [...new Set(items.map(item => String(item?.raw?.trendRadarUpstream || '').trim()).filter(Boolean))];
  if (sourceId === 'xiaohongshu') return 'external-bridge';
  if (!upstreams.length) return null;
  if (upstreams.some(upstream => /api-hot\.imsyy\.top|api\.guole\.fun/i.test(upstream))) return 'aggregator-fallback';
  if (upstreams.some(upstream => /aa1\.cn|luochen\.sbs|fanyia\.cn/i.test(upstream))) return 'mirror-fallback';
  if (sourceId === '36kr' && upstreams.some(upstream => /36kr\.com\/feed(?:-|\/|$)/i.test(upstream))) return 'official-rss';
  if (sourceId === 'hackernews' || sourceId === 'github' || sourceId === 'weibo' || sourceId === 'zhihu' || sourceId === 'douyin' || sourceId === 'v2ex' || sourceId === 'juejin' || sourceId === '36kr' || sourceId === 'bilibili') return 'official-api';
  return 'source-api';
}

async function markSource(env, id, ok, count = 0, error = '', kind = null) {
  if (ok) {
    await env.DB.prepare(`UPDATE sources SET last_success_at=?,last_item_count=?,last_error=NULL,kind=COALESCE(?,kind) WHERE id=?`)
      .bind(new Date().toISOString(), count, kind, id).run();
  } else {
    await env.DB.prepare(`UPDATE sources SET last_error_at=?,last_error=? WHERE id=?`)
      .bind(new Date().toISOString(), String(error).slice(0,500), id).run();
  }
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function optionalMetric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validateRawProvenance(items, label = 'raw_items') {
  for (const [index, item] of (items || []).entries()) {
    const upstream = String(item?.raw?.trendRadarUpstream || '').trim();
    if (!upstream) {
      throw new Error(`${label}: raw.trendRadarUpstream is required before persistence (item index ${index})`);
    }
    if (upstream.startsWith('xiaohongshu-mcp:')) {
      if (item?.sourceId !== 'xiaohongshu') {
        throw new Error(`${label}: external bridge provenance is only valid for source xiaohongshu (item index ${index})`);
      }
      continue;
    }
    let parsed;
    try {
      parsed = new URL(upstream);
    } catch {
      throw new Error(`${label}: raw.trendRadarUpstream must be a valid URL (item index ${index})`);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`${label}: raw.trendRadarUpstream must use HTTPS (item index ${index})`);
    }
  }
  return items;
}

export function validateMetricProvenance(items, label = 'raw_items') {
  for (const [index, item] of (items || []).entries()) {
    const definition = SOURCE_METRICS[item?.sourceId] || {};
    const metrics = item?.raw?.trendRadarMetrics || {};
    const heatPath = metrics.heat_path;
    const engagementPath = metrics.engagement_path;
    const hasHeat = item?.heat !== null && item?.heat !== undefined;
    const hasEngagement = item?.engagement !== null && item?.engagement !== undefined;
    if (definition.heat === null && hasHeat) {
      throw new Error(`${label}: source ${item?.sourceId || '<unknown>'} declares heat=NULL but supplied a heat value (item index ${index})`);
    }
    if (definition.engagement === null && hasEngagement) {
      throw new Error(`${label}: source ${item?.sourceId || '<unknown>'} declares engagement=NULL but supplied an engagement value (item index ${index})`);
    }
    if (hasHeat && !String(heatPath || '').trim()) {
      throw new Error(`${label}: non-null heat requires raw.trendRadarMetrics.heat_path (item index ${index})`);
    }
    if (hasEngagement && !String(engagementPath || '').trim()) {
      throw new Error(`${label}: non-null engagement requires raw.trendRadarMetrics.engagement_path (item index ${index})`);
    }
    if (heatPath !== null && heatPath !== undefined && typeof heatPath !== 'string') {
      throw new Error(`${label}: heat_path must be a string or null (item index ${index})`);
    }
    if (engagementPath !== null && engagementPath !== undefined && typeof engagementPath !== 'string') {
      throw new Error(`${label}: engagement_path must be a string or null (item index ${index})`);
    }
    for (const [metric, path] of [['heat', heatPath], ['engagement', engagementPath]]) {
      if (!path) continue;
      const allowedPaths = definition[`${metric}_paths`];
      if (Array.isArray(allowedPaths) && allowedPaths.length && !allowedPaths.includes(path)) {
        throw new Error(`${label}: source ${item?.sourceId || '<unknown>'} ${metric}_path is not an allowed adapter field: ${path} (item index ${index})`);
      }
    }
  }
  return items;
}

export function validateCapturedAt(items, label = 'raw_items', now = Date.now()) {
  const maxFutureMs = 5 * 60 * 1000;
  const maxAgeMs = 24 * 60 * 60 * 1000;
  for (const [index, item] of (items || []).entries()) {
    const capturedAt = Date.parse(String(item?.capturedAt || ''));
    if (!Number.isFinite(capturedAt)) {
      throw new Error(`${label}: capturedAt must be a valid ISO timestamp (item index ${index})`);
    }
    if (capturedAt - now > maxFutureMs) {
      throw new Error(`${label}: capturedAt is too far in the future (item index ${index})`);
    }
    if (now - capturedAt > maxAgeMs) {
      throw new Error(`${label}: capturedAt is older than the 24-hour trend window (item index ${index})`);
    }
  }
  return items;
}

async function persist(env, items, label = 'unknown-source') {
  validateRawProvenance(items, label);
  validateMetricProvenance(items, label);
  validateCapturedAt(items, label);
  const statements = items.map(item => env.DB.prepare(`
    INSERT INTO raw_items(source_id,external_id,title,url,author,category,language,rank,heat,engagement,published_at,captured_at,fingerprint,raw_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(item.sourceId,item.externalId,item.title,item.url || '',item.author || '',item.category || '综合',item.language || 'zh',item.rank || null,optionalMetric(item.heat),optionalMetric(item.engagement),item.publishedAt,item.capturedAt,item.fingerprint,JSON.stringify(item.raw || {})));
  for (const [index, group] of chunks(statements, 80).entries()) {
    try {
      await env.DB.batch(group);
    } catch (error) {
      throw new Error(`persist failed for ${label} batch ${index + 1}: ${String(error?.message || error)}`);
    }
  }
}

async function repairHistoricalMetricProvenance(env) {
  // Older rows predate trendRadarMetrics. Recover only the documented adapter
  // paths; never invent a counter or replace a value with a derived one.
  await env.DB.prepare(`
    UPDATE raw_items
       SET heat=NULL, engagement=NULL
     WHERE source_id='36kr'
       AND json_extract(raw_json,'$.trendRadarUpstream') LIKE 'https://www.36kr.com/feed%'
  `).run();

  const repairs = [];
  const unprovableMetricCleanups = [];
  for (const [sourceId, definition] of Object.entries(SOURCE_METRICS)) {
    const exact = EXACT_METRIC_PATHS[sourceId] || {};
    const exactUpstreamGate = EXACT_METRIC_PATHS[sourceId]
      ? officialMetricUpstreamPredicate('source_id', "json_extract(raw_json,'$.trendRadarUpstream')")
      : '1=1';
    if (definition.heat) {
      if (exact.heat) {
        repairs.push(env.DB.prepare(`
          UPDATE raw_items
             SET raw_json=json_set(raw_json,'$.trendRadarMetrics.heat_path',?)
           WHERE source_id=? AND heat IS NOT NULL AND json_valid(raw_json)=1
             AND ${exactUpstreamGate}
             AND (json_extract(raw_json,'$.trendRadarMetrics.heat_path') IS NULL
               OR length(trim(json_extract(raw_json,'$.trendRadarMetrics.heat_path'))) = 0)
        `).bind(exact.heat, sourceId));
      }
      unprovableMetricCleanups.push(env.DB.prepare(`
        UPDATE raw_items
           SET heat=NULL
         WHERE source_id=? AND heat IS NOT NULL
           AND (json_extract(raw_json,'$.trendRadarMetrics.heat_path') IS NULL
             OR length(trim(json_extract(raw_json,'$.trendRadarMetrics.heat_path'))) = 0)
      `).bind(sourceId));
    }
    if (definition.engagement) {
      if (exact.engagement) {
        repairs.push(env.DB.prepare(`
          UPDATE raw_items
             SET raw_json=json_set(raw_json,'$.trendRadarMetrics.engagement_path',?)
           WHERE source_id=? AND engagement IS NOT NULL AND json_valid(raw_json)=1
             AND ${exactUpstreamGate}
             AND (json_extract(raw_json,'$.trendRadarMetrics.engagement_path') IS NULL
               OR length(trim(json_extract(raw_json,'$.trendRadarMetrics.engagement_path'))) = 0)
        `).bind(exact.engagement, sourceId));
      }
      unprovableMetricCleanups.push(env.DB.prepare(`
        UPDATE raw_items
           SET engagement=NULL
         WHERE source_id=? AND engagement IS NOT NULL
           AND (json_extract(raw_json,'$.trendRadarMetrics.engagement_path') IS NULL
             OR length(trim(json_extract(raw_json,'$.trendRadarMetrics.engagement_path'))) = 0)
      `).bind(sourceId));
    }
  }
  for (const group of chunks(repairs, 80)) await env.DB.batch(group);
  // If an older fallback row has a value but no recorded field path, the value
  // is not auditable. Drop only that unprovable metric; never write a prose
  // definition into a field-path slot.
  for (const group of chunks(unprovableMetricCleanups, 80)) await env.DB.batch(group);
}

function collectionFailure(summary) {
  const failed = summary.filter(x => !x.ok);
  const detail = failed.slice(0, 6).map(x => `${x.sourceId}: ${x.error || 'no items'}`).join('; ');
  return new Error(`collection produced no real items${detail ? ` (${detail})` : ''}`);
}

async function aiDailyPacing(env, now = new Date()) {
  const dailyBudget = Math.max(24, Math.min(240, Number(env.AI_DAILY_MODEL_CALL_BUDGET || 96)));
  const maxCallsPerTopic = env.AI_DISABLE_FALLBACK === '1' ? 1 : 2;
  const utcHour = now.getUTCHours();
  const cumulativeBudget = Math.ceil(dailyBudget * (utcHour + 1) / 24);
  try {
    const row = await env.DB.prepare(`
      SELECT count(*) AS attempts FROM ai_attempts
      WHERE substr(attempted_at,1,10)=substr(datetime('now'),1,10)
    `).first();
    const attemptsToday = Math.max(0, Number(row?.attempts || 0));
    const callHeadroom = Math.max(0, cumulativeBudget - attemptsToday);
    return {
      dailyBudget,
      cumulativeBudget,
      attemptsToday,
      callHeadroom,
      topicBudget: Math.floor(callHeadroom / maxCallsPerTopic),
      maxCallsPerTopic,
      utcHour
    };
  } catch (err) {
    console.warn('AI daily pacing probe failed; falling back to bounded per-run AI_TOP_N', err);
    return {
      dailyBudget,
      cumulativeBudget,
      attemptsToday: null,
      callHeadroom: null,
      topicBudget: Math.max(1, Math.min(20, Number(env.AI_TOP_N || 8))),
      maxCallsPerTopic,
      utcHour,
      degraded: true
    };
  }
}

async function enrichAIWithoutBlockingCollection(env) {
  if (!env.AI) return { skipped: true, reason: 'missing-ai-binding' };
  try {
    const pacing = await aiDailyPacing(env);
    if (pacing.topicBudget <= 0) {
      return {
        skipped: true,
        reason: 'daily-ai-budget-paced',
        pacing
      };
    }
    const configuredTopN = Math.max(1, Math.min(20, Number(env.AI_TOP_N || 8)));
    const topN = Math.min(configuredTopN, pacing.topicBudget);
    const result = await enrichTopTopics(env, { topN });
    return { ...result, pacing: { ...pacing, selectedTopN: topN } };
  } catch (err) {
    const error = String(err?.message || err);
    console.error('AI enrichment failed after real collection; preserving collected data', err);
    return { failed: true, error };
  }
}

export async function collectAll(env) {
  if (!env.DB) throw new Error('missing DB binding');

  const sourceIds = String(env.COLLECTOR_SOURCES || 'weibo,zhihu,bilibili,baidu,douyin,toutiao,36kr,juejin,hupu,v2ex')
    .split(',').map(x => x.trim()).filter(Boolean);
  const summary = [];

  // Keep health metrics aligned with the actively configured Worker sources.
  // Sources that are only available in the static build remain in D1 for
  // provenance, but must not appear as current runtime failures.
  const activeIds = [...new Set([...sourceIds, 'hackernews', 'github', 'xiaohongshu'])];
  const placeholders = activeIds.map(() => '?').join(',');
  await env.DB.prepare(`UPDATE sources SET enabled=CASE WHEN id IN (${placeholders}) THEN 1 ELSE 0 END, last_error_at=CASE WHEN id IN (${placeholders}) THEN last_error_at ELSE NULL END, last_error=CASE WHEN id IN (${placeholders}) THEN last_error ELSE NULL END`).bind(...activeIds, ...activeIds, ...activeIds).run();
  await env.DB.batch([
    env.DB.prepare(`UPDATE sources SET weight=? WHERE id=?`).bind(0.35, 'baidu'),
    env.DB.prepare(`UPDATE sources SET weight=? WHERE id=?`).bind(0.35, 'douyin'),
    env.DB.prepare(`UPDATE sources SET weight=? WHERE id=?`).bind(1.15, 'xiaohongshu'),
    env.DB.prepare(`UPDATE sources SET weight=? WHERE id NOT IN ('baidu','douyin','xiaohongshu')`).bind(1),
    ...Object.keys(SOURCE_METRICS).map(id => env.DB.prepare(`UPDATE sources SET metadata_json=? WHERE id=?`).bind(JSON.stringify(metricMetadata(id)), id))
  ]);
  await repairHistoricalMetricProvenance(env);
  // Older rows were written before missing metrics were represented as NULL.
  // For sources whose contract explicitly has no engagement field, zero was
  // only a storage placeholder and must not be reported as observed data.
  await env.DB.prepare(`
    UPDATE raw_items
       SET engagement=NULL
     WHERE source_id IN (
       SELECT id FROM sources
        WHERE json_extract(metadata_json, '$.engagement') IS NULL
    )
  `).run();
  // Apply the same contract to historical rows when a source is reclassified.
  // For example, V2EX replies are engagement, not an independent heat value.
  await env.DB.prepare(`
    UPDATE raw_items
       SET heat=NULL
     WHERE source_id IN (
       SELECT id FROM sources
        WHERE json_extract(metadata_json, '$.heat') IS NULL
     )
  `).run();

  for (const sourceId of sourceIds) {
    try {
      const items = await collectDailyHot(env, sourceId);
      await persist(env, items, sourceId);
      await markSource(env, sourceId, true, items.length, '', kindFromItems(sourceId, items));
      summary.push({ sourceId, ok: true, count: items.length });
    } catch (e) {
      await markSource(env, sourceId, false, 0, e?.message || e);
      summary.push({ sourceId, ok: false, error: String(e?.message || e) });
    }
  }

  for (const [id, fn] of [['hackernews', collectHackerNews], ['github', collectGitHub]]) {
    try {
      const items = await fn(env);
      await persist(env, items, id);
      await markSource(env, id, true, items.length, '', kindFromItems(id, items));
      summary.push({ sourceId: id, ok: true, count: items.length });
    } catch (e) {
      await markSource(env, id, false, 0, e?.message || e);
      summary.push({ sourceId: id, ok: false, error: String(e?.message || e) });
    }
  }

  const realItemCount = summary.reduce((sum, x) => sum + (x.ok ? Number(x.count || 0) : 0), 0);
  if (realItemCount <= 0) throw collectionFailure(summary);

  let topics;
  try {
    topics = await rebuildTopics(env.DB, 24);
  } catch (error) {
    throw new Error(`topic rebuild failed after ${realItemCount} collected items: ${String(error?.message || error)}`);
  }
  if (topics <= 0) {
    throw new Error(`collection stored ${realItemCount} real items but produced 0 topics`);
  }

  const ai = await enrichAIWithoutBlockingCollection(env);
  return {
    ok: true,
    realItemCount,
    healthySources: summary.filter(x => x.ok && Number(x.count || 0) > 0).length,
    failedSources: summary.filter(x => !x.ok).length,
    summary,
    topics,
    ai,
    at: new Date().toISOString()
  };
}

export async function ingestExternal(env, sourceId, items) {
  if (!SOURCE_METRICS[sourceId]) {
    throw new Error(`external ingest source ${sourceId || '<empty>'} has no registered metric contract`);
  }
  if (sourceId !== 'xiaohongshu') {
    throw new Error(`external ingest source ${sourceId} is not an approved external bridge`);
  }
  if (!Array.isArray(items)) throw new Error('items must be an array');
  await env.DB.prepare(`INSERT OR IGNORE INTO sources(id,name,region,kind) VALUES(?,?,?,?)`)
    .bind(sourceId, sourceId, 'unknown', 'external-bridge').run();
  await env.DB.prepare(`UPDATE sources SET metadata_json=? WHERE id=?`).bind(JSON.stringify(metricMetadata(sourceId)), sourceId).run();
  const normalized = items.slice(0, 200).map((x, i) => ({
    sourceId,
    externalId: String(x.externalId || x.id || x.url || `${i}:${x.title}`),
    title: String(x.title || '').trim(), url: x.url || '', author: x.author || '',
    category: x.category || '综合', language: x.language || 'zh', rank: Number(x.rank || i + 1),
    heat: optionalMetric(x.heat), engagement: optionalMetric(x.engagement), publishedAt: x.publishedAt || null,
    capturedAt: x.capturedAt || new Date().toISOString(), fingerprint: x.fingerprint,
    raw: x.raw || x
  })).filter(x => x.title && x.fingerprint);
  await persist(env, normalized, sourceId);
  await markSource(env, sourceId, true, normalized.length, '', 'external-bridge');
  await rebuildTopics(env.DB, 24);
  return normalized.length;
}
