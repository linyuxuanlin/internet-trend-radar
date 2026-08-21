import { readFile, writeFile } from 'node:fs/promises';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const HEALTH = new URL('../public/data/health.json', import.meta.url);
const REQUIRED_DIRECT_CN = String(process.env.REQUIRED_DIRECT_CN || 'v2ex,sspai,bilibili')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

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
    freshnessSeconds
  };
}

const sourceHealth = sources.map(sourceHealthRow);
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
  freshnessSeconds: null
});

const manifest = {
  schemaVersion: 2,
  generatedAt: dashboard.generatedAt || null,
  buildSha: dashboard.buildSha || null,
  preview: dashboard.preview,
  ready: dashboard.ready,
  topicCount: topics.length,
  sourceCount: sources.length,
  healthySourceCount: healthySources.length,
  degradedSourceCount: sourceHealth.filter(source => !source.healthy).length,
  sourceHealth,
  requiredDirect
};

await writeFile(HEALTH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, healthManifest: HEALTH.pathname, ...manifest }));
