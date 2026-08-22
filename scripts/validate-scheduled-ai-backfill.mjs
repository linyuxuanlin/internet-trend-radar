import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const collector = await readFile(new URL('../src/collector.js', import.meta.url), 'utf8');
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

console.log('Scheduled AI backfill, collection-safe degradation, and primary-only production AI policy validated');
