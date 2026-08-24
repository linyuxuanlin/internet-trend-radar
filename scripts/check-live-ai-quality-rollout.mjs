#!/usr/bin/env node

const DEFAULT_URL = 'https://radar.wiki-power.com/api/ai-quality-rollout';
const EXPECTED_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const EXPECTED_SINCE = process.env.AI_QUALITY_ROLLOUT_AT || '2026-08-24T03:33:53.000Z';
const MIN_ATTEMPTS = Number(process.env.AI_ROLLOUT_QUALITY_MIN_ATTEMPTS || 5);
const MIN_SUCCESS_RATE = Number(process.env.AI_ROLLOUT_QUALITY_MIN_SUCCESS_RATE || 50);
const MAX_INVALID_JSON_RATE = Number(process.env.AI_ROLLOUT_QUALITY_MAX_INVALID_JSON_RATE || 0.25);
const MAX_TITLE_ECHO_RATE = Number(process.env.AI_ROLLOUT_QUALITY_MAX_TITLE_ECHO_RATE || 0.25);
const MAX_COMBINED_WASTE_RATE = Number(process.env.AI_ROLLOUT_QUALITY_MAX_COMBINED_WASTE_RATE || 0.40);

function finiteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be numeric`);
  return n;
}

export function analyzeExactRolloutQuality(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('rollout payload must be an object');
  if (payload.ok !== true) throw new Error(`rollout endpoint is not ready: ${payload.error || 'unknown error'}`);
  if (payload.preview !== false) throw new Error('rollout endpoint must never return preview data');
  if (payload.model !== EXPECTED_MODEL) throw new Error(`production rollout model drifted: ${payload.model || 'missing'} != ${EXPECTED_MODEL}`);
  if (payload.since !== EXPECTED_SINCE) throw new Error(`rollout boundary drifted: ${payload.since || 'missing'} != ${EXPECTED_SINCE}`);
  if (!Number.isFinite(Date.parse(payload.since))) throw new Error('rollout since timestamp is invalid');

  const attempts = finiteNumber(payload.attempts, 'attempts');
  const successes = finiteNumber(payload.successes, 'successes');
  const failures = finiteNumber(payload.failures, 'failures');
  const successRate = finiteNumber(payload.success_rate, 'success_rate');
  if (attempts < 0 || successes < 0 || failures < 0) throw new Error('rollout counters must be non-negative');
  if (successes + failures !== attempts) throw new Error(`rollout arithmetic mismatch: ${successes}+${failures} != ${attempts}`);
  const expectedRate = attempts ? Math.round((successes / attempts) * 1000) / 10 : 0;
  if (Math.abs(successRate - expectedRate) > 0.05) throw new Error(`success_rate mismatch: ${successRate} != ${expectedRate}`);

  const reasons = Array.isArray(payload.failure_reasons) ? payload.failure_reasons : [];
  const reasonCounts = new Map();
  let reasonTotal = 0;
  for (const item of reasons) {
    const reason = String(item?.reason || '').trim();
    const count = finiteNumber(item?.count, `failure reason ${reason || 'unknown'} count`);
    if (!reason || count < 0) throw new Error('failure reasons must contain a non-negative count and reason');
    if (reason === 'success') throw new Error('failure_reasons must not contain success');
    if (reasonCounts.has(reason)) throw new Error(`duplicate failure reason: ${reason}`);
    reasonCounts.set(reason, count);
    reasonTotal += count;
    if (item?.last_at && !Number.isFinite(Date.parse(item.last_at))) throw new Error(`invalid last_at for ${reason}`);
  }
  if (reasonTotal !== failures) throw new Error(`failure reason total mismatch: ${reasonTotal} != ${failures}`);

  const invalidJson = Number(reasonCounts.get('invalid-json') || 0);
  const titleEcho = Number(reasonCounts.get('title-echo') || 0);
  const invalidJsonRate = attempts ? invalidJson / attempts : 0;
  const titleEchoRate = attempts ? titleEcho / attempts : 0;
  const combinedWasteRate = attempts ? (invalidJson + titleEcho) / attempts : 0;
  const measured = attempts >= MIN_ATTEMPTS;

  if (measured) {
    if (successRate < MIN_SUCCESS_RATE) throw new Error(`post-rollout success rate regressed: ${successRate}% < ${MIN_SUCCESS_RATE}%`);
    if (invalidJsonRate > MAX_INVALID_JSON_RATE) throw new Error(`post-rollout invalid-json rate regressed: ${(invalidJsonRate * 100).toFixed(1)}%`);
    if (titleEchoRate > MAX_TITLE_ECHO_RATE) throw new Error(`post-rollout title-echo rate regressed: ${(titleEchoRate * 100).toFixed(1)}%`);
    if (combinedWasteRate > MAX_COMBINED_WASTE_RATE) throw new Error(`post-rollout combined waste rate regressed: ${(combinedWasteRate * 100).toFixed(1)}%`);
  }

  return {
    ok: true,
    preview: false,
    model: payload.model,
    since: payload.since,
    attempts,
    successes,
    failures,
    success_rate: successRate,
    invalid_json: invalidJson,
    invalid_json_rate: Math.round(invalidJsonRate * 1000) / 10,
    title_echo: titleEcho,
    title_echo_rate: Math.round(titleEchoRate * 1000) / 10,
    combined_waste_rate: Math.round(combinedWasteRate * 1000) / 10,
    status: measured ? 'measured' : 'waiting-for-post-rollout-sample'
  };
}

function selfTest() {
  const good = analyzeExactRolloutQuality({
    ok: true,
    preview: false,
    since: EXPECTED_SINCE,
    model: EXPECTED_MODEL,
    attempts: 10,
    successes: 7,
    failures: 3,
    success_rate: 70,
    failure_reasons: [
      { reason: 'invalid-json', count: 2, last_at: '2026-08-24T07:08:00.000Z' },
      { reason: 'title-echo', count: 1, last_at: '2026-08-24T07:06:00.000Z' }
    ]
  });
  if (good.status !== 'measured' || good.combined_waste_rate !== 30) throw new Error('good rollout fixture was not measured correctly');

  const sparse = analyzeExactRolloutQuality({
    ok: true,
    preview: false,
    since: EXPECTED_SINCE,
    model: EXPECTED_MODEL,
    attempts: 2,
    successes: 1,
    failures: 1,
    success_rate: 50,
    failure_reasons: [{ reason: 'invalid-json', count: 1 }]
  });
  if (sparse.status !== 'waiting-for-post-rollout-sample') throw new Error('sparse rollout fixture should wait for more samples');

  let failed = false;
  try {
    analyzeExactRolloutQuality({
      ok: true,
      preview: false,
      since: EXPECTED_SINCE,
      model: EXPECTED_MODEL,
      attempts: 10,
      successes: 4,
      failures: 6,
      success_rate: 40,
      failure_reasons: [{ reason: 'invalid-json', count: 3 }, { reason: 'title-echo', count: 3 }]
    });
  } catch {
    failed = true;
  }
  if (!failed) throw new Error('quality regression fixture should fail');
  console.log('Exact live AI rollout quality self-test passed');
}

async function probe(url) {
  const target = new URL(url);
  target.searchParams.set('_rollout_quality_watchdog', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const response = await fetch(target, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache',
      'user-agent': 'internet-trend-radar-exact-ai-rollout-watchdog/1.0'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`AI rollout quality probe HTTP ${response.status}`);
  const payload = await response.json();
  console.log(JSON.stringify(analyzeExactRolloutQuality(payload), null, 2));
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) selfTest();
else await probe(process.env.AI_QUALITY_ROLLOUT_URL || DEFAULT_URL);
