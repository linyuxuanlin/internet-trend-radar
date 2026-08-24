const DEFAULT_ENDPOINT = 'https://radar.wiki-power.com/api/debug';
const EXPECTED_MODEL = process.env.EXPECTED_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';
const RESET_RECOVERY_GRACE_MINUTES = Math.max(30, Number(process.env.AI_RESET_RECOVERY_GRACE_MINUTES || 75));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function latestModelAttemptAt(stats, model) {
  const rows = Array.isArray(stats) ? stats : [];
  const matches = rows.filter(row => Number(row?.attempts || 0) > 0 && String(row?.model || '') === model);
  const timestamps = matches.map(row => Date.parse(row?.last_at || '')).filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

export function evaluateResetRecovery(payload, now = new Date()) {
  assert(payload && typeof payload === 'object', 'debug payload must be an object');
  assert(payload.preview !== true, 'debug endpoint must not use preview data');
  const ai = payload.ai || {};
  const model = String(ai.model || '');
  assert(model === EXPECTED_MODEL, `production AI model drifted: got ${model || '<missing>'}, expected ${EXPECTED_MODEL}`);

  const retryAt = ai.provider_quota?.retry_after || ai.quota_retry_after || null;
  const providerExhausted = Boolean(ai.provider_quota?.exhausted ?? ai.quota_exhausted);
  const effectiveBlocker = ai.effective_blocker || ai.blocked_reason || null;
  const attempts1h = Number(ai.recent_attempts_1h || 0);
  const successes1h = Number(ai.recent_successes_1h || 0);
  const failures1h = Number(ai.recent_failures_1h || 0);
  assert(attempts1h >= 0 && successes1h >= 0 && failures1h >= 0, '1h counters must be non-negative');
  assert(successes1h + failures1h === attempts1h, `1h counters inconsistent: attempts=${attempts1h} successes=${successes1h} failures=${failures1h}`);

  const stats = Array.isArray(ai.model_stats_1h) ? ai.model_stats_1h : [];
  const statAttempts = stats.reduce((sum, row) => sum + Number(row?.attempts || 0), 0);
  assert(statAttempts === attempts1h, `model_stats_1h attempts=${statAttempts} do not match recent_attempts_1h=${attempts1h}`);

  const foreign = stats.filter(row => Number(row?.attempts || 0) > 0 && String(row?.model || '') !== EXPECTED_MODEL);
  assert(foreign.length === 0, `unexpected runtime model(s): ${foreign.map(row => row.model).join(', ')}`);

  const retryMs = retryAt ? Date.parse(retryAt) : NaN;
  const retryPassed = Number.isFinite(retryMs) && now.getTime() >= retryMs;
  const recoveryGracePassed = retryPassed && now.getTime() >= retryMs + RESET_RECOVERY_GRACE_MINUTES * 60_000;
  if (retryPassed) {
    assert(!providerExhausted, `provider quota still marked exhausted after retry window ${retryAt}`);
    assert(effectiveBlocker !== 'provider-daily-quota-exhausted', `stale provider quota blocker after retry window ${retryAt}`);
  }

  const available = ai.available === true || (ai.ready_for_inference === true && !effectiveBlocker);
  if (available && attempts1h >= 3) {
    assert(successes1h > 0, `provider is available but ${attempts1h} recent ${EXPECTED_MODEL} attempts produced zero successes`);
  }

  const pendingTopics = Math.max(0, Number(ai.pending_topics || 0));
  const pacingHeadroom = Number(ai.pacing?.topic_headroom ?? ai.pacing?.remaining_headroom ?? 0);
  const lastExpectedModelAttemptAt = latestModelAttemptAt(ai.model_stats_24h, EXPECTED_MODEL);
  if (recoveryGracePassed && available && pendingTopics > 0 && pacingHeadroom > 0) {
    const lastExpectedAttemptMs = Date.parse(lastExpectedModelAttemptAt || '');
    assert(
      Number.isFinite(lastExpectedAttemptMs) && lastExpectedAttemptMs >= retryMs,
      `provider recovered ${RESET_RECOVERY_GRACE_MINUTES}m ago with ${pendingTopics} pending topics and pacing headroom=${pacingHeadroom}, but no ${EXPECTED_MODEL} attempt has run since ${retryAt}`
    );
  }

  return {
    ok: true,
    generatedAt: payload.generatedAt || null,
    model,
    retry_at: retryAt,
    retry_passed: retryPassed,
    recovery_grace_minutes: RESET_RECOVERY_GRACE_MINUTES,
    recovery_grace_passed: recoveryGracePassed,
    provider_quota_exhausted: providerExhausted,
    effective_blocker: effectiveBlocker,
    available,
    pending_topics: pendingTopics,
    pacing_topic_headroom: pacingHeadroom,
    last_expected_model_attempt_at: lastExpectedModelAttemptAt,
    attempts_1h: attempts1h,
    successes_1h: successes1h,
    failures_1h: failures1h,
    success_rate_1h: attempts1h ? Math.round((successes1h / attempts1h) * 1000) / 10 : null
  };
}

async function selfTest() {
  const base = {
    preview: false,
    generatedAt: '2026-08-24T00:15:00.000Z',
    ai: {
      model: EXPECTED_MODEL,
      available: true,
      ready_for_inference: true,
      effective_blocker: null,
      provider_quota: { exhausted: false, retry_after: null },
      pacing: { topic_headroom: 4 },
      pending_topics: 20,
      recent_attempts_1h: 4,
      recent_successes_1h: 2,
      recent_failures_1h: 2,
      model_stats_1h: [{ model: EXPECTED_MODEL, attempts: 4, successes: 2, failures: 2, last_at: '2026-08-24T00:14:00.000Z' }],
      model_stats_24h: [{ model: EXPECTED_MODEL, attempts: 4, successes: 2, failures: 2, last_at: '2026-08-24T00:14:00.000Z' }]
    }
  };
  const healthy = evaluateResetRecovery(base, new Date('2026-08-24T00:15:00.000Z'));
  assert(healthy.success_rate_1h === 50, 'healthy success rate should be 50%');

  const beforeReset = structuredClone(base);
  beforeReset.ai.available = false;
  beforeReset.ai.ready_for_inference = false;
  beforeReset.ai.effective_blocker = 'provider-daily-quota-exhausted';
  beforeReset.ai.provider_quota = { exhausted: true, retry_after: '2026-08-24T00:00:00.000Z' };
  evaluateResetRecovery(beforeReset, new Date('2026-08-23T23:55:00.000Z'));

  const stale = structuredClone(beforeReset);
  let staleFailed = false;
  try { evaluateResetRecovery(stale, new Date('2026-08-24T00:05:00.000Z')); } catch { staleFailed = true; }
  assert(staleFailed, 'stale provider quota blocker after retry must fail');

  const zeroSuccess = structuredClone(base);
  zeroSuccess.ai.recent_attempts_1h = 3;
  zeroSuccess.ai.recent_successes_1h = 0;
  zeroSuccess.ai.recent_failures_1h = 3;
  zeroSuccess.ai.model_stats_1h = [{ model: EXPECTED_MODEL, attempts: 3, successes: 0, failures: 3, last_at: '2026-08-24T00:14:00.000Z' }];
  let zeroFailed = false;
  try { evaluateResetRecovery(zeroSuccess, new Date('2026-08-24T00:15:00.000Z')); } catch { zeroFailed = true; }
  assert(zeroFailed, 'available provider with >=3 attempts and zero successes must fail');

  const noPostResetAttempt = structuredClone(base);
  noPostResetAttempt.ai.provider_quota = { exhausted: false, retry_after: '2026-08-24T00:00:00.000Z' };
  noPostResetAttempt.ai.recent_attempts_1h = 0;
  noPostResetAttempt.ai.recent_successes_1h = 0;
  noPostResetAttempt.ai.recent_failures_1h = 0;
  noPostResetAttempt.ai.model_stats_1h = [];
  noPostResetAttempt.ai.model_stats_24h = [{ model: EXPECTED_MODEL, attempts: 2, successes: 2, failures: 0, last_at: '2026-08-23T23:40:00.000Z' }];
  evaluateResetRecovery(noPostResetAttempt, new Date('2026-08-24T01:00:00.000Z'));
  let silentRecoveryFailed = false;
  try { evaluateResetRecovery(noPostResetAttempt, new Date('2026-08-24T01:20:00.000Z')); } catch { silentRecoveryFailed = true; }
  assert(silentRecoveryFailed, 'available provider with pending work and no post-reset attempt after grace must fail');

  const recoveredAttempt = structuredClone(noPostResetAttempt);
  recoveredAttempt.ai.model_stats_24h = [{ model: EXPECTED_MODEL, attempts: 1, successes: 1, failures: 0, last_at: '2026-08-24T00:12:00.000Z' }];
  const recovered = evaluateResetRecovery(recoveredAttempt, new Date('2026-08-24T01:20:00.000Z'));
  assert(recovered.last_expected_model_attempt_at === '2026-08-24T00:12:00.000Z', 'post-reset 8B attempt should satisfy recovery liveness');

  console.log('AI quota reset recovery contract validated');
}

async function liveProbe() {
  const endpoint = new URL(process.env.AI_DEBUG_URL || DEFAULT_ENDPOINT);
  endpoint.searchParams.set('_reset_watchdog', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const response = await fetch(endpoint, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache',
      'user-agent': 'internet-trend-radar-ai-reset-watchdog/1.0'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`debug probe HTTP ${response.status}`);
  const payload = await response.json();
  console.log(JSON.stringify(evaluateResetRecovery(payload), null, 2));
}

if (process.argv.includes('--self-test')) await selfTest();
else await liveProbe();
