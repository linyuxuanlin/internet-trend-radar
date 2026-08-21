import { readFile } from 'node:fs/promises';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const DASHBOARD_URL = String(process.env.DASHBOARD_URL || '').trim();
const FETCH_TIMEOUT_MS = Number(process.env.DASHBOARD_FETCH_TIMEOUT_MS || 15 * 1000);
const MAX_AGE_MS = Number(process.env.MAX_SNAPSHOT_AGE_MS || 10 * 60 * 1000);
const FUTURE_SKEW_MS = Number(process.env.MAX_FUTURE_SKEW_MS || 5 * 60 * 1000);
const MIN_HEALTHY_SOURCES = Number(process.env.MIN_HEALTHY_SOURCES || 4);
const MIN_DIRECT_CN_SOURCES = Number(process.env.MIN_DIRECT_CN_SOURCES || 3);
const MIN_TOPICS_PER_REQUIRED_DIRECT = Number(process.env.MIN_TOPICS_PER_REQUIRED_DIRECT || 5);
const REQUIRED_DIRECT_CN = String(process.env.REQUIRED_DIRECT_CN || 'v2ex,sspai,bilibili')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const OFFICIAL_HOSTS = {
  v2ex: ['v2ex.com'],
  sspai: ['sspai.com'],
  bilibili: ['bilibili.com'],
  '36kr': ['36kr.com'],
  juejin: ['juejin.cn'],
  baidu: ['baidu.com'],
  toutiao: ['toutiao.com'],
  hupu: ['hupu.com'],
  ithome: ['ithome.com']
};

function fail(message) {
  console.error(`REAL_DATA_GATE_FAIL ${message}`);
  process.exitCode = 1;
}

function hostnameMatches(hostname, allowed) {
  return allowed.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

async function loadDashboard() {
  if (!DASHBOARD_URL) {
    return JSON.parse(await readFile(DASHBOARD, 'utf8'));
  }

  let url;
  try {
    url = new URL(DASHBOARD_URL);
  } catch {
    throw new Error(`invalid DASHBOARD_URL: ${DASHBOARD_URL}`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`DASHBOARD_URL must use http(s): ${url.protocol}`);
  }

  url.searchParams.set('_radar_check', String(Date.now()));
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache'
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`dashboard fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`dashboard response is not valid JSON (${body.length} bytes)`);
  }
}

let dashboard;
try {
  dashboard = await loadDashboard();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  process.exit();
}

const topics = Array.isArray(dashboard.topics) ? dashboard.topics : [];
const sources = Array.isArray(dashboard.sources) ? dashboard.sources : [];
const healthy = sources.filter(source => source?.last_success_at && Number(source?.last_item_count || 0) > 0);
const directCn = healthy.filter(source => source.region === 'cn' && ['official-api', 'official-rss', 'official-page'].includes(source.kind));
const directCnIds = new Set(directCn.map(source => source.id));
const generatedAt = Date.parse(dashboard.generatedAt);
const ageMs = Date.now() - generatedAt;

const topicRefsBySource = new Map();
for (const topic of topics) {
  const refs = Array.isArray(topic?.sources) ? topic.sources : [];
  const uniqueSourceIds = new Set(refs.map(ref => String(ref?.source_id || '').trim()).filter(Boolean));
  const declaredSourceCount = Number(topic?.source_count);

  if (!Number.isInteger(declaredSourceCount) || declaredSourceCount < 1) {
    fail(`topic ${topic?.id || topic?.canonical_title || '<unknown>'} has invalid source_count: ${topic?.source_count}`);
  } else if (declaredSourceCount !== uniqueSourceIds.size) {
    fail(`topic ${topic?.id || topic?.canonical_title || '<unknown>'} source_count mismatch: declared=${declaredSourceCount} uniqueSources=${uniqueSourceIds.size}`);
  }

  for (const ref of refs) {
    const sourceId = String(ref?.source_id || '').trim();
    if (!sourceId) continue;
    const rows = topicRefsBySource.get(sourceId) || [];
    rows.push({ topic, ref });
    topicRefsBySource.set(sourceId, rows);
  }
}

if (dashboard.preview !== false) fail('preview must be false');
if (dashboard.ready !== true) fail('ready must be true');
if (!topics.length) fail('dashboard must contain real topics');
if (!Number.isFinite(generatedAt)) fail('generatedAt must be a valid timestamp');
else if (ageMs < -FUTURE_SKEW_MS) fail(`snapshot timestamp is too far in the future: ageMs=${ageMs}`);
else if (ageMs > MAX_AGE_MS) fail(`snapshot is stale: ageMs=${ageMs} maxAgeMs=${MAX_AGE_MS}`);
if (healthy.length < MIN_HEALTHY_SOURCES) fail(`need >=${MIN_HEALTHY_SOURCES} healthy sources; got ${healthy.length}`);
if (directCn.length < MIN_DIRECT_CN_SOURCES) fail(`need >=${MIN_DIRECT_CN_SOURCES} healthy direct Chinese sources; got ${directCn.map(s => s.id).join(',') || 'none'}`);

for (const required of REQUIRED_DIRECT_CN) {
  if (!directCnIds.has(required)) {
    fail(`required direct Chinese source is not healthy: ${required}`);
    continue;
  }

  const source = directCn.find(item => item.id === required);
  const refs = topicRefsBySource.get(required) || [];
  const distinctTopicIds = new Set(refs.map(({ topic }) => String(topic?.id || topic?.fingerprint || topic?.canonical_title || '')));
  const expectedCount = Number(source?.last_item_count || 0);
  const externalIds = new Set();

  if (refs.length < MIN_TOPICS_PER_REQUIRED_DIRECT) {
    fail(`required direct source ${required} has too few topic references: ${refs.length} < ${MIN_TOPICS_PER_REQUIRED_DIRECT}`);
  }
  if (distinctTopicIds.size < MIN_TOPICS_PER_REQUIRED_DIRECT) {
    fail(`required direct source ${required} has too few distinct topics: ${distinctTopicIds.size} < ${MIN_TOPICS_PER_REQUIRED_DIRECT}`);
  }
  if (expectedCount > 0 && refs.length !== expectedCount) {
    fail(`required direct source ${required} item-count mismatch: source=${expectedCount} topicRefs=${refs.length}`);
  }

  const allowedHosts = OFFICIAL_HOSTS[required];
  if (!allowedHosts?.length) {
    fail(`required direct source ${required} has no official-host provenance policy`);
    continue;
  }

  for (const { ref } of refs) {
    const rawUrl = String(ref?.url || '').trim();
    if (!rawUrl) {
      fail(`required direct source ${required} has topic without URL`);
      continue;
    }
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      fail(`required direct source ${required} has invalid topic URL: ${rawUrl}`);
      continue;
    }
    if (url.protocol !== 'https:') {
      fail(`required direct source ${required} has non-HTTPS topic URL: ${rawUrl}`);
    }
    if (!hostnameMatches(url.hostname.toLowerCase(), allowedHosts)) {
      fail(`required direct source ${required} has off-domain topic URL: ${url.hostname}`);
    }

    const externalId = String(ref?.external_id || '').trim();
    if (!externalId) {
      fail(`required direct source ${required} has topic without external_id`);
    } else if (externalIds.has(externalId)) {
      fail(`required direct source ${required} has duplicate external_id: ${externalId}`);
    } else {
      externalIds.add(externalId);
    }

    const capturedAt = Date.parse(ref?.captured_at);
    if (!Number.isFinite(capturedAt)) {
      fail(`required direct source ${required} has invalid captured_at: ${ref?.captured_at}`);
    } else {
      const capturedAgeMs = Date.now() - capturedAt;
      if (capturedAgeMs < -FUTURE_SKEW_MS) {
        fail(`required direct source ${required} captured_at is too far in the future: ${ref?.captured_at}`);
      } else if (capturedAgeMs > MAX_AGE_MS) {
        fail(`required direct source ${required} captured_at is stale: ${ref?.captured_at}`);
      }
    }
  }
}

if (!process.exitCode) {
  console.log(JSON.stringify({
    ok: true,
    dashboardLocation: DASHBOARD_URL || DASHBOARD.pathname,
    topics: topics.length,
    healthySources: healthy.length,
    directCn: directCn.map(source => source.id),
    requiredDirect: REQUIRED_DIRECT_CN.map(id => ({
      id,
      topicRefs: (topicRefsBySource.get(id) || []).length,
      uniqueExternalIds: new Set((topicRefsBySource.get(id) || []).map(({ ref }) => String(ref?.external_id || '').trim()).filter(Boolean)).size,
      officialHosts: OFFICIAL_HOSTS[id] || []
    })),
    generatedAt: dashboard.generatedAt,
    ageSeconds: Math.round(ageMs / 1000)
  }));
}
