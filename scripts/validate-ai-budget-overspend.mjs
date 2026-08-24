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
  return {
    budget_overspent: overspendCount > 0,
    overspend_count: overspendCount,
    attempts_today: attemptsToday,
    daily_budget: dailyBudget,
    remaining_daily: Math.max(0, dailyBudget - attemptsToday)
  };
}

export function assertNoAttemptGrowth(before, after) {
  if (before.daily_budget !== after.daily_budget) {
    throw new Error(`daily budget changed during read-only probe: ${before.daily_budget} -> ${after.daily_budget}`);
  }
  if (after.attempts_today !== before.attempts_today) {
    throw new Error(`dashboard GET mutated AI attempts: ${before.attempts_today} -> ${after.attempts_today}`);
  }
  return {
    attempts_before: before.attempts_today,
    attempts_after: after.attempts_today,
    budget_overspent: after.budget_overspent,
    overspend_count: after.overspend_count
  };
}

function runSelfTest() {
  const normal = validateOverspend({ ok: true, preview: false, daily_budget: 24, attempts_today: 17 });
  if (normal.budget_overspent !== false || normal.overspend_count !== 0 || normal.remaining_daily !== 7) {
    throw new Error('normal budget self-test produced incorrect derived state');
  }

  const overspent = validateOverspend({ ok: true, preview: false, daily_budget: 24, attempts_today: 80 });
  if (overspent.budget_overspent !== true || overspent.overspend_count !== 56 || overspent.remaining_daily !== 0) {
    throw new Error('overspent budget self-test produced incorrect derived state');
  }
  assertNoAttemptGrowth(overspent, { ...overspent });

  let mutationRejected = false;
  try {
    assertNoAttemptGrowth(overspent, { ...overspent, attempts_today: 81, overspend_count: 57 });
  } catch (error) {
    mutationRejected = String(error?.message || error).includes('dashboard GET mutated AI attempts');
  }
  if (!mutationRejected) throw new Error('attempt-growth mutation self-test was not rejected');

  const invalidCases = [
    [{ ok: true, preview: true, daily_budget: 24, attempts_today: 1 }, 'preview data'],
    [{ ok: true, preview: false, daily_budget: 96, attempts_today: 1 }, 'daily_budget drifted']
  ];
  for (const [payload, expected] of invalidCases) {
    let message = '';
    try {
      validateOverspend(payload);
    } catch (error) {
      message = String(error?.message || error);
    }
    if (!message.includes(expected)) throw new Error(`expected rejection containing "${expected}", got "${message}"`);
  }

  console.log('AI budget overspend and dashboard read-only guard self-test passed');
}

async function fetchJson(url, label) {
  const target = new URL(url);
  target.searchParams.set('_overspend_watchdog', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const response = await fetch(target, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache',
      'user-agent': 'internet-trend-radar-ai-overspend-watchdog/1.1'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`${label} probe HTTP ${response.status}`);
  return response.json();
}

async function readBudget(origin) {
  return validateOverspend(await fetchJson(`${origin}/api/ai-budget`, 'AI budget'));
}

async function probe(baseUrl) {
  const origin = new URL(baseUrl).origin;
  const before = await readBudget(origin);

  const dashboards = await Promise.all(Array.from({ length: 3 }, () => fetchJson(`${origin}/api/dashboard`, 'dashboard')));
  for (const payload of dashboards) {
    if (payload?.preview !== false || payload?.ready !== true) throw new Error('dashboard read-only probe did not return ready real data');
    if (!Array.isArray(payload?.topics) || payload.topics.length < 1) throw new Error('dashboard read-only probe returned no real topics');
  }

  await new Promise(resolve => setTimeout(resolve, 1500));
  const after = await readBudget(origin);
  const readOnly = assertNoAttemptGrowth(before, after);
  const result = { ok: true, origin, ...after, read_only_probe: readOnly, dashboard_reads: dashboards.length };
  if (after.budget_overspent) {
    console.log(`::warning::Historical AI budget overspend remains: ${after.overspend_count} calls over ${after.daily_budget}/day; dashboard reads did not increase it`);
  }
  console.log(JSON.stringify(result, null, 2));
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  runSelfTest();
} else {
  const urlArg = args.find(arg => arg.startsWith('--url='));
  const configured = urlArg ? urlArg.slice('--url='.length) : process.env.AI_BUDGET_URL || DEFAULT_BASE_URL;
  await probe(configured);
}
