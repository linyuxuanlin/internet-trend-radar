import { readFile } from 'node:fs/promises';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const MAX_AGE_MS = Number(process.env.MAX_SNAPSHOT_AGE_MS || 10 * 60 * 1000);
const FUTURE_SKEW_MS = Number(process.env.MAX_FUTURE_SKEW_MS || 5 * 60 * 1000);
const MIN_HEALTHY_SOURCES = Number(process.env.MIN_HEALTHY_SOURCES || 4);
const MIN_DIRECT_CN_SOURCES = Number(process.env.MIN_DIRECT_CN_SOURCES || 3);
const REQUIRED_DIRECT_CN = String(process.env.REQUIRED_DIRECT_CN || 'v2ex,sspai,bilibili')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

function fail(message) {
  console.error(`REAL_DATA_GATE_FAIL ${message}`);
  process.exitCode = 1;
}

const dashboard = JSON.parse(await readFile(DASHBOARD, 'utf8'));
const topics = Array.isArray(dashboard.topics) ? dashboard.topics : [];
const sources = Array.isArray(dashboard.sources) ? dashboard.sources : [];
const healthy = sources.filter(source => source?.last_success_at && Number(source?.last_item_count || 0) > 0);
const directCn = healthy.filter(source => source.region === 'cn' && ['official-api', 'official-rss'].includes(source.kind));
const directCnIds = new Set(directCn.map(source => source.id));
const generatedAt = Date.parse(dashboard.generatedAt);
const ageMs = Date.now() - generatedAt;

if (dashboard.preview !== false) fail('preview must be false');
if (dashboard.ready !== true) fail('ready must be true');
if (!topics.length) fail('dashboard must contain real topics');
if (!Number.isFinite(generatedAt)) fail('generatedAt must be a valid timestamp');
else if (ageMs < -FUTURE_SKEW_MS) fail(`snapshot timestamp is too far in the future: ageMs=${ageMs}`);
else if (ageMs > MAX_AGE_MS) fail(`snapshot is stale: ageMs=${ageMs} maxAgeMs=${MAX_AGE_MS}`);
if (healthy.length < MIN_HEALTHY_SOURCES) fail(`need >=${MIN_HEALTHY_SOURCES} healthy sources; got ${healthy.length}`);
if (directCn.length < MIN_DIRECT_CN_SOURCES) fail(`need >=${MIN_DIRECT_CN_SOURCES} healthy direct Chinese sources; got ${directCn.map(s => s.id).join(',') || 'none'}`);

for (const required of REQUIRED_DIRECT_CN) {
  if (!directCnIds.has(required)) fail(`required direct Chinese source is not healthy: ${required}`);
}

if (!process.exitCode) {
  console.log(JSON.stringify({
    ok: true,
    topics: topics.length,
    healthySources: healthy.length,
    directCn: directCn.map(source => source.id),
    generatedAt: dashboard.generatedAt,
    ageSeconds: Math.round(ageMs / 1000)
  }));
}
