const RELEASE_URL = String(process.env.RELEASE_URL || '').trim();
const EXPECTED_BUILD_SHA = String(process.env.EXPECTED_BUILD_SHA || '').trim().toLowerCase();
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15_000);
const MAX_RELEASE_AGE_MS = Number(process.env.MAX_RELEASE_AGE_MS || 3 * 60 * 60 * 1000);
const MAX_FUTURE_SKEW_MS = Number(process.env.MAX_FUTURE_SKEW_MS || 5 * 60 * 1000);
const SOCIAL_IDS = ['weibo', 'zhihu', 'douyin'];

function validSha(value) { return /^[0-9a-f]{40}$/i.test(String(value || '').trim()); }

function stageFallbackDepth(stage) {
  if (stage === 'official-direct') return 0;
  const match = /^mirror-fallback-(\d+)$/.exec(String(stage || ''));
  if (!match) throw new Error(`release receipt has unsupported social upstream stage: ${stage || '<empty>'}`);
  const depth = Number(match[1]);
  if (!Number.isInteger(depth) || depth < 1) throw new Error(`release receipt has invalid social fallback depth: ${stage}`);
  return depth;
}

function validateSocialUpstreams(receipt) {
  if (!receipt.socialUpstreams || typeof receipt.socialUpstreams !== 'object') throw new Error('release receipt missing socialUpstreams');
  const fallback = [];
  let maxDepth = 0;
  for (const id of SOCIAL_IDS) {
    const row = receipt.socialUpstreams[id];
    if (!row || typeof row !== 'object') throw new Error(`release receipt missing ${id} upstream provenance`);
    if (!/^https:\/\//.test(String(row.upstream || ''))) throw new Error(`release receipt ${id} upstream must use HTTPS`);
    if (!row.provider || row.provider === 'unknown') throw new Error(`release receipt ${id} missing upstream provider`);
    if (!row.stage || ['unknown', 'failed'].includes(row.stage)) throw new Error(`release receipt ${id} missing upstream stage`);
    const depth = stageFallbackDepth(row.stage);
    if (Number(row.fallbackDepth) !== depth) throw new Error(`release receipt ${id} fallbackDepth mismatch: declared=${row.fallbackDepth} actual=${depth}`);
    maxDepth = Math.max(maxDepth, depth);
    if (depth > 0) fallback.push(id);
  }
  const declaredFallback = Array.isArray(receipt.fallbackSocialSources) ? receipt.fallbackSocialSources : [];
  if (JSON.stringify([...declaredFallback].sort()) !== JSON.stringify([...fallback].sort())) {
    throw new Error(`release receipt fallbackSocialSources mismatch: declared=${declaredFallback.join(',')} actual=${fallback.join(',')}`);
  }
  if (Number(receipt.socialFallbackMaxDepth) !== maxDepth) {
    throw new Error(`release receipt socialFallbackMaxDepth mismatch: declared=${receipt.socialFallbackMaxDepth} actual=${maxDepth}`);
  }
  const expectedSeverity = maxDepth === 0 ? 'none' : maxDepth === 1 ? 'fallback' : 'deep-fallback';
  if (receipt.socialFallbackSeverity !== expectedSeverity) {
    throw new Error(`release receipt socialFallbackSeverity mismatch: declared=${receipt.socialFallbackSeverity} actual=${expectedSeverity}`);
  }
  return { fallback, maxDepth, severity: expectedSeverity };
}

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
  const social = validateSocialUpstreams(receipt);
  const expected = String(expectedBuildSha || '').trim().toLowerCase();
  if (expected) {
    if (!validSha(expected)) throw new Error(`expected build SHA is invalid: ${expected}`);
    if (String(receipt.buildSha).toLowerCase() !== expected) throw new Error(`release receipt is not current main: expected=${expected} actual=${receipt.buildSha}`);
  }
  return { buildSha: String(receipt.buildSha).toLowerCase(), generatedAt: receipt.generatedAt, ageSeconds: Math.max(0, Math.round(ageMs / 1000)), topics: receipt.topics, healthySources: receipt.healthySources, directCnSources: receipt.directCnSources, socialUpstreams: receipt.socialUpstreams, fallbackSocialSources: social.fallback, socialFallbackActive: social.fallback.length > 0, socialFallbackMaxDepth: social.maxDepth, socialFallbackSeverity: social.severity, aiMatched: Number(receipt.aiMatched || 0), opportunitiesStatus: receipt.opportunitiesStatus, opportunities: Number(receipt.opportunities || 0) };
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
  const receipt = {
    buildSha,
    generatedAt: '2026-08-23T02:30:00Z',
    preview: false,
    ready: true,
    topics: 300,
    healthySources: 15,
    directCnSources: 10,
    socialUpstreams: {
      weibo: { provider: 'weibo-official', stage: 'official-direct', upstream: 'https://weibo.com/ajax/side/hotSearch', fallbackDepth: 0 },
      zhihu: { provider: 'zhihu-official', stage: 'official-direct', upstream: 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total', fallbackDepth: 0 },
      douyin: { provider: 'aa1', stage: 'mirror-fallback-1', upstream: 'https://v.api.aa1.cn/api/douyin-hot/index.php?aa1=hot', fallbackDepth: 1 }
    },
    fallbackSocialSources: ['douyin'],
    socialFallbackMaxDepth: 1,
    socialFallbackSeverity: 'fallback',
    aiMatched: 5,
    opportunitiesStatus: 'degraded',
    opportunities: 0
  };
  const result = validateReceipt(receipt, { expectedBuildSha: buildSha, now });
  if (result.ageSeconds !== 1800 || result.topics !== 300 || result.socialFallbackActive !== true || result.fallbackSocialSources[0] !== 'douyin' || result.socialFallbackMaxDepth !== 1 || result.socialFallbackSeverity !== 'fallback') throw new Error('release receipt self-test failed');
  let mismatch = false;
  try { validateReceipt(receipt, { expectedBuildSha: 'b'.repeat(40), now }); } catch (error) { mismatch = String(error?.message || error).includes('not current main'); }
  if (!mismatch) throw new Error('release receipt self-test did not reject old build');
  let provenanceMismatch = false;
  try { validateReceipt({ ...receipt, fallbackSocialSources: [] }, { now }); } catch (error) { provenanceMismatch = String(error?.message || error).includes('fallbackSocialSources mismatch'); }
  if (!provenanceMismatch) throw new Error('release receipt self-test did not reject social fallback mismatch');
  let depthMismatch = false;
  try { validateReceipt({ ...receipt, socialFallbackMaxDepth: 2 }, { now }); } catch (error) { depthMismatch = String(error?.message || error).includes('socialFallbackMaxDepth mismatch'); }
  if (!depthMismatch) throw new Error('release receipt self-test did not reject social fallback depth mismatch');
  let deepFallbackMismatch = false;
  const deepReceipt = {
    ...receipt,
    socialUpstreams: { ...receipt.socialUpstreams, douyin: { ...receipt.socialUpstreams.douyin, provider: 'fanyia', stage: 'mirror-fallback-3', fallbackDepth: 3 } },
    socialFallbackMaxDepth: 3,
    socialFallbackSeverity: 'fallback'
  };
  try { validateReceipt(deepReceipt, { now }); } catch (error) { deepFallbackMismatch = String(error?.message || error).includes('socialFallbackSeverity mismatch'); }
  if (!deepFallbackMismatch) throw new Error('release receipt self-test did not reject deep fallback severity mismatch');
  console.log('Release receipt self-test passed');
} else {
  const receipt = await fetchReceipt(RELEASE_URL);
  console.log(JSON.stringify({ ok: true, ...validateReceipt(receipt, { expectedBuildSha: EXPECTED_BUILD_SHA }) }));
}
