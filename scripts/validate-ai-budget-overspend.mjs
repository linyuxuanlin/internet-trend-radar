#!/usr/bin/env node

const DEFAULT_BASE_URL = 'https://internet-trend-radar.linyuxuanlin.workers.dev';
const EXPECTED_DAILY_BUDGET = 24;

export function validateOverspend(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('AI budget response must be an object');
  if (payload.ok !== true) throw new Error(`AI budget endpoint not ready: ${payload.error || 'ok != true'}`);
  if ('preview' in payload && payload.preview !== false) throw new Error('AI budget endpoint must never report preview data');

  const dailyBudget = Number(payload.daily_budget);
  const attemptsToday = Number(payload.attempts_today);
  if (!Number.isInteger(dailyBudget) || dailyBudget < 1) throw new Error(`invalid daily_budget: ${payload.daily_budget}`);
  if (!Number.isInteger(attemptsToday) || attemptsToday < 0) throw new Error(`invalid attempts_today: ${payload.attempts_today}`);
  if (dailyBudget !== EXPECTED_DAILY_BUDGET) {
    throw new Error(`production daily_budget drifted: got ${dailyBudget}, expected ${EXPECTED_DAILY_BUDGET}`);
  }

  const overspendCount = Math.max(0, attemptsToday - dailyBudget);
  const budgetOverspent = overspendCount > 0;
  if (budgetOverspent) {
    throw new Error(`AI daily budget overspent by ${overspendCount} calls: attempts_today=${attemptsToday}, daily_budget=${dailyBudget}`);
  }

  return {
    budget_overspent: false,
    overspend_count: 0,
    attempts_today: attemptsToday,
    daily_budget: dailyBudget,
    remaining_daily: Math.max(0, dailyBudget - attemptsToday)
  };
}

function runSelfTest() {
  const valid = validateOverspend({ ok: true, preview: false, daily_budget: 24, attempts_today: 17 });
  if (valid.budget_overspent !== false || valid.overspend_count !== 0 || valid.remaining_daily !== 7) {
    throw new Error('valid budget self-test produced incorrect derived state');
  }

  const cases = [
    [{ ok: true, preview: false, daily_budget: 24, attempts_today: 25 }, 'overspent by 1 calls'],
    [{ ok: true, preview: false, daily_budget: 24, attempts_today: 80 }, 'overspent by 56 calls'],
    [{ ok: true, preview: true, daily_budget: 24, attempts_today: 1 }, 'preview data'],
    [{ ok: true, preview: false, daily_budget: 96, attempts_today: 1 }, 'daily_budget drifted']
  ];

  for (const [payload, expected] of cases) {
    let message = '';
    try {
      validateOverspend(payload);
    } catch (error) {
      message = String(error?.message || error);
    }
    if (!message.includes(expected)) throw new Error(`expected rejection containing "${expected}", got "${message}"`);
  }

  console.log('AI budget overspend guard self-test passed');
}

async function probe(baseUrl) {
  const target = new URL('/api/ai-budget', new URL(baseUrl).origin);
  target.searchParams.set('_overspend_watchdog', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const response = await fetch(target, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache',
      'user-agent': 'internet-trend-radar-ai-overspend-watchdog/1.0'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`AI budget probe HTTP ${response.status}`);
  const payload = await response.json();
  const result = validateOverspend(payload);
  console.log(JSON.stringify({ ok: true, origin: target.origin, ...result, generatedAt: payload.generatedAt || null }, null, 2));
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  runSelfTest();
} else {
  const urlArg = args.find(arg => arg.startsWith('--url='));
  const configured = urlArg ? urlArg.slice('--url='.length) : process.env.AI_BUDGET_URL || DEFAULT_BASE_URL;
  await probe(configured);
}
