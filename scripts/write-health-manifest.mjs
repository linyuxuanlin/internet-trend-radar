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

const requiredDirect = REQUIRED_DIRECT_CN.map(id => {
  const source = sources.find(item => item?.id === id);
  return {
    id,
    healthy: Boolean(source?.last_success_at && Number(source?.last_item_count || 0) > 0),
    kind: source?.kind || null,
    region: source?.region || null,
    itemCount: Number(source?.last_item_count || 0),
    topicRefs: Number(topicRefsBySource.get(id) || 0),
    lastSuccessAt: source?.last_success_at || null
  };
});

const manifest = {
  schemaVersion: 1,
  generatedAt: dashboard.generatedAt || null,
  buildSha: dashboard.buildSha || null,
  preview: dashboard.preview,
  ready: dashboard.ready,
  topicCount: topics.length,
  sourceCount: sources.length,
  healthySourceCount: healthySources.length,
  requiredDirect
};

await writeFile(HEALTH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, healthManifest: HEALTH.pathname, ...manifest }));
