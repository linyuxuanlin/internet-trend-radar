#!/usr/bin/env node

const DEFAULT_URL = 'https://internet-trend-radar.linyuxuanlin.workers.dev/api/debug';
const EXPECTED_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const DEFAULT_ROLLOUT_AT = '2026-08-24T03:33:53.000Z';
const MIN_ATTEMPTS = Number(process.env.AI_OUTPUT_QUALITY_MIN_ATTEMPTS || 5);

function parseTime(value, label) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a valid ISO timestamp`);
  return ms;
}

export function analyzeRolloutWindow(debug, now = new Date(), rolloutAt = process.env.AI_QUALITY_ROLLOUT_AT || DEFAULT_ROLLOUT_AT) {
  if (!debug || typeof debug !== 'object' || !debug.ai) throw new Error('debug payload is missing ai diagnostics');
  const ai = debug.ai;
  if (ai.model !== EXPECTED_MODEL) throw new Error(`production model drifted: ${ai.model || 'missing'} != ${EXPECTED_MODEL}`);

  const nowMs = now instanceof Date ? now.getTime() : parseTime(now, 'now');
  const rolloutMs = parseTime(rolloutAt, 'AI quality rollout timestamp');
  if (!Number.isFinite(nowMs)) throw new Error('now must be valid');
  if (nowMs < rolloutMs - 5 * 60 * 1000) throw new Error('clock is materially before AI quality rollout');

  const clean24hAtMs = rolloutMs + 24 * 60 * 60 * 1000;
  const attempts1h = Number(ai.recent_attempts_1h || 0);
  const successes1h = Number(ai.recent_successes_1h || 0);
  const failures1h = Number(ai.recent_failures_1h || 0);
  if (![attempts1h, successes1h, failures1h].every(Number.isFinite)) throw new Error('one-hour counters must be numeric');
  if (successes1h + failures1h !== attempts1h) throw new Error(`one-hour arithmetic mismatch: ${successes1h}+${failures1h} != ${attempts1h}`);

  const model1h = (Array.isArray(ai.model_stats_1h) ? ai.model_stats_1h : []).find(item => item?.model === EXPECTED_MODEL) || null;
  if (attempts1h > 0 && !model1h) throw new Error('one-hour attempts exist without expected runtime model stats');
  if (model1h && Number(model1h.attempts || 0) !== attempts1h) throw new Error('one-hour runtime model attempts do not match total attempts');

  const stats24h = Array.isArray(ai.model_stats_24h) ? ai.model_stats_24h : [];
  const model24h = stats24h.find(item => item?.model === EXPECTED_MODEL) || null;
  const attempts24h = Number(model24h?.attempts || 0);

  const hasFresh1hSample = attempts1h >= MIN_ATTEMPTS;
  const clean24h = nowMs >= clean24hAtMs;
  const legacy24hContaminated = !clean24h && attempts24h > 0;

  return {
    ok: true,
    model: EXPECTED_MODEL,
    rollout_at: new Date(rolloutMs).toISOString(),
    clean_24h_at: new Date(clean24hAtMs).toISOString(),
    clean_24h: clean24h,
    legacy_24h_contaminated: legacy24hContaminated,
    attempts_1h: attempts1h,
    attempts_24h: attempts24h,
    has_fresh_1h_sample: hasFresh1hSample,
    quality_window_ready: hasFresh1hSample || clean24h,
    status: hasFresh1hSample ? 'fresh-1h-sample' : clean24h ? 'clean-24h-window' : 'warming-up-post-rollout'
  };
}

function selfTest() {
  const base = {
    ai: {
      model: EXPECTED_MODEL,
      recent_attempts_1h: 1,
      recent_successes_1h: 1,
      recent_failures_1h: 0,
      model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 1, successes: 1, failures: 0 }],
      model_stats_24h: [{ model: EXPECTED_MODEL, attempts: 100, successes: 63, failures: 37 }]
    }
  };
  const warming = analyzeRolloutWindow(base, new Date('2026-08-24T06:30:00Z'));
  if (warming.status !== 'warming-up-post-rollout' || !warming.legacy_24h_contaminated || warming.quality_window_ready) {
    throw new Error('pre-clean 24h fixture must not treat legacy mixed stats as post-rollout quality');
  }

  const fresh = analyzeRolloutWindow({ ai: { ...base.ai, recent_attempts_1h: 5, recent_successes_1h: 4, recent_failures_1h: 1, model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 5, successes: 4, failures: 1 }] } }, new Date('2026-08-24T07:00:00Z'));
  if (fresh.status !== 'fresh-1h-sample' || !fresh.quality_window_ready) throw new Error('fresh one-hour sample should be usable before 24h cleanup');

  const clean = analyzeRolloutWindow(base, new Date('2026-08-25T04:00:00Z'));
  if (clean.status !== 'clean-24h-window' || clean.legacy_24h_contaminated || !clean.quality_window_ready) throw new Error('24h stats should be clean after rollout ages out');
  console.log('AI quality rollout-window self-test passed');
}

async function probe(url) {
  const target = new URL(url);
  target.searchParams.set('_quality_rollout_watchdog', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const response = await fetch(target, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache',
      'user-agent': 'internet-trend-radar-ai-quality-rollout-watchdog/1.0'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`AI debug probe HTTP ${response.status}`);
  const debug = await response.json();
  console.log(JSON.stringify(analyzeRolloutWindow(debug), null, 2));
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) selfTest();
else await probe(process.env.AI_DEBUG_URL || DEFAULT_URL);
