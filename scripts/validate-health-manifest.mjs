import { readFile } from 'node:fs/promises';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const HEALTH = new URL('../public/data/health.json', import.meta.url);
const DASHBOARD_URL = String(process.env.DASHBOARD_URL || '').trim();
const HEALTH_URL = String(process.env.HEALTH_URL || '').trim();
const FETCH_TIMEOUT_MS = Number(process.env.DASHBOARD_FETCH_TIMEOUT_MS || 15 * 1000);
const MAX_AGE_MS = Number(process.env.MAX_SNAPSHOT_AGE_MS || 10 * 60 * 1000);
const EXPECTED_BUILD_SHA = String(process.env.EXPECTED_BUILD_SHA || '').trim().toLowerCase();
const REQUIRED_DIRECT_CN = String(process.env.REQUIRED_DIRECT_CN || 'v2ex,sspai,bilibili')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

function fail(message) {
  console.error(`HEALTH_MANIFEST_GATE_FAIL ${message}`);
  process.exitCode = 1;
}

async function loadJson(localUrl, remoteUrl, label) {
  if (!remoteUrl) return JSON.parse(await readFile(localUrl, 'utf8'));
  const url = new URL(remoteUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} URL must use http(s)`);
  url.searchParams.set('_radar_check', String(Date.now()));
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${label} fetch failed: HTTP ${response.status} ${response.statusText}`);
  return response.json();
}

let dashboard;
let health;
try {
  [dashboard, health] = await Promise.all([
    loadJson(DASHBOARD, DASHBOARD_URL, 'dashboard'),
    loadJson(HEALTH, HEALTH_URL, 'health manifest')
  ]);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  process.exit();
}

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

if (health.schemaVersion !== 1) fail(`schemaVersion must be 1; got ${health.schemaVersion}`);
if (health.preview !== false || dashboard.preview !== false) fail('preview must be false in dashboard and health manifest');
if (health.ready !== true || dashboard.ready !== true) fail('ready must be true in dashboard and health manifest');
if (health.generatedAt !== dashboard.generatedAt) fail(`generatedAt mismatch: health=${health.generatedAt} dashboard=${dashboard.generatedAt}`);
if (String(health.buildSha || '').toLowerCase() !== String(dashboard.buildSha || '').toLowerCase()) fail(`buildSha mismatch: health=${health.buildSha} dashboard=${dashboard.buildSha}`);
if (EXPECTED_BUILD_SHA && String(health.buildSha || '').toLowerCase() !== EXPECTED_BUILD_SHA) fail(`health buildSha does not match expected commit: expected=${EXPECTED_BUILD_SHA} got=${health.buildSha}`);
if (Number(health.topicCount) !== topics.length) fail(`topicCount mismatch: health=${health.topicCount} dashboard=${topics.length}`);
if (Number(health.sourceCount) !== sources.length) fail(`sourceCount mismatch: health=${health.sourceCount} dashboard=${sources.length}`);
if (Number(health.healthySourceCount) !== healthySources.length) fail(`healthySourceCount mismatch: health=${health.healthySourceCount} dashboard=${healthySources.length}`);

const generatedAt = Date.parse(health.generatedAt);
if (!Number.isFinite(generatedAt)) fail(`generatedAt must be valid: ${health.generatedAt}`);
else if (Date.now() - generatedAt > MAX_AGE_MS) fail(`health manifest is stale: generatedAt=${health.generatedAt}`);

const requiredRows = Array.isArray(health.requiredDirect) ? health.requiredDirect : [];
for (const id of REQUIRED_DIRECT_CN) {
  const row = requiredRows.find(item => item?.id === id);
  const source = sources.find(item => item?.id === id);
  const expectedHealthy = Boolean(source?.last_success_at && Number(source?.last_item_count || 0) > 0);
  const expectedRefs = Number(topicRefsBySource.get(id) || 0);
  if (!row) {
    fail(`missing required direct source row: ${id}`);
    continue;
  }
  if (row.healthy !== expectedHealthy || row.healthy !== true) fail(`required direct source ${id} healthy mismatch: health=${row.healthy} expected=${expectedHealthy}`);
  if (row.kind !== source?.kind) fail(`required direct source ${id} kind mismatch: health=${row.kind} dashboard=${source?.kind}`);
  if (row.region !== source?.region) fail(`required direct source ${id} region mismatch: health=${row.region} dashboard=${source?.region}`);
  if (Number(row.itemCount) !== Number(source?.last_item_count || 0)) fail(`required direct source ${id} itemCount mismatch: health=${row.itemCount} dashboard=${source?.last_item_count}`);
  if (Number(row.topicRefs) !== expectedRefs) fail(`required direct source ${id} topicRefs mismatch: health=${row.topicRefs} dashboard=${expectedRefs}`);
  if (row.lastSuccessAt !== source?.last_success_at) fail(`required direct source ${id} lastSuccessAt mismatch`);
}

if (requiredRows.length !== REQUIRED_DIRECT_CN.length) fail(`requiredDirect row count mismatch: health=${requiredRows.length} expected=${REQUIRED_DIRECT_CN.length}`);

if (!process.exitCode) {
  console.log(JSON.stringify({
    ok: true,
    healthLocation: HEALTH_URL || HEALTH.pathname,
    dashboardLocation: DASHBOARD_URL || DASHBOARD.pathname,
    buildSha: health.buildSha,
    generatedAt: health.generatedAt,
    topicCount: health.topicCount,
    healthySourceCount: health.healthySourceCount,
    requiredDirect: requiredRows.map(row => ({ id: row.id, itemCount: row.itemCount, topicRefs: row.topicRefs }))
  }));
}
