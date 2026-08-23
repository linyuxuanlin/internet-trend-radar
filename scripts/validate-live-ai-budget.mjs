#!/usr/bin/env node

const DEFAULT_URL = 'https://internet-trend-radar.linyuxuanlin.workers.dev/api/ai-budget';

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

  if (daily < 24 || daily > 240) throw new Error(`daily_budget outside guarded range: ${daily}`);
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
    paced: expectedPaced,
    exhausted: expectedExhausted,
    next_release_at: payload.next_release_at,
    generatedAt: payload.generatedAt
  };
}

function runSelfTest() {
  const now = new Date('2026-08-23T07:31:00.000Z');
  const base = {
    ok: true,
    generatedAt: now.toISOString(),
    timezone: 'UTC',
    daily_budget: 96,
    attempts_today: 30,
    cumulative_budget: 32,
    remaining_headroom: 2,
    remaining_daily: 66,
    topic_headroom: 2,
    max_calls_per_topic: 1,
    paced: false,
    exhausted: false,
    next_release_at: null
  };
  validateBudgetPayload(base, now);
  validateBudgetPayload({
    ...base,
    attempts_today: 32,
    remaining_headroom: 0,
    remaining_daily: 64,
    topic_headroom: 0,
    paced: true,
    next_release_at: '2026-08-23T08:00:00.000Z'
  }, now);
  validateBudgetPayload({
    ...base,
    attempts_today: 100,
    remaining_headroom: 0,
    remaining_daily: 0,
    topic_headroom: 0,
    paced: false,
    exhausted: true
  }, now);

  let rejected = 0;
  for (const bad of [
    { ...base, preview: true },
    { ...base, remaining_daily: 99 },
    { ...base, paced: true, next_release_at: null },
    { ...base, generatedAt: '2026-08-23T06:00:00.000Z' }
  ]) {
    try {
      validateBudgetPayload(bad, now);
    } catch {
      rejected += 1;
    }
  }
  if (rejected !== 4) throw new Error(`self-test expected 4 rejected payloads, got ${rejected}`);
  console.log('AI budget watchdog self-test passed');
}

async function probe(url) {
  const target = new URL(url);
  target.searchParams.set('_watchdog', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const response = await fetch(target, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache',
      'user-agent': 'internet-trend-radar-ai-budget-watchdog/1.0'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`AI budget probe HTTP ${response.status}`);
  const payload = await response.json();
  const status = validateBudgetPayload(payload, new Date());
  console.log(JSON.stringify({ ok: true, url: target.origin + target.pathname, ...status }, null, 2));
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  runSelfTest();
} else {
  const urlArg = args.find(arg => arg.startsWith('--url='));
  await probe(urlArg ? urlArg.slice('--url='.length) : process.env.AI_BUDGET_URL || DEFAULT_URL);
}
