import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const collector = await readFile(new URL('../src/collector.js', import.meta.url), 'utf8');
const api = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');
const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

const scheduledStart = source.indexOf('async scheduled(controller, env, ctx)');
if (scheduledStart < 0) throw new Error('base scheduled handler missing');
const scheduled = source.slice(scheduledStart);

const collectionIndex = scheduled.indexOf('await collectAll(env)');
const aiIndex = scheduled.indexOf("await enrichTopTopics(env, { backfillOnly: true })");
if (collectionIndex < 0) throw new Error('base scheduled collection missing');
if (aiIndex < 0) throw new Error('base scheduled AI backfill missing');
if (aiIndex < collectionIndex) throw new Error('base AI backfill must run after real collection');
if (!scheduled.includes("if (!env.AI)")) throw new Error('base scheduled AI backfill must degrade when AI binding is unavailable');
if (!scheduled.includes('scheduled AI backfill failed; real collection already completed')) {
  throw new Error('base scheduled AI failure must be isolated from completed real-data collection');
}
if (!scheduled.includes("controller.cron === '5 0 * * *'")) throw new Error('base daily digest cron guard missing');

// Production entrypoint is src/worker.js. It must not delegate scheduled runs to
// baseWorker.scheduled because base index.js performs an extra direct AI backfill
// after collectAll(). collectAll() already runs one paced enrichment pass.
const workerScheduledStart = worker.indexOf('async scheduled(controller, env, ctx)');
if (workerScheduledStart < 0) throw new Error('production worker scheduled handler missing');
const workerScheduled = worker.slice(workerScheduledStart);
if (!workerScheduled.includes('const collection = await collectAll(env)')) {
  throw new Error('production scheduled handler must collect through collectAll()');
}
if (!workerScheduled.includes('return { collection, ai: collection.ai }')) {
  throw new Error('production scheduled handler must reuse the paced AI result from collectAll()');
}
if (workerScheduled.includes('baseWorker.scheduled(controller, env, ctx)')) {
  throw new Error('production scheduled handler must not delegate to duplicate unpaced base scheduled AI backfill');
}
if (workerScheduled.includes('enrichTopTopics(')) {
  throw new Error('production scheduled handler must not launch a second direct AI enrichment pass');
}
if (!workerScheduled.includes("controller.cron === '5 0 * * *'")) {
  throw new Error('production worker must preserve daily digest cron guard');
}

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
const productionBudget = Number(config?.vars?.AI_DAILY_MODEL_CALL_BUDGET || 0);
if (productionBudget !== 24) throw new Error(`expected production AI_DAILY_MODEL_CALL_BUDGET=24, got ${productionBudget}`);
if (productionBudget > 24) throw new Error(`production daily model-call budget must stay conservative under the free neuron allocation, got ${productionBudget}`);
if (String(config?.vars?.AI_DISABLE_FALLBACK || '') !== '1') {
  throw new Error('production must disable low-yield fallback until diagnostics show it is competitive');
}
if (config?.vars?.AI_MODEL !== '@cf/meta/llama-3.1-8b-instruct-fast') {
  throw new Error(`unexpected production primary model: ${config?.vars?.AI_MODEL}`);
}
if (config?.vars?.AI_FALLBACK_MODEL !== '@cf/meta/llama-3.1-8b-instruct-fast') {
  throw new Error(`unexpected production fallback model: ${config?.vars?.AI_FALLBACK_MODEL}`);
}

console.log('Scheduled AI backfill, production single-pass pacing, collection-safe degradation, daily AI budget observability, and neuron-efficient primary-only production AI policy validated');
