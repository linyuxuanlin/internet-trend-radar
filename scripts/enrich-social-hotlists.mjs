import { readFile, writeFile } from 'node:fs/promises';
import { collectDailyHot } from '../src/sources/dailyhot.js';
import { fingerprintTitle, scoreItem, topicStatus } from '../src/utils.js';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const REQUIRED = String(process.env.REQUIRED_SOCIAL_SOURCES || 'weibo,zhihu')
  .split(',').map(x => x.trim()).filter(Boolean);
const OPTIONAL = String(process.env.OPTIONAL_SOCIAL_SOURCES || 'douyin')
  .split(',').map(x => x.trim()).filter(Boolean)
  .filter(x => !REQUIRED.includes(x));
const env = {
  DAILYHOT_BASES: process.env.DAILYHOT_BASES || 'https://api.guole.fun,https://api-hot.imsyy.top'
};

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
}

export function describeSocialUpstream(sourceId, upstream) {
  const value = String(upstream || '').trim();
  if (!value) return { provider: 'unknown', stage: 'unknown' };
  const host = (() => {
    try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
  })();

  if (host === 'api.guole.fun') return { provider: 'guole', stage: 'primary-aggregator' };
  if (host === 'api-hot.imsyy.top') return { provider: 'imsyy', stage: 'primary-aggregator' };
  if (sourceId === 'weibo' && host.endsWith('weibo.com')) return { provider: 'weibo-official', stage: 'official-direct' };
  if (sourceId === 'zhihu' && host === 'api.zhihu.com') return { provider: 'zhihu-official', stage: 'official-direct' };
  if (sourceId === 'douyin' && host.endsWith('douyin.com')) return { provider: 'douyin-official', stage: 'official-direct' };
  if (sourceId === 'douyin' && host === 'v.api.aa1.cn') return { provider: 'aa1', stage: 'mirror-fallback-1' };
  if (sourceId === 'douyin' && host === 'api.luochen.sbs') return { provider: 'luochen', stage: 'mirror-fallback-2' };
  if (sourceId === 'douyin' && host === 'api.fanyia.cn') return { provider: 'fanyia', stage: 'mirror-fallback-3' };
  return { provider: host || 'unknown', stage: 'custom-upstream' };
}

function makeTopic(item, total) {
  const score = scoreItem(item.rank, total, 0, 0);
  const breakout = clamp(score * (item.rank <= 5 ? 0.95 : item.rank <= 10 ? 0.82 : 0.64));
  const id = item.fingerprint || fingerprintTitle(item.title);
  const upstream = item.raw?.trendRadarUpstream || null;
  const provenance = describeSocialUpstream(item.sourceId, upstream);
  const sourceKind = provenance.stage === 'official-direct'
    ? 'official-api'
    : provenance.stage.startsWith('mirror-fallback')
      ? 'mirror-fallback'
      : 'aggregator-fallback';
  return {
    id,
    fingerprint: id,
    canonical_title: item.title,
    category: item.category,
    language: item.language || 'zh',
    first_seen_at: item.capturedAt,
    last_seen_at: item.capturedAt,
    current_score: Number(score.toFixed(1)),
    breakout_score: Number(breakout.toFixed(1)),
    source_count: 1,
    mention_count: 1,
    status: topicStatus(score, breakout),
    ai_summary: null,
    ai_why_now: null,
    opportunities: [],
    sources: [{
      source_id: item.sourceId,
      external_id: item.externalId,
      url: item.url,
      title: item.title,
      rank: item.rank,
      captured_at: item.capturedAt,
      published_at: item.publishedAt || null,
      upstream
    }],
    raw_signals: [{
      source_id: item.sourceId,
      source_kind: sourceKind,
      raw_heat_max: item.heat === null || item.heat === undefined ? null : Number(item.heat),
      raw_engagement_max: item.engagement === null || item.engagement === undefined ? null : Number(item.engagement),
      raw_heat_latest: item.heat === null || item.heat === undefined ? null : Number(item.heat),
      raw_engagement_latest: item.engagement === null || item.engagement === undefined ? null : Number(item.engagement),
      best_rank: item.rank,
      observations: 1,
      latest_captured_at: item.capturedAt,
      upstream,
      metric_paths: item.raw?.trendRadarMetrics ? {
        heat: item.raw.trendRadarMetrics.heat_path || null,
        engagement: item.raw.trendRadarMetrics.engagement_path || null
      } : { heat: null, engagement: null },
      units: 'source-native; not comparable across platforms'
    }]
  };
}

function mergeTopics(existing, incoming) {
  const byId = new Map((existing || []).map(topic => [topic.id, topic]));
  for (const topic of incoming) {
    const old = byId.get(topic.id);
    if (!old) {
      byId.set(topic.id, topic);
      continue;
    }
    const signalBySource = new Map([...(old.raw_signals || []), ...(topic.raw_signals || [])]
      .filter(signal => signal?.source_id)
      .map(signal => [signal.source_id, signal]));
    old.raw_signals = [...signalBySource.values()];
    const sourceByKey = new Map([...(old.sources || []), ...(topic.sources || [])]
      .filter(source => source?.source_id)
      .map(source => [`${source.source_id}:${source.external_id || source.url || source.title || ''}`, source]));
    old.sources = [...sourceByKey.values()];
    old.source_count = new Set(old.sources.map(source => source.source_id)).size;
    old.mention_count = Math.max(Number(old.mention_count || 0), old.sources.length);
    old.current_score = Math.max(Number(old.current_score || 0), Number(topic.current_score || 0));
    old.breakout_score = Math.max(Number(old.breakout_score || 0), Number(topic.breakout_score || 0));
    old.status = topicStatus(old.current_score, old.breakout_score);
    old.last_seen_at = [old.last_seen_at, topic.last_seen_at].filter(Boolean).sort().at(-1) || old.last_seen_at;
  }
  return [...byId.values()]
    .sort((a, b) => Number(b.current_score || 0) - Number(a.current_score || 0) || Number(b.breakout_score || 0) - Number(a.breakout_score || 0));
}

function setSource(dashboard, source) {
  dashboard.sources = [...(dashboard.sources || []).filter(existing => existing.id !== source.id), source];
}

function assertSocialProvenance(dashboard, sourceId) {
  const source = (dashboard.sources || []).find(item => item?.id === sourceId);
  if (!source) throw new Error(`${sourceId}: source health entry missing after enrichment`);
  const healthy = Boolean(source.last_success_at && !source.last_error);
  if (!healthy) {
    if (source.upstream_stage !== 'failed') throw new Error(`${sourceId}: degraded source must expose upstream_stage=failed`);
    return;
  }
  if (!source.upstream || !/^https:\/\//.test(String(source.upstream))) throw new Error(`${sourceId}: healthy source missing HTTPS upstream`);
  if (!source.upstream_provider || source.upstream_provider === 'unknown') throw new Error(`${sourceId}: healthy source missing upstream_provider`);
  if (!source.upstream_stage || ['unknown', 'failed'].includes(source.upstream_stage)) throw new Error(`${sourceId}: healthy source missing upstream_stage`);
  const refs = (dashboard.topics || []).flatMap(topic => (topic.sources || []).filter(ref => ref?.source_id === sourceId));
  if (refs.length < 5) throw new Error(`${sourceId}: only ${refs.length} topic refs after enrichment`);
  const mismatched = refs.filter(ref => ref.upstream !== source.upstream);
  if (mismatched.length) throw new Error(`${sourceId}: ${mismatched.length} topic refs disagree with source upstream`);
}

async function enrichOne(dashboard, sourceId, required) {
  const nowIso = new Date().toISOString();
  try {
    const items = await collectDailyHot(env, sourceId);
    if (items.length < 5) throw new Error(`only ${items.length} real items`);
    const topics = items.map(item => makeTopic(item, items.length));
    dashboard.topics = mergeTopics(dashboard.topics, topics);
    const upstream = items[0]?.raw?.trendRadarUpstream || null;
    const provenance = describeSocialUpstream(sourceId, upstream);
    setSource(dashboard, {
      id: sourceId,
      name: items[0]?.sourceName || sourceId,
      region: 'cn',
      kind: upstream?.includes('weibo.com') || upstream?.includes('zhihu.com') || upstream?.includes('douyin.com') ? 'official-api' : 'aggregator-fallback',
      last_success_at: items[0]?.capturedAt || nowIso,
      last_error_at: null,
      last_error: null,
      last_item_count: topics.length,
      upstream,
      upstream_provider: provenance.provider,
      upstream_stage: provenance.stage
    });
    console.log(`OK ${sourceId}: ${topics.length} real items via ${provenance.provider}/${provenance.stage} (${upstream || 'unknown upstream'})`);
    return true;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    setSource(dashboard, {
      id: sourceId,
      name: sourceId,
      region: 'cn',
      kind: 'social-hotlist',
      last_success_at: null,
      last_error_at: nowIso,
      last_error: message,
      last_item_count: 0,
      upstream: null,
      upstream_provider: null,
      upstream_stage: 'failed'
    });
    console.warn(`FAIL ${sourceId}: ${message}`);
    if (required) throw error;
    return false;
  }
}

const dashboard = JSON.parse(await readFile(DASHBOARD, 'utf8'));
if (dashboard.preview !== false || dashboard.ready !== true || !Array.isArray(dashboard.topics)) {
  throw new Error('social hotlist enrichment requires a real-data ready dashboard snapshot');
}

for (const sourceId of REQUIRED) await enrichOne(dashboard, sourceId, true);
for (const sourceId of OPTIONAL) await enrichOne(dashboard, sourceId, false);

dashboard.topics = mergeTopics(dashboard.topics, []);
for (const sourceId of [...REQUIRED, ...OPTIONAL]) assertSocialProvenance(dashboard, sourceId);
await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');

const healthy = (dashboard.sources || []).filter(source => source?.last_success_at && !source?.last_error).length;
console.log(JSON.stringify({
  ok: true,
  required: REQUIRED,
  optional: OPTIONAL,
  topics: dashboard.topics.length,
  healthySources: healthy,
  socialUpstreams: [...REQUIRED, ...OPTIONAL].map(sourceId => {
    const source = (dashboard.sources || []).find(item => item.id === sourceId);
    return source ? {
      sourceId,
      ok: Boolean(source.last_success_at && !source.last_error),
      provider: source.upstream_provider ?? null,
      stage: source.upstream_stage ?? null,
      upstream: source.upstream ?? null
    } : { sourceId, ok: false, provider: null, stage: 'missing', upstream: null };
  })
}));
