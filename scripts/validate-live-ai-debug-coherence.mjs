#!/usr/bin/env node

const DEFAULT_BASE_URL = 'https://internet-trend-radar.linyuxuanlin.workers.dev';

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

export function validateDebugAvailabilityCoherence(debug, availability) {
  assertObject(debug, 'debug response');
  assertObject(debug.ai, 'debug.ai');
  assertObject(availability, 'availability response');
  assertObject(availability.provider_quota, 'availability.provider_quota');
  assertObject(availability.pacing, 'availability.pacing');

  if (availability.ok !== true) throw new Error(`availability not ready: ${availability.error || 'ok != true'}`);
  if ('preview' in availability && availability.preview !== false) throw new Error('availability must never use preview data');

  const expectedBlocker = availability.effective_blocker || null;
  const debugBlocker = debug.ai.effective_blocker || null;
  if (debugBlocker !== expectedBlocker) {
    throw new Error(`effective_blocker mismatch: debug=${debugBlocker} availability=${expectedBlocker}`);
  }
  if ((debug.ai.blocked_reason || null) !== expectedBlocker) {
    throw new Error(`blocked_reason must equal effective_blocker: blocked_reason=${debug.ai.blocked_reason} effective=${expectedBlocker}`);
  }
  if (Boolean(debug.ai.available) !== Boolean(availability.available)) {
    throw new Error(`available mismatch: debug=${debug.ai.available} availability=${availability.available}`);
  }
  if (Boolean(debug.ai.ready_for_inference) !== Boolean(availability.available)) {
    throw new Error(`ready_for_inference must equal effective availability: ready=${debug.ai.ready_for_inference} available=${availability.available}`);
  }
  if (Boolean(debug.ai.binding) !== Boolean(availability.binding)) {
    throw new Error(`binding mismatch: debug=${debug.ai.binding} availability=${availability.binding}`);
  }
  if (Boolean(debug.ai.availability_ok) !== true) {
    throw new Error(`debug availability_ok must be true, got ${debug.ai.availability_ok}`);
  }

  const debugQuota = debug.ai.provider_quota;
  assertObject(debugQuota, 'debug.ai.provider_quota');
  for (const field of ['exhausted', 'detected_at', 'retry_after', 'failure_reason']) {
    const left = debugQuota[field] ?? null;
    const right = availability.provider_quota[field] ?? null;
    if (left !== right) throw new Error(`provider_quota.${field} mismatch: debug=${left} availability=${right}`);
  }

  const debugPacing = debug.ai.pacing;
  assertObject(debugPacing, 'debug.ai.pacing');
  for (const field of [
    'daily_budget',
    'attempts_today',
    'cumulative_budget',
    'remaining_headroom',
    'remaining_daily',
    'topic_headroom',
    'max_calls_per_topic',
    'paced',
    'exhausted',
    'next_release_at'
  ]) {
    const left = debugPacing[field] ?? null;
    const right = availability.pacing[field] ?? null;
    if (left !== right) throw new Error(`pacing.${field} mismatch: debug=${left} availability=${right}`);
  }

  return {
    available: Boolean(availability.available),
    effective_blocker: expectedBlocker,
    provider_quota_exhausted: Boolean(availability.provider_quota.exhausted),
    pacing_headroom: Number(availability.pacing.remaining_headroom || 0),
    attempts_today: Number(availability.pacing.attempts_today || 0)
  };
}

function runSelfTest() {
  const availability = {
    ok: true,
    available: false,
    effective_blocker: 'provider-daily-quota-exhausted',
    binding: true,
    provider_quota: {
      exhausted: true,
      detected_at: '2026-08-23T00:29:35.000Z',
      retry_after: '2026-08-24T00:00:00.000Z',
      failure_reason: 'inference-error:quota-or-capacity:AiError'
    },
    pacing: {
      daily_budget: 96,
      attempts_today: 10,
      cumulative_budget: 44,
      remaining_headroom: 34,
      remaining_daily: 86,
      topic_headroom: 34,
      max_calls_per_topic: 1,
      paced: false,
      exhausted: false,
      next_release_at: null
    }
  };
  const debug = {
    ai: {
      binding: true,
      availability_ok: true,
      available: false,
      effective_blocker: 'provider-daily-quota-exhausted',
      blocked_reason: 'provider-daily-quota-exhausted',
      ready_for_inference: false,
      provider_quota: { ...availability.provider_quota },
      pacing: { ...availability.pacing }
    }
  };
  validateDebugAvailabilityCoherence(debug, availability);

  const mutations = [
    d => { d.ai.effective_blocker = 'daily-ai-quota-exhausted'; },
    d => { d.ai.blocked_reason = 'partial-ai-coverage'; },
    d => { d.ai.ready_for_inference = true; },
    d => { d.ai.provider_quota.retry_after = '2026-08-25T00:00:00.000Z'; },
    d => { d.ai.pacing.remaining_headroom = 33; }
  ];
  let rejected = 0;
  for (const mutate of mutations) {
    const candidate = structuredClone(debug);
    mutate(candidate);
    try { validateDebugAvailabilityCoherence(candidate, availability); } catch { rejected += 1; }
  }
  if (rejected !== mutations.length) throw new Error(`self-test expected ${mutations.length} rejected payloads, got ${rejected}`);
  console.log('Strict AI debug/availability coherence self-test passed');
}

async function fetchJson(url, label) {
  const target = new URL(url);
  target.searchParams.set('_coherence', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const response = await fetch(target, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache',
      'user-agent': 'internet-trend-radar-ai-debug-coherence/1.0'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`${label} probe HTTP ${response.status}`);
  return response.json();
}

async function probe(baseUrl) {
  const origin = new URL(baseUrl).origin;
  const [debug, availability] = await Promise.all([
    fetchJson(`${origin}/api/debug`, 'debug'),
    fetchJson(`${origin}/api/ai-availability`, 'AI availability')
  ]);
  const result = validateDebugAvailabilityCoherence(debug, availability);
  console.log(JSON.stringify({ ok: true, origin, ...result }, null, 2));
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  runSelfTest();
} else {
  const urlArg = args.find(arg => arg.startsWith('--url='));
  const configured = urlArg ? urlArg.slice('--url='.length) : process.env.AI_BUDGET_URL || DEFAULT_BASE_URL;
  await probe(configured);
}
