const RELEASE_URL = String(process.env.RELEASE_URL || '').trim();
const EXPECTED_BUILD_SHA = String(process.env.EXPECTED_BUILD_SHA || '').trim().toLowerCase();
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15_000);
const MAX_RELEASE_AGE_MS = Number(process.env.MAX_RELEASE_AGE_MS || 3 * 60 * 60 * 1000);
const MAX_FUTURE_SKEW_MS = Number(process.env.MAX_FUTURE_SKEW_MS || 5 * 60 * 1000);

function validSha(value) { return /^[0-9a-f]{40}$/i.test(String(value || '').trim()); }

export function validateReceipt(receipt, { expectedBuildSha = '', now = Date.now() } = {}) {
  if (!receipt || typeof receipt !== 'object') throw new Error('release receipt must be an object');
  if (!validSha(receipt.buildSha)) throw new Error(`release receipt missing valid buildSha: ${receipt.buildSha || '<empty>'}`);
  const generatedAt = Date.parse(receipt.generatedAt);
  if (!Number.isFinite(generatedAt)) throw new Error(`release receipt has invalid generatedAt: ${receipt.generatedAt}`);
  const ageMs = now - generatedAt;
  if (ageMs < -MAX_FUTURE_SKEW_MS) throw new Error(`release receipt timestamp is too far in the future: ageMs=${ageMs}`);
  if (ageMs > MAX_RELEASE_AGE_MS) throw new Error(`release receipt is stale: ageMs=${ageMs} maxAgeMs=${MAX_RELEASE_AGE_MS}`);
  if (receipt.preview !== false || receipt.ready !== true) throw new Error('release receipt must describe a real-data ready snapshot');
  if (!Number.isInteger(receipt.topics) || receipt.topics < 1) throw new Error(`release receipt has invalid topics count: ${receipt.topics}`);
  if (!Number.isInteger(receipt.healthySources) || receipt.healthySources < 1) throw new Error(`release receipt has invalid healthySources: ${receipt.healthySources}`);
  if (!Number.isInteger(receipt.directCnSources) || receipt.directCnSources < 1) throw new Error(`release receipt has invalid directCnSources: ${receipt.directCnSources}`);
  if (!['healthy', 'degraded'].includes(receipt.opportunitiesStatus)) throw new Error(`release receipt has invalid opportunitiesStatus: ${receipt.opportunitiesStatus}`);
  const expected = String(expectedBuildSha || '').trim().toLowerCase();
  if (expected) {
    if (!validSha(expected)) throw new Error(`expected build SHA is invalid: ${expected}`);
    if (String(receipt.buildSha).toLowerCase() !== expected) throw new Error(`release receipt is not current main: expected=${expected} actual=${receipt.buildSha}`);
  }
  return { buildSha: String(receipt.buildSha).toLowerCase(), generatedAt: receipt.generatedAt, ageSeconds: Math.max(0, Math.round(ageMs / 1000)), topics: receipt.topics, healthySources: receipt.healthySources, directCnSources: receipt.directCnSources, aiMatched: Number(receipt.aiMatched || 0), opportunitiesStatus: receipt.opportunitiesStatus, opportunities: Number(receipt.opportunities || 0) };
}

async function fetchReceipt(rawUrl) {
  if (!rawUrl) throw new Error('RELEASE_URL is required');
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RELEASE_URL must use http(s)');
  url.searchParams.set('_radar_receipt_check', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json', 'cache-control': 'no-cache, no-store, max-age=0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`release receipt HTTP ${response.status}`);
  return response.json();
}

if (process.argv.includes('--self-test')) {
  const buildSha = 'a'.repeat(40);
  const now = Date.parse('2026-08-23T03:00:00Z');
  const receipt = { buildSha, generatedAt: '2026-08-23T02:30:00Z', preview: false, ready: true, topics: 300, healthySources: 14, directCnSources: 10, aiMatched: 5, opportunitiesStatus: 'degraded', opportunities: 0 };
  const result = validateReceipt(receipt, { expectedBuildSha: buildSha, now });
  if (result.ageSeconds !== 1800 || result.topics !== 300) throw new Error('release receipt self-test failed');
  let mismatch = false;
  try { validateReceipt(receipt, { expectedBuildSha: 'b'.repeat(40), now }); } catch (error) { mismatch = String(error?.message || error).includes('not current main'); }
  if (!mismatch) throw new Error('release receipt self-test did not reject old build');
  console.log('Release receipt self-test passed');
} else {
  const receipt = await fetchReceipt(RELEASE_URL);
  console.log(JSON.stringify({ ok: true, ...validateReceipt(receipt, { expectedBuildSha: EXPECTED_BUILD_SHA }) }));
}
