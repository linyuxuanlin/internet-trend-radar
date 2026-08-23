#!/usr/bin/env node

const DEFAULT_BASE_URL = 'https://internet-trend-radar.linyuxuanlin.workers.dev';
const EXPECTED_DAILY_BUDGET = 24;

export function validateBudgetPayload(payload, now = new Date()) {
  if (!payload || typeof payload !== 'object') throw new Error('AI budget response must be an object');
  if (payload.ok !== true) throw new Error(`AI budget endpoint not ready: ${payload.error || 'ok != true'}`);
  if ('preview' in payload && payload.preview !== false) throw new Error('AI budget endpoint must never report preview data');

  const numericFields = [
    'daily_budget',
    'attempts_today',
    'cumulative_budget',
    'remaining_headroom',
    'remaining_daily',
    'topic_headroom',
    'max_calls_per_topic'
  ];
  for (const field of numericFields) {
    const value = Number(payload[field]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${field}: ${payload[field]}`);
  }

  const daily = Number(payload.daily_budget);
  const attempts = Number(payload.attempts_today);
  const cumulative = Number(payload.cumulative_budget);
  const remainingHeadroom = Number(payload.remaining_headroom);
  const remainingDaily = Number(payload.remaining_daily);
  const topicHeadroom = Number(payload.topic_headroom);
  const maxCalls = Number(payload.max_calls_per_topic);

  if (daily !== EXPECTED_DAILY_BUDGET) {
    throw new Error(`production daily_budget drifted: got ${daily}, expected ${EXPECTED_DAILY_BUDGET}`);
  }
  if (![1, 2].includes(maxCalls)) throw new Error(`unexpected max_calls_per_topic: ${maxCalls}`);
  if (cumulative > daily) throw new Error(`cumulative_budget ${cumulative} exceeds daily_budget ${daily}`);
  if (remainingHeadroom !== Math.max(0, cumulative - attempts)) {
    throw new Error(`remaining_headroom arithmetic mismatch: got ${remainingHeadroom}`);
  }
  if (remainingDaily !== Math.max(0, daily - attempts)) {
    throw new Error(`remaining_daily arithmetic mismatch: got ${remainingDaily}`);
  }
  if (topicHeadroom !== Math.floor(remainingHeadroom / maxCalls)) {
    throw new Error(`topic_headroom arithmetic mismatch: got ${topicHeadroom}`);
  }

  const expectedPaced = remainingHeadroom === 0 && remainingDaily > 0;
  const expectedExhausted = remainingDaily === 0;
  if (Boolean(payload.paced) !== expectedPaced) throw new Error(`paced flag mismatch: ${payload.paced}`);
  if (Boolean(payload.exhausted) !== expectedExhausted) throw new Error(`exhausted flag mismatch: ${payload.exhausted}`);

  const generatedAt = Date.parse(payload.generatedAt || '');
  if (!Number.isFinite(generatedAt)) throw new Error('generatedAt is invalid');
  const ageMs = now.getTime() - generatedAt;
  if (ageMs < -5 * 60_000) throw new Error('generatedAt is materially in the future');
  if (ageMs > 10 * 60_000) throw new Error(`AI budget response is stale by ${Math.round(ageMs / 1000)}s`);
  if (payload.timezone !== 'UTC') throw new Error(`unexpected pacing timezone: ${payload.timezone}`);

  if (expectedPaced) {
    const nextRelease = Date.parse(payload.next_release_at || '');
    if (!Number.isFinite(nextRelease)) throw new Error('paced budget must expose next_release_at');
    if (nextRelease <= generatedAt) throw new Error('next_release_at must be after generatedAt');
    if (nextRelease - generatedAt > 65 * 60_000) throw new Error('next_release_at is more than one hour away');
  } else if (payload.next_release_at !== null) {
    throw new Error('next_release_at must be null when pacing is not the active blocker');
  }

  return {
    daily_budget: daily,
    attempts_today: attempts,
    cumulative_budget: cumulative,
    remaining_headroom: remainingHeadroom,
    remaining_daily: remainingDaily,
    topic_headroom: topicHeadroom,
    max_calls_per_topic: maxCalls,
    paced: expectedPaced,
    exhausted: expectedExhausted,
    next_release_at: payload.next_release_at,
    generatedAt: payload.generatedAt
  };
}

export function validateAvailabilityPayload(payload, budget, now = new Date()) {
  if (!payload || typeof payload !== 'object') throw new Error('AI availability response must be an object');
  if (payload.ok !== true) throw new Error(`AI availability endpoint not ready: ${payload.error || 'ok != true'}`);
  if ('preview' in payload && payload.preview !== false) throw new Error('AI availability endpoint must never report preview data');
  if (!payload.provider_quota || typeof payload.provider_quota !== 'object') throw new Error('provider_quota is missing');
  if (!payload.pacing || typeof payload.pacing !== 'object') throw new Error('pacing is missing');

  const generatedAt = Date.parse(payload.generatedAt || '');
  if (!Number.isFinite(generatedAt)) throw new Error('availability generatedAt is invalid');
  const ageMs = now.getTime() - generatedAt;
  if (ageMs < -5 * 60_000) throw new Error('availability generatedAt is materially in the future');
  if (ageMs > 10 * 60_000) throw new Error(`AI availability response is stale by ${Math.round(ageMs / 1000)}s`);

  for (const field of ['daily_budget', 'attempts_today', 'cumulative_budget', 'remaining_headroom', 'remaining_daily', 'topic_headroom', 'max_calls_per_topic']) {
    if (Number(payload.pacing[field]) !== Number(budget[field])) {
      throw new Error(`availability pacing mismatch for ${field}: availability=${payload.pacing[field]} budget=${budget[field]}`);
    }
  }
  for (const field of ['paced', 'exhausted']) {
    if (Boolean(payload.pacing[field]) !== Boolean(budget[field])) {
      throw new Error(`availability pacing mismatch for ${field}: availability=${payload.pacing[field]} budget=${budget[field]}`);
    }
  }
  if ((payload.pacing.next_release_at || null) !== (budget.next_release_at || null)) {
    throw new Error(`availability next_release_at mismatch: ${payload.pacing.next_release_at} != ${budget.next_release_at}`);
  }

  const providerExhausted = Boolean(payload.provider_quota.exhausted);
  let expectedBlocker = null;
  if (payload.binding !== true) expectedBlocker = 'missing-ai-binding';
  else if (providerExhausted) expectedBlocker = 'provider-daily-quota-exhausted';
  else if (budget.exhausted) expectedBlocker = 'daily-ai-budget-exhausted';
  else if (budget.paced || budget.topic_headroom < 1) expectedBlocker = 'daily-ai-budget-paced';

  if ((payload.effective_blocker || null) !== expectedBlocker) {
    throw new Error(`effective_blocker mismatch: got ${payload.effective_blocker}, expected ${expectedBlocker}`);
  }
  if (Boolean(payload.available) !== (expectedBlocker === null)) {
    throw new Error(`available flag mismatch: got ${payload.available}, blocker=${expectedBlocker}`);
  }
  if (providerExhausted) {
    if (!payload.provider_quota.detected_at) throw new Error('provider quota exhaustion must expose detected_at');
    if (!payload.provider_quota.retry_after) throw new Error('provider quota exhaustion must expose retry_after');
    if (!String(payload.provider_quota.failure_reason || '').includes('quota-or-capacity')) {
      throw new Error(`unexpected provider quota failure reason: ${payload.provider_quota.failure_reason}`);
    }
  }

  return {
    available: Boolean(payload.available),
    effective_blocker: payload.effective_blocker || null,
    binding: Boolean(payload.binding),
    provider_quota: payload.provider_quota,
    generatedAt: payload.generatedAt
  };
}

export function validateDebugConsistency(debug, availability) {
  if (!debug || typeof debug !== 'object' || !debug.ai) throw new Error('debug response is missing ai diagnostics');
  if (Boolean(debug.ai.binding) !== Boolean(availability.binding)) {
    throw new Error(`AI binding mismatch: debug=${debug.ai.binding} availability=${availability.binding}`);
  }
  if (Boolean(debug.ai.quota_exhausted) !== Boolean(availability.provider_quota.exhausted)) {
    throw new Error(`provider quota mismatch: debug=${debug.ai.quota_exhausted} availability=${availability.provider_quota.exhausted}`);
  }
  if (availability.provider_quota.exhausted) {
    if ((debug.ai.quota_detected_at || null) !== (availability.provider_quota.detected_at || null)) {
      throw new Error(`quota detected_at mismatch: debug=${debug.ai.quota_detected_at} availability=${availability.provider_quota.detected_at}`);
    }
    if ((debug.ai.quota_retry_after || null) !== (availability.provider_quota.retry_after || null)) {
      throw new Error(`quota retry_after mismatch: debug=${debug.ai.quota_retry_after} availability=${availability.provider_quota.retry_after}`);
    }
    if ((debug.ai.quota_failure_reason || null) !== (availability.provider_quota.failure_reason || null)) {
      throw new Error('quota failure_reason mismatch between debug and availability');
    }
    if (debug.ai.ready_for_inference !== false) throw new Error('debug must not advertise inference readiness when provider quota is exhausted');
  }
  return {
    debug_blocked_reason: debug.ai.blocked_reason || null,
    debug_ready_for_inference: Boolean(debug.ai.ready_for_inference)
  };
}

function runSelfTest() {
  const now = new Date('2026-08-23T07:31:00.000Z');
  const base = {
    ok: true,
    generatedAt: now.toISOString(),
    timezone: 'UTC',
    daily_budget: 24,
    attempts_today: 6,
    cumulative_budget: 8,
    remaining_headroom: 2,
    remaining_daily: 18,
    topic_headroom: 2,
    max_calls_per_topic: 1,
    paced: false,
    exhausted: false,
    next_release_at: null
  };
  const budget = validateBudgetPayload(base, now);
  const availability = validateAvailabilityPayload({
    ok: true,
    generatedAt: now.toISOString(),
    available: true,
    effective_blocker: null,
    binding: true,
    provider_quota: { exhausted: false, detected_at: null, retry_after: null, failure_reason: null },
    pacing: base
  }, budget, now);
  validateDebugConsistency({ ai: { binding: true, quota_exhausted: false, quota_detected_at: null, quota_retry_after: null, quota_failure_reason: null, ready_for_inference: true, blocked_reason: 'partial-ai-coverage' } }, availability);

  const pacedPayload = {
    ...base,
    attempts_today: 8,
    remaining_headroom: 0,
    remaining_daily: 16,
    topic_headroom: 0,
    paced: true,
    next_release_at: '2026-08-23T08:00:00.000Z'
  };
  const pacedBudget = validateBudgetPayload(pacedPayload, now);
  validateAvailabilityPayload({
    ok: true,
    generatedAt: now.toISOString(),
    available: false,
    effective_blocker: 'daily-ai-budget-paced',
    binding: true,
    provider_quota: { exhausted: false, detected_at: null, retry_after: null, failure_reason: null },
    pacing: pacedPayload
  }, pacedBudget, now);

  const quotaAvailability = validateAvailabilityPayload({
    ok: true,
    generatedAt: now.toISOString(),
    available: false,
    effective_blocker: 'provider-daily-quota-exhausted',
    binding: true,
    provider_quota: {
      exhausted: true,
      detected_at: '2026-08-23T07:00:00.000Z',
      retry_after: '2026-08-24T00:00:00.000Z',
      failure_reason: 'inference-error:quota-or-capacity:AiError'
    },
    pacing: base
  }, budget, now);
  validateDebugConsistency({ ai: {
    binding: true,
    quota_exhausted: true,
    quota_detected_at: '2026-08-23T07:00:00.000Z',
    quota_retry_after: '2026-08-24T00:00:00.000Z',
    quota_failure_reason: 'inference-error:quota-or-capacity:AiError',
    ready_for_inference: false,
    blocked_reason: 'daily-ai-quota-exhausted'
  } }, quotaAvailability);

  let rejected = 0;
  for (const test of [
    () => validateBudgetPayload({ ...base, daily_budget: 96, remaining_daily: 90 }, now),
    () => validateBudgetPayload({ ...base, remaining_daily: 99 }, now),
    () => validateAvailabilityPayload({ ok: true, generatedAt: now.toISOString(), available: true, effective_blocker: null, binding: true, provider_quota: { exhausted: false }, pacing: { ...base, remaining_headroom: 1 } }, budget, now),
    () => validateAvailabilityPayload({ ok: true, generatedAt: now.toISOString(), available: true, effective_blocker: null, binding: true, provider_quota: { exhausted: true, detected_at: now.toISOString(), retry_after: '2026-08-24T00:00:00.000Z', failure_reason: 'inference-error:quota-or-capacity' }, pacing: base }, budget, now),
    () => validateDebugConsistency({ ai: { binding: true, quota_exhausted: false } }, quotaAvailability)
  ]) {
    try { test(); } catch { rejected += 1; }
  }
  if (rejected !== 5) throw new Error(`self-test expected 5 rejected payloads, got ${rejected}`);
  console.log('AI budget and availability coherence watchdog self-test passed');
}

async function fetchJson(url, label) {
  const target = new URL(url);
  target.searchParams.set('_watchdog', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const response = await fetch(target, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache',
      'user-agent': 'internet-trend-radar-ai-budget-watchdog/2.1'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`${label} probe HTTP ${response.status}`);
  return response.json();
}

async function probe(baseUrl) {
  const base = new URL(baseUrl);
  const origin = base.origin;
  const now = new Date();
  const [budgetPayload, availabilityPayload, debugPayload] = await Promise.all([
    fetchJson(`${origin}/api/ai-budget`, 'AI budget'),
    fetchJson(`${origin}/api/ai-availability`, 'AI availability'),
    fetchJson(`${origin}/api/debug`, 'debug')
  ]);
  const budget = validateBudgetPayload(budgetPayload, now);
  const availability = validateAvailabilityPayload(availabilityPayload, budget, now);
  const debug = validateDebugConsistency(debugPayload, availability);
  console.log(JSON.stringify({ ok: true, origin, budget, availability, debug }, null, 2));
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  runSelfTest();
} else {
  const urlArg = args.find(arg => arg.startsWith('--url='));
  const configured = urlArg ? urlArg.slice('--url='.length) : process.env.AI_BUDGET_URL || DEFAULT_BASE_URL;
  await probe(configured);
}
