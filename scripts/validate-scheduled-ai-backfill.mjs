import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

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

console.log('Scheduled AI backfill validation passed');
