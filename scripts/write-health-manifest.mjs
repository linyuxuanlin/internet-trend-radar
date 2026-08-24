import { readFile, writeFile } from 'node:fs/promises';
import { classifySourceFailure } from './source-failure-diagnostics.mjs';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const HEALTH = new URL('../public/data/health.json', import.meta.url);
const REQUIRED_DIRECT_CN = String(process.env.REQUIRED_DIRECT_CN || 'v2ex,sspai,bilibili')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const SOCIAL_IDS = new Set(['weibo', 'zhihu', 'douyin']);

const dashboard = JSON.parse(await readFile(DASHBOARD, 'utf8'));
const topics = Array.isArray(dashboard.topics) ? dashboard.topics : [];
const sources = Array.isArray(dashboard.sources) ? dashboard.sources : [];
const healthySources = sources.filter(source => source?.last_success_at && Number(source?.last_item_count || 0) > 0);
const topicRefsBySource = new Map();

for (const topic of topics) {
  for (const ref of Array.isArray(topic?.sources) ? topic.sources : []) {
    const sourceId = String(ref?.source_id || '').trim();
    if (!sourceId) continue;
    topicRefsBySource.set(sourceId, (topicRefsBySource.get(sourceId) || 0) + 1);
  }
}

function sourceHealthRow(source) {
  const lastSuccessAt = source?.last_success_at || null;
  const successMs = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;
  const generatedMs = dashboard.generatedAt ? Date.parse(dashboard.generatedAt) : NaN;
  const freshnessSeconds = Number.isFinite(successMs) && Number.isFinite(generatedMs)
    ? Math.max(0, Math.round((generatedMs - successMs) / 1000))
    : null;
  const failure = classifySourceFailure(source);
  return {
    id: source?.id || null,
    name: source?.name || null,
    healthy: Boolean(lastSuccessAt && Number(source?.last_item_count || 0) > 0),
    kind: source?.kind || null,
    region: source?.region || null,
    itemCount: Number(source?.last_item_count || 0),
    topicRefs: Number(topicRefsBySource.get(source?.id) || 0),
    lastSuccessAt,
    lastErrorAt: source?.last_error_at || null,
    lastError: source?.last_error || null,
    lastErrorType: failure.type,
    lastErrorCode: failure.code,
    freshnessSeconds,
    upstream: source?.upstream || null,
    upstreamProvider: source?.upstream_provider || null,
    upstreamStage: source?.upstream_stage || null
  };
}

const sourceHealth = sources.map(sourceHealthRow);
for (const row of sourceHealth) {
  if (!SOCIAL_IDS.has(row.id) || !row.healthy) continue;
  if (!/^https:\/\//.test(String(row.upstream || ''))) throw new Error(`${row.id}: healthy social health row missing HTTPS upstream`);
  if (!row.upstreamProvider || row.upstreamProvider === 'unknown') throw new Error(`${row.id}: healthy social health row missing upstreamProvider`);
  if (!row.upstreamStage || ['unknown', 'failed'].includes(row.upstreamStage)) throw new Error(`${row.id}: healthy social health row missing upstreamStage`);
}
const requiredDirect = REQUIRED_DIRECT_CN.map(id => sourceHealth.find(item => item.id === id) || {
  id,
  name: null,
  healthy: false,
  kind: null,
  region: null,
  itemCount: 0,
  topicRefs: 0,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: 'missing source row',
  lastErrorType: 'unknown',
  lastErrorCode: null,
  freshnessSeconds: null,
  upstream: null,
  upstreamProvider: null,
  upstreamStage: null
});

const ai = dashboard.ai || {};
const aiOpportunities = Array.isArray(dashboard.topics)
  ? dashboard.topics.reduce((count, topic) => count + (Array.isArray(topic?.opportunities) ? topic.opportunities.length : 0), 0)
  : 0;

const manifest = {
  schemaVersion: 4,
  generatedAt: dashboard.generatedAt || null,
  buildSha: dashboard.buildSha || null,
  preview: dashboard.preview,
  ready: dashboard.ready,
  topicCount: topics.length,
  sourceCount: sources.length,
  healthySourceCount: healthySources.length,
  degradedSourceCount: sourceHealth.filter(source => !source.healthy).length,
  aiAnalysis: {
    status: ai.available || aiOpportunities > 0 ? 'healthy' : 'degraded',
    provider: ai.provider || null,
    generatedAt: ai.generatedAt || null,
    matchedCount: Number(ai.matchedCount || 0),
    opportunityCount: aiOpportunities,
    error: ai.error || null
  },
  sourceHealth,
  requiredDirect
};

await writeFile(HEALTH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, healthManifest: HEALTH.pathname, ...manifest }));
