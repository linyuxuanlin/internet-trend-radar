#!/usr/bin/env node

const DEFAULT_BASE_URL = 'https://radar.wiki-power.com';
const EXPECTED_MODEL = process.env.EXPECTED_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';
const MIN_ATTEMPTS_FOR_EFFICIENCY_GATE = 3;
const FORBIDDEN_MODELS = new Set([
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
]);

export function validateModelUsage(debug) {
  if (!debug || typeof debug !== 'object' || !debug.ai) {
    throw new Error('debug response is missing ai diagnostics');
  }
  if (debug.preview === true) throw new Error('debug endpoint must not use preview data');

  const configured = String(debug.ai.model || '');
  if (configured !== EXPECTED_MODEL) {
    throw new Error(`configured AI model drifted: got ${configured || '<missing>'}, expected ${EXPECTED_MODEL}`);
  }

  const recentAttempts = Number(debug.ai.recent_attempts_1h || 0);
  const recentSuccesses = Number(debug.ai.recent_successes_1h || 0);
  const recentFailures = Number(debug.ai.recent_failures_1h || 0);
  const providerQuotaExhausted = Boolean(debug.ai.provider_quota?.exhausted ?? debug.ai.quota_exhausted);
  const stats = Array.isArray(debug.ai.model_stats_1h) ? debug.ai.model_stats_1h : [];
  const summedAttempts = stats.reduce((sum, row) => sum + Math.max(0, Number(row?.attempts || 0)), 0);
  const summedSuccesses = stats.reduce((sum, row) => sum + Math.max(0, Number(row?.successes || 0)), 0);
  const summedFailures = stats.reduce((sum, row) => sum + Math.max(0, Number(row?.failures || 0)), 0);

  if (recentAttempts < 0 || recentSuccesses < 0 || recentFailures < 0) {
    throw new Error('recent AI attempt counters must be non-negative');
  }
  if (recentSuccesses + recentFailures !== recentAttempts) {
    throw new Error(`recent attempt arithmetic mismatch: attempts=${recentAttempts} successes=${recentSuccesses} failures=${recentFailures}`);
  }
  if (recentAttempts > 0 && stats.length === 0) {
    throw new Error(`recent_attempts_1h=${recentAttempts} but model_stats_1h is empty`);
  }
  if (stats.length > 0 && summedAttempts !== recentAttempts) {
    throw new Error(`model_stats_1h attempt total ${summedAttempts} does not match recent_attempts_1h ${recentAttempts}`);
  }
  if (stats.length > 0 && summedSuccesses !== recentSuccesses) {
    throw new Error(`model_stats_1h success total ${summedSuccesses} does not match recent_successes_1h ${recentSuccesses}`);
  }
  if (stats.length > 0 && summedFailures !== recentFailures) {
    throw new Error(`model_stats_1h failure total ${summedFailures} does not match recent_failures_1h ${recentFailures}`);
  }

  const unexpected = [];
  for (const row of stats) {
    const model = String(row?.model || 'unknown');
    const attempts = Math.max(0, Number(row?.attempts || 0));
    const successes = Math.max(0, Number(row?.successes || 0));
    const failures = Math.max(0, Number(row?.failures || 0));
    if (successes + failures !== attempts) {
      throw new Error(`runtime model arithmetic mismatch for ${model}: attempts=${attempts} successes=${successes} failures=${failures}`);
    }
    if (attempts === 0) continue;
    if (FORBIDDEN_MODELS.has(model) || model !== EXPECTED_MODEL) {
      unexpected.push({ model, attempts, successes, failures, last_at: row?.last_at || null });
    }
  }
  if (unexpected.length) {
    throw new Error(`unexpected model used in the last hour: ${JSON.stringify(unexpected)}`);
  }

  if (!providerQuotaExhausted && recentAttempts >= MIN_ATTEMPTS_FOR_EFFICIENCY_GATE && recentSuccesses === 0) {
    throw new Error(`configured 8B model made ${recentAttempts} attempts in the last hour with zero successes while provider quota is available`);
  }

  return {
    configured_model: configured,
    recent_attempts_1h: recentAttempts,
    recent_successes_1h: recentSuccesses,
    recent_failures_1h: recentFailures,
    success_rate_1h: recentAttempts ? Math.round((recentSuccesses / recentAttempts) * 1000) / 10 : null,
    provider_quota_exhausted: providerQuotaExhausted,
    efficiency_gate_active: !providerQuotaExhausted && recentAttempts >= MIN_ATTEMPTS_FOR_EFFICIENCY_GATE,
    model_stats_1h: stats,
    runtime_model_verified: recentAttempts > 0
  };
}

function runSelfTest() {
  const good = {
    preview: false,
    ai: {
      model: EXPECTED_MODEL,
      recent_attempts_1h: 3,
      recent_successes_1h: 2,
      recent_failures_1h: 1,
      provider_quota: { exhausted: false },
      model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 3, successes: 2, failures: 1, success_rate: 66.7, last_at: '2026-08-23T15:00:00.000Z' }]
    }
  };
  const result = validateModelUsage(good);
  if (!result.runtime_model_verified) throw new Error('self-test expected runtime model to be verified');
  if (result.success_rate_1h !== 66.7) throw new Error(`unexpected self-test success rate: ${result.success_rate_1h}`);
  if (!result.efficiency_gate_active) throw new Error('self-test expected efficiency gate to be active');

  const idle = validateModelUsage({ preview: false, ai: { model: EXPECTED_MODEL, recent_attempts_1h: 0, recent_successes_1h: 0, recent_failures_1h: 0, provider_quota: { exhausted: false }, model_stats_1h: [] } });
  if (idle.runtime_model_verified) throw new Error('idle window must not claim runtime model verification');

  const quotaBlocked = validateModelUsage({
    preview: false,
    ai: {
      model: EXPECTED_MODEL,
      recent_attempts_1h: 3,
      recent_successes_1h: 0,
      recent_failures_1h: 3,
      provider_quota: { exhausted: true },
      model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 3, successes: 0, failures: 3 }]
    }
  });
  if (quotaBlocked.efficiency_gate_active) throw new Error('provider quota exhaustion must suppress zero-success efficiency failure');

  const rejected = [
    { preview: false, ai: { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', recent_attempts_1h: 0, recent_successes_1h: 0, recent_failures_1h: 0, model_stats_1h: [] } },
    { preview: false, ai: { model: EXPECTED_MODEL, recent_attempts_1h: 2, recent_successes_1h: 0, recent_failures_1h: 2, model_stats_1h: [] } },
    { preview: false, ai: { model: EXPECTED_MODEL, recent_attempts_1h: 2, recent_successes_1h: 1, recent_failures_1h: 1, model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 1, successes: 1, failures: 0 }] } },
    { preview: false, ai: { model: EXPECTED_MODEL, recent_attempts_1h: 2, recent_successes_1h: 0, recent_failures_1h: 2, model_stats_1h: [{ model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', attempts: 2, successes: 0, failures: 2 }] } },
    { preview: false, ai: { model: EXPECTED_MODEL, recent_attempts_1h: 3, recent_successes_1h: 0, recent_failures_1h: 3, provider_quota: { exhausted: false }, model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 3, successes: 0, failures: 3 }] } },
    { preview: false, ai: { model: EXPECTED_MODEL, recent_attempts_1h: 3, recent_successes_1h: 1, recent_failures_1h: 1, provider_quota: { exhausted: false }, model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 3, successes: 1, failures: 2 }] } }
  ];
  let failures = 0;
  for (const payload of rejected) {
    try { validateModelUsage(payload); } catch { failures += 1; }
  }
  if (failures !== rejected.length) throw new Error(`self-test expected ${rejected.length} rejected payloads, got ${failures}`);
  console.log('live AI model usage and efficiency watchdog self-test passed');
}

async function probe(baseUrl) {
  const endpoint = new URL('/api/debug', new URL(baseUrl));
  endpoint.searchParams.set('_runtime_model_watchdog', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const response = await fetch(endpoint, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache',
      'user-agent': 'internet-trend-radar-runtime-model-watchdog/1.1'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`debug probe HTTP ${response.status}`);
  const payload = await response.json();
  const result = validateModelUsage(payload);
  console.log(JSON.stringify({ ok: true, origin: endpoint.origin, ...result, generatedAt: payload.generatedAt || null }, null, 2));
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  runSelfTest();
} else {
  const urlArg = args.find(arg => arg.startsWith('--url='));
  const configured = urlArg ? urlArg.slice('--url='.length) : process.env.AI_MODEL_USAGE_URL || DEFAULT_BASE_URL;
  await probe(configured);
}
