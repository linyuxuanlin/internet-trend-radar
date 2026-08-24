const url = process.env.OPPORTUNITIES_URL;
if (!url) throw new Error('OPPORTUNITIES_URL is required');

const expectedBuildSha = String(process.env.EXPECTED_BUILD_SHA || '').trim().toLowerCase();
const maxAgeMs = Number(process.env.MAX_OPPORTUNITIES_AGE_MS || 10 * 60 * 1000);
const futureSkewMs = Number(process.env.MAX_FUTURE_SKEW_MS || 5 * 60 * 1000);

const target = new URL(url);
target.searchParams.set('_radar_check', String(Date.now()));
const response = await fetch(target, {
  cache: 'no-store',
  headers: {
    accept: 'application/json',
    'cache-control': 'no-cache'
  }
});
if (!response.ok) throw new Error(`opportunities HTTP ${response.status}`);

const data = await response.json();
if (!data || typeof data !== 'object') throw new Error('invalid opportunities payload');
if (!['healthy', 'degraded'].includes(data.status)) throw new Error(`invalid opportunities status: ${data.status}`);
if (!Array.isArray(data.opportunities)) throw new Error('published opportunities must be an array');

const buildSha = String(data.buildSha || '').trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(buildSha)) {
  throw new Error(`published opportunities missing valid buildSha: ${buildSha || '<empty>'}`);
}
if (expectedBuildSha && buildSha !== expectedBuildSha) {
  throw new Error(`published opportunities build mismatch: expected=${expectedBuildSha} actual=${buildSha}`);
}

const generatedAt = Date.parse(data.generatedAt);
if (!Number.isFinite(generatedAt)) throw new Error(`invalid opportunities generatedAt: ${data.generatedAt}`);
const ageMs = Date.now() - generatedAt;
if (ageMs < -futureSkewMs) throw new Error(`published opportunities timestamp is too far in the future: ageMs=${ageMs}`);
if (ageMs > maxAgeMs) throw new Error(`published opportunities are stale: ageMs=${ageMs} maxAgeMs=${maxAgeMs}`);

if (data.status === 'degraded') {
  if (data.opportunities.length !== 0) throw new Error('degraded published opportunities must be empty');
  console.log(`Live opportunities verified as truthfully degraded: 0 items build=${buildSha} ageSeconds=${Math.round(ageMs / 1000)}`);
  process.exit(0);
}

if (data.opportunities.length === 0) throw new Error('healthy published opportunities are empty');
for (const [index, opportunity] of data.opportunities.entries()) {
  if (!Array.isArray(opportunity.provenance) || opportunity.provenance.length < 1) {
    throw new Error(`healthy opportunity ${index} is missing raw provenance`);
  }
  for (const signal of opportunity.provenance) {
    if (!signal?.source_id || !signal?.upstream || !signal?.latest_captured_at) {
      throw new Error(`healthy opportunity ${index} has incomplete provenance`);
    }
  }
}
console.log(`Live opportunities verified: ${data.opportunities.length} items build=${buildSha} ageSeconds=${Math.round(ageMs / 1000)}`);
