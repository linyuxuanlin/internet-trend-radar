const DASHBOARD_URL = String(process.env.DASHBOARD_URL || '').trim();
const HEALTH_URL = String(process.env.HEALTH_URL || '').trim();
const OPPORTUNITIES_URL = String(process.env.OPPORTUNITIES_URL || '').trim();
const EXPECTED_BUILD_SHA = String(process.env.EXPECTED_BUILD_SHA || '').trim().toLowerCase();
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15_000);
const MAX_RELEASE_AGE_MS = Number(process.env.MAX_RELEASE_AGE_MS || 3 * 60 * 60 * 1000);
const MAX_FUTURE_SKEW_MS = Number(process.env.MAX_FUTURE_SKEW_MS || 5 * 60 * 1000);

function validSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || '').trim());
}

export function validateReleaseCoherence({ dashboard, health, opportunities, expectedBuildSha = '', now = Date.now() }) {
  const rows = [
    ['dashboard', dashboard],
    ['health', health],
    ['opportunities', opportunities]
  ];

  for (const [name, value] of rows) {
    if (!value || typeof value !== 'object') throw new Error(`${name} payload must be an object`);
    if (!validSha(value.buildSha)) throw new Error(`${name} missing valid buildSha: ${value.buildSha || '<empty>'}`);
    const generatedAt = Date.parse(value.generatedAt);
    if (!Number.isFinite(generatedAt)) throw new Error(`${name} has invalid generatedAt: ${value.generatedAt}`);
    const ageMs = now - generatedAt;
    if (ageMs < -MAX_FUTURE_SKEW_MS) throw new Error(`${name} timestamp is too far in the future: ageMs=${ageMs}`);
    if (ageMs > MAX_RELEASE_AGE_MS) throw new Error(`${name} release is stale: ageMs=${ageMs} maxAgeMs=${MAX_RELEASE_AGE_MS}`);
  }

  const buildSha = String(dashboard.buildSha).toLowerCase();
  const normalizedExpected = String(expectedBuildSha || '').trim().toLowerCase();
  if (normalizedExpected) {
    if (!validSha(normalizedExpected)) {
      throw new Error(`expected build SHA is invalid: ${normalizedExpected}`);
    }
    if (buildSha !== normalizedExpected) {
      throw new Error(`public release is not current main: expected=${normalizedExpected} actual=${buildSha}`);
    }
  }

  if (String(health.buildSha).toLowerCase() !== buildSha) {
    throw new Error(`health buildSha mismatch: dashboard=${dashboard.buildSha} health=${health.buildSha}`);
  }
  if (String(opportunities.buildSha).toLowerCase() !== buildSha) {
    throw new Error(`opportunities buildSha mismatch: dashboard=${dashboard.buildSha} opportunities=${opportunities.buildSha}`);
  }

  if (health.generatedAt !== dashboard.generatedAt) {
    throw new Error(`health generatedAt mismatch: dashboard=${dashboard.generatedAt} health=${health.generatedAt}`);
  }
  if (opportunities.generatedAt !== dashboard.generatedAt) {
    throw new Error(`opportunities generatedAt mismatch: dashboard=${dashboard.generatedAt} opportunities=${opportunities.generatedAt}`);
  }

  if (dashboard.preview !== false || health.preview !== false) {
    throw new Error('dashboard and health preview flags must both be false');
  }
  if (dashboard.ready !== true || health.ready !== true) {
    throw new Error('dashboard and health ready flags must both be true');
  }
  if (!['healthy', 'degraded'].includes(opportunities.status)) {
    throw new Error(`invalid opportunities status: ${opportunities.status}`);
  }
  if (!Array.isArray(opportunities.opportunities)) {
    throw new Error('opportunities payload must contain an array');
  }
  if (opportunities.status === 'degraded' && opportunities.opportunities.length !== 0) {
    throw new Error('degraded opportunities payload must be empty');
  }

  return {
    buildSha,
    expectedBuildSha: normalizedExpected || null,
    generatedAt: dashboard.generatedAt,
    ageSeconds: Math.max(0, Math.round((now - Date.parse(dashboard.generatedAt)) / 1000)),
    opportunityStatus: opportunities.status,
    opportunityCount: opportunities.opportunities.length
  };
}

async function fetchJson(rawUrl, label) {
  if (!rawUrl) throw new Error(`${label.toUpperCase()}_URL is required`);
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} URL must use http(s)`);
  url.searchParams.set('_radar_release_check', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { accept: 'application/json', 'cache-control': 'no-cache, no-store, max-age=0' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  return response.json();
}

function runSelfTest() {
  const now = Date.parse('2026-08-23T00:00:00Z');
  const buildSha = 'a'.repeat(40);
  const generatedAt = '2026-08-22T23:30:00Z';
  const dashboard = { buildSha, generatedAt, preview: false, ready: true };
  const health = { buildSha, generatedAt, preview: false, ready: true };
  const opportunities = { buildSha, generatedAt, status: 'degraded', opportunities: [] };
  const ok = validateReleaseCoherence({ dashboard, health, opportunities, expectedBuildSha: buildSha, now });
  if (ok.buildSha !== buildSha || ok.expectedBuildSha !== buildSha || ok.ageSeconds !== 1800) {
    throw new Error('self-test valid release failed');
  }

  let mismatchCaught = false;
  try {
    validateReleaseCoherence({ dashboard, health, opportunities: { ...opportunities, buildSha: 'b'.repeat(40) }, now });
  } catch (error) {
    mismatchCaught = String(error?.message || error).includes('buildSha mismatch');
  }
  if (!mismatchCaught) throw new Error('self-test did not reject split release');

  let staleCommitCaught = false;
  try {
    validateReleaseCoherence({ dashboard, health, opportunities, expectedBuildSha: 'c'.repeat(40), now });
  } catch (error) {
    staleCommitCaught = String(error?.message || error).includes('not current main');
  }
  if (!staleCommitCaught) throw new Error('self-test did not reject release from an older commit');
  console.log('Live release coherence self-test passed');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  const [dashboard, health, opportunities] = await Promise.all([
    fetchJson(DASHBOARD_URL, 'dashboard'),
    fetchJson(HEALTH_URL, 'health'),
    fetchJson(OPPORTUNITIES_URL, 'opportunities')
  ]);
  console.log(JSON.stringify({
    ok: true,
    ...validateReleaseCoherence({ dashboard, health, opportunities, expectedBuildSha: EXPECTED_BUILD_SHA })
  }));
}
