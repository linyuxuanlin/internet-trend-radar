#!/usr/bin/env node

const DEFAULT_URL = 'https://radar.wiki-power.com/api/debug';
const EXPECTED_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const MIN_ATTEMPTS = Number(process.env.AI_OUTPUT_QUALITY_MIN_ATTEMPTS || 5);
const MIN_SUCCESS_RATE = Number(process.env.AI_OUTPUT_QUALITY_MIN_SUCCESS_RATE || 50);
const MAX_INVALID_JSON_RATE = Number(process.env.AI_OUTPUT_QUALITY_MAX_INVALID_JSON_RATE || 0.25);
const MAX_TITLE_ECHO_RATE = Number(process.env.AI_OUTPUT_QUALITY_MAX_TITLE_ECHO_RATE || 0.25);
const MAX_COMBINED_WASTE_RATE = Number(process.env.AI_OUTPUT_QUALITY_MAX_COMBINED_WASTE_RATE || 0.4);

function countReason(reasons, name) {
  return (Array.isArray(reasons) ? reasons : [])
    .filter(item => String(item?.reason || '') === name)
    .reduce((sum, item) => sum + Number(item?.count || 0), 0);
}

function normalizeModelWindow(model, window) {
  if (!model) return null;
  const attempts = Number(model.attempts || 0);
  const successes = Number(model.successes || 0);
  const failures = Number(model.failures || 0);
  if (![attempts, successes, failures].every(Number.isFinite)) throw new Error(`${window} model counters must be numeric`);
  if (attempts < 0 || successes < 0 || failures < 0) throw new Error(`${window} model counters must not be negative`);
  if (successes + failures !== attempts) throw new Error(`${window} model arithmetic mismatch: ${successes}+${failures} != ${attempts}`);
  return {
    window,
    attempts,
    successes,
    failures,
    failureReasons: Array.isArray(model.failure_reasons) ? model.failure_reasons : []
  };
}

function chooseMeasurementWindow(ai) {
  const attempts1h = Number(ai.recent_attempts_1h || 0);
  const successes1h = Number(ai.recent_successes_1h || 0);
  const failures1h = Number(ai.recent_failures_1h || 0);
  if (![attempts1h, successes1h, failures1h].every(Number.isFinite)) throw new Error('AI one-hour counters must be numeric');
  if (attempts1h < 0 || successes1h < 0 || failures1h < 0) throw new Error('AI one-hour counters must not be negative');
  if (successes1h + failures1h !== attempts1h) throw new Error(`AI one-hour arithmetic mismatch: ${successes1h}+${failures1h} != ${attempts1h}`);

  const stats1h = Array.isArray(ai.model_stats_1h) ? ai.model_stats_1h : [];
  const model1h = stats1h.find(item => item?.model === EXPECTED_MODEL) || null;
  if (attempts1h > 0 && !model1h) throw new Error(`one-hour attempts exist but ${EXPECTED_MODEL} is absent from model_stats_1h`);
  if (model1h && Number(model1h.attempts || 0) !== attempts1h) {
    throw new Error(`runtime model attempts mismatch: model=${model1h.attempts} total=${attempts1h}`);
  }

  if (attempts1h >= MIN_ATTEMPTS) {
    return {
      window: '1h',
      attempts: attempts1h,
      successes: successes1h,
      failures: failures1h,
      failureReasons: Array.isArray(ai.recent_failure_reasons_1h) ? ai.recent_failure_reasons_1h : []
    };
  }

  const stats24h = Array.isArray(ai.model_stats_24h) ? ai.model_stats_24h : [];
  const model24h = normalizeModelWindow(stats24h.find(item => item?.model === EXPECTED_MODEL) || null, '24h');
  if (model24h && model24h.attempts >= MIN_ATTEMPTS) return model24h;

  return {
    window: '1h',
    attempts: attempts1h,
    successes: successes1h,
    failures: failures1h,
    failureReasons: Array.isArray(ai.recent_failure_reasons_1h) ? ai.recent_failure_reasons_1h : []
  };
}

export function analyzeOutputQuality(debug) {
  if (!debug || typeof debug !== 'object' || !debug.ai) throw new Error('debug payload is missing ai diagnostics');
  const ai = debug.ai;
  if (ai.model !== EXPECTED_MODEL) throw new Error(`production model drifted: ${ai.model || 'missing'} != ${EXPECTED_MODEL}`);

  const measurement = chooseMeasurementWindow(ai);
  const { window, attempts, successes, failures, failureReasons } = measurement;
  const invalidJson = countReason(failureReasons, 'invalid-json');
  const titleEcho = countReason(failureReasons, 'title-echo');
  const successRate = attempts ? (successes / attempts) * 100 : null;
  const invalidJsonRate = attempts ? invalidJson / attempts : 0;
  const titleEchoRate = attempts ? titleEcho / attempts : 0;
  const combinedWasteRate = attempts ? (invalidJson + titleEcho) / attempts : 0;
  const providerBlocked = ai.effective_blocker === 'provider-daily-quota-exhausted' || ai.blocked_reason === 'provider-daily-quota-exhausted';
  const enoughSample = attempts >= MIN_ATTEMPTS;

  const result = {
    ok: true,
    model: EXPECTED_MODEL,
    measurement_window: window,
    attempts,
    successes,
    failures,
    success_rate: successRate == null ? null : Math.round(successRate * 10) / 10,
    invalid_json: invalidJson,
    invalid_json_rate: Math.round(invalidJsonRate * 1000) / 1000,
    title_echo: titleEcho,
    title_echo_rate: Math.round(titleEchoRate * 1000) / 1000,
    combined_quality_waste: invalidJson + titleEcho,
    combined_quality_waste_rate: Math.round(combinedWasteRate * 1000) / 1000,
    provider_blocked: providerBlocked,
    enough_sample: enoughSample,
    status: enoughSample ? 'measured' : 'waiting-for-sample'
  };

  if (!enoughSample || providerBlocked) return result;
  if (successRate < MIN_SUCCESS_RATE) throw new Error(`8B success rate regression: ${result.success_rate}% < ${MIN_SUCCESS_RATE}%`);
  if (invalidJsonRate > MAX_INVALID_JSON_RATE) throw new Error(`invalid-json regression: ${result.invalid_json_rate} > ${MAX_INVALID_JSON_RATE}`);
  if (titleEchoRate > MAX_TITLE_ECHO_RATE) throw new Error(`title-echo regression: ${result.title_echo_rate} > ${MAX_TITLE_ECHO_RATE}`);
  if (combinedWasteRate > MAX_COMBINED_WASTE_RATE) throw new Error(`combined output waste regression: ${result.combined_quality_waste_rate} > ${MAX_COMBINED_WASTE_RATE}`);
  return result;
}

function selfTest() {
  const base = {
    ai: {
      model: EXPECTED_MODEL,
      recent_attempts_1h: 10,
      recent_successes_1h: 7,
      recent_failures_1h: 3,
      recent_failure_reasons_1h: [
        { reason: 'invalid-json', count: 1 },
        { reason: 'title-echo', count: 1 },
        { reason: 'too-short', count: 1 }
      ],
      model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 10, successes: 7, failures: 3, success_rate: 70, failure_reasons: [{ reason: 'invalid-json', count: 1 }, { reason: 'title-echo', count: 1 }, { reason: 'too-short', count: 1 }] }],
      model_stats_24h: [{ model: EXPECTED_MODEL, attempts: 20, successes: 14, failures: 6, success_rate: 70, failure_reasons: [{ reason: 'invalid-json', count: 2 }, { reason: 'title-echo', count: 2 }, { reason: 'too-short', count: 2 }] }],
      effective_blocker: null,
      blocked_reason: null
    }
  };
  const good = analyzeOutputQuality(base);
  if (!good.ok || good.status !== 'measured' || good.measurement_window !== '1h' || good.combined_quality_waste !== 2) throw new Error('good output-quality fixture failed');

  const paced = analyzeOutputQuality({
    ai: {
      ...base.ai,
      recent_attempts_1h: 1,
      recent_successes_1h: 1,
      recent_failures_1h: 0,
      recent_failure_reasons_1h: [],
      model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 1, successes: 1, failures: 0, failure_reasons: [] }]
    }
  });
  if (paced.status !== 'measured' || paced.measurement_window !== '24h' || paced.attempts !== 20) {
    throw new Error('paced low-volume fixture should fall back to model-specific 24h quality data');
  }

  const waiting = analyzeOutputQuality({ ai: { ...base.ai, recent_attempts_1h: 0, recent_successes_1h: 0, recent_failures_1h: 0, recent_failure_reasons_1h: [], model_stats_1h: [], model_stats_24h: [] } });
  if (waiting.status !== 'waiting-for-sample') throw new Error('empty sample should wait instead of failing');

  const badFixtures = [
    { ...base, ai: { ...base.ai, recent_successes_1h: 4, recent_failures_1h: 6, model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 10, successes: 4, failures: 6 }] } },
    { ...base, ai: { ...base.ai, recent_successes_1h: 6, recent_failures_1h: 4, recent_failure_reasons_1h: [{ reason: 'invalid-json', count: 3 }, { reason: 'too-short', count: 1 }], model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 10, successes: 6, failures: 4 }] } },
    { ...base, ai: { ...base.ai, recent_successes_1h: 6, recent_failures_1h: 4, recent_failure_reasons_1h: [{ reason: 'title-echo', count: 3 }, { reason: 'too-short', count: 1 }], model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 10, successes: 6, failures: 4 }] } },
    { ...base, ai: { ...base.ai, recent_successes_1h: 5, recent_failures_1h: 5, recent_failure_reasons_1h: [{ reason: 'invalid-json', count: 2 }, { reason: 'title-echo', count: 3 }], model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 10, successes: 5, failures: 5 }] } }
  ];
  let rejected = 0;
  for (const fixture of badFixtures) {
    try { analyzeOutputQuality(fixture); } catch { rejected += 1; }
  }
  if (rejected !== badFixtures.length) throw new Error(`expected ${badFixtures.length} quality regressions, rejected ${rejected}`);
  console.log('AI output quality watchdog self-test passed');
}

async function probe(url) {
  const target = new URL(url);
  target.searchParams.set('_quality_watchdog', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const response = await fetch(target, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache',
      'user-agent': 'internet-trend-radar-ai-output-quality-watchdog/1.0'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`AI debug probe HTTP ${response.status}`);
  const debug = await response.json();
  console.log(JSON.stringify(analyzeOutputQuality(debug), null, 2));
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) selfTest();
else await probe(process.env.AI_DEBUG_URL || DEFAULT_URL);
