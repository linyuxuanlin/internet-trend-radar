import { readFile } from 'node:fs/promises';

const sourceFile = process.env.AI_DEBUG_FILE || '';
const sourceUrl = process.env.AI_DEBUG_URL || 'https://internet-trend-radar.linyuxuanlin.workers.dev/api/debug';
const minAttempts = Math.max(1, Number(process.env.AI_REGRESSION_MIN_ATTEMPTS || 10));
const maxInvalidRate = Math.max(0, Math.min(1, Number(process.env.AI_REGRESSION_MAX_INVALID_RATE || 0.5)));
const strict = process.env.AI_REGRESSION_STRICT === '1';

async function loadDebug() {
  if (sourceFile) return JSON.parse(await readFile(sourceFile, 'utf8'));
  const response = await fetch(sourceUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`AI debug HTTP ${response.status}`);
  return response.json();
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function summarize(ai) {
  const attempts = number(ai.recent_attempts_1h);
  const successes = number(ai.recent_successes_1h);
  const failures = number(ai.recent_failures_1h);
  const reasons = Array.isArray(ai.recent_failure_reasons_1h) ? ai.recent_failure_reasons_1h : [];
  const invalidRequests = reasons
    .filter(row => String(row?.reason || '').includes('inference-error:invalid-request'))
    .reduce((sum, row) => sum + number(row?.count), 0);
  const unknown = reasons
    .filter(row => /inference-error:unknown|fallback-inference-error:unknown/.test(String(row?.reason || '')))
    .reduce((sum, row) => sum + number(row?.count), 0);
  const dominant = [...reasons].sort((a, b) => number(b?.count) - number(a?.count))[0] || null;
  return {
    attempts,
    successes,
    failures,
    success_rate: attempts ? Math.round((successes / attempts) * 1000) / 10 : null,
    invalid_request_count: invalidRequests,
    invalid_request_rate: attempts ? Math.round((invalidRequests / attempts) * 1000) / 1000 : 0,
    unknown_failure_count: unknown,
    dominant_failure: dominant ? { reason: dominant.reason || 'unknown', count: number(dominant.count), last_at: dominant.last_at || null } : null,
    model_stats_1h: Array.isArray(ai.model_stats_1h) ? ai.model_stats_1h : []
  };
}

let debug;
try {
  debug = await loadDebug();
} catch (error) {
  console.log(`::warning::Live AI diagnostics unavailable: ${String(error?.message || error)}`);
  process.exit(0);
}

if (!debug?.ai || typeof debug.ai !== 'object') throw new Error('debug payload missing ai object');
const required = ['recent_attempts_1h', 'recent_successes_1h', 'recent_failures_1h', 'recent_failure_reasons_1h', 'model_stats_1h'];
for (const key of required) {
  if (!(key in debug.ai)) {
    console.log(`::warning::Deployed Worker predates one-hour AI diagnostics: missing ai.${key}`);
    process.exit(0);
  }
}

const summary = summarize(debug.ai);
console.log(JSON.stringify({
  generatedAt: debug.generatedAt || null,
  blocked_reason: debug.ai.blocked_reason ?? null,
  eligible_topics: debug.ai.eligible_topics ?? null,
  verified_topics: debug.ai.verified_topics ?? null,
  pending_topics: debug.ai.pending_topics ?? null,
  ...summary
}, null, 2));

if (summary.attempts < minAttempts) {
  console.log(`AI 1h sample is small (${summary.attempts}/${minAttempts}); no regression verdict.`);
  process.exit(0);
}

if (summary.invalid_request_rate >= maxInvalidRate) {
  const message = `Workers AI invalid-request rate is ${(summary.invalid_request_rate * 100).toFixed(1)}% over ${summary.attempts} attempts`;
  if (strict) throw new Error(message);
  console.log(`::warning::${message}`);
}

if (summary.successes === 0 && summary.attempts >= minAttempts) {
  const message = `Workers AI produced zero successes across ${summary.attempts} one-hour attempts`;
  if (strict) throw new Error(message);
  console.log(`::warning::${message}`);
}
