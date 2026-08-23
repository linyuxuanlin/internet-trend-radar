import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const collector = await readFile(new URL('../src/collector.js', import.meta.url), 'utf8');
const api = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');
const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

const scheduledStart = source.indexOf('async scheduled(controller, env, ctx)');
if (scheduledStart < 0) throw new Error('scheduled handler missing');
const scheduled = source.slice(scheduledStart);

const collectionIndex = scheduled.indexOf('await collectAll(env)');
const aiIndex = scheduled.indexOf("await enrichTopTopics(env, { backfillOnly: true })");
if (collectionIndex < 0) throw new Error('scheduled collection missing');
if (aiIndex < 0) throw new Error('scheduled AI backfill missing');
if (aiIndex < collectionIndex) throw new Error('AI backfill must run after real collection');
if (!scheduled.includes("if (!env.AI)")) throw new Error('scheduled AI backfill must degrade when AI binding is unavailable');
if (!scheduled.includes('scheduled AI backfill failed; real collection already completed')) {
  throw new Error('scheduled AI failure must be isolated from completed real-data collection');
}
if (!scheduled.includes("controller.cron === '5 0 * * *'")) throw new Error('daily digest cron guard missing');

if (!collector.includes('async function enrichAIWithoutBlockingCollection(env)')) {
  throw new Error('collector must isolate AI enrichment from real-data collection');
}
if (!collector.includes('AI enrichment failed after real collection; preserving collected data')) {
  throw new Error('collector must explicitly preserve real data when AI enrichment fails');
}
if (!collector.includes("return { failed: true, error }")) {
  throw new Error('collector AI failure must return truthful degraded metadata');
}
if (!collector.includes('const ai = await enrichAIWithoutBlockingCollection(env)')) {
  throw new Error('collectAll must use non-blocking AI enrichment wrapper');
}

if (!collector.includes('AI_DAILY_MODEL_CALL_BUDGET || 96')) {
  throw new Error('collector must default to a bounded daily model-call budget');
}
if (!collector.includes("substr(attempted_at,1,10)=substr(datetime('now'),1,10)")) {
  throw new Error('AI pacing must count real persisted attempts from the current UTC day');
}
if (!collector.includes('Math.ceil(dailyBudget * (utcHour + 1) / 24)')) {
  throw new Error('AI budget must be paced cumulatively across the UTC day');
}
if (!collector.includes("env.AI_DISABLE_FALLBACK === '1' ? 1 : 2")) {
  throw new Error('AI pacing must reserve enough headroom for configured fallback behavior');
}
if (!collector.includes("reason: 'daily-ai-budget-paced'")) {
  throw new Error('budget pacing must report a truthful skip reason instead of invoking fake AI output');
}
if (!collector.includes('const topN = Math.min(configuredTopN, pacing.topicBudget)')) {
  throw new Error('per-run AI selection must be capped by remaining paced budget');
}

if (!api.includes("url.pathname === '/api/ai-budget'")) {
  throw new Error('AI pacing must expose a read-only production observability endpoint');
}
for (const field of ['daily_budget', 'attempts_today', 'cumulative_budget', 'remaining_headroom', 'remaining_daily', 'topic_headroom', 'max_calls_per_topic', 'next_release_at']) {
  if (!api.includes(field)) throw new Error(`AI budget endpoint missing ${field}`);
}
if (!api.includes("substr(attempted_at,1,10)=substr(datetime('now'),1,10)")) {
  throw new Error('AI budget endpoint must report real persisted attempts from the current UTC day');
}
if (!api.includes('Math.ceil(dailyBudget * (utcHour + 1) / 24)')) {
  throw new Error('AI budget endpoint must use the same UTC pacing curve as collection');
}
if (!api.includes('remainingHeadroom === 0 && remainingDaily > 0 ? nextBudgetReleaseIso(now) : null')) {
  throw new Error('AI budget endpoint must reveal the next release time when pacing is the active blocker');
}

const dailyBudget = 96;
const paced = Array.from({ length: 24 }, (_, utcHour) => Math.ceil(dailyBudget * (utcHour + 1) / 24));
if (paced[0] !== 4 || paced[5] !== 24 || paced[11] !== 48 || paced[23] !== 96) {
  throw new Error(`unexpected daily pacing curve: ${paced.join(',')}`);
}
if (!paced.every((value, index) => index === 0 || value >= paced[index - 1])) {
  throw new Error('daily pacing curve must be monotonic');
}
const primaryOnlyTopicHeadroom = Math.floor((paced[0] - 0) / 1);
const fallbackSafeTopicHeadroom = Math.floor((paced[0] - 0) / 2);
if (primaryOnlyTopicHeadroom !== 4 || fallbackSafeTopicHeadroom !== 2) {
  throw new Error('pacing headroom must conservatively account for possible fallback calls');
}

const config = JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, ''));
const topN = Number(config?.vars?.AI_TOP_N || 0);
if (topN !== 10) throw new Error(`expected bounded AI_TOP_N=10, got ${topN}`);
if (topN > 12) throw new Error(`AI_TOP_N must remain bounded to avoid inference bursts, got ${topN}`);
if (String(config?.vars?.AI_DISABLE_FALLBACK || '') !== '1') {
  throw new Error('production must disable low-yield fallback until diagnostics show it is competitive');
}
if (config?.vars?.AI_MODEL !== '@cf/meta/llama-3.3-70b-instruct-fp8-fast') {
  throw new Error(`unexpected production primary model: ${config?.vars?.AI_MODEL}`);
}

console.log('Scheduled AI backfill, collection-safe degradation, paced daily AI budget, production budget observability, and primary-only production AI policy validated');