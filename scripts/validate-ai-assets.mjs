import { readFile } from 'node:fs/promises';

const root = new URL('../public/data/', import.meta.url);

const load = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));

const opportunities = await load('opportunities.json');
const health = await load('health.json');

if (!opportunities || typeof opportunities !== 'object') throw new Error('opportunities.json missing');
if (!health || typeof health !== 'object') throw new Error('health.json missing');

const ai = health.aiAnalysis || {};

if (ai.status !== opportunities.status) {
  throw new Error(`AI status mismatch: health=${ai.status} opportunities=${opportunities.status}`);
}

if (opportunities.status === 'healthy') {
  if (!Array.isArray(opportunities.opportunities) || opportunities.opportunities.length < 1) {
    throw new Error('healthy AI opportunities must contain at least one item');
  }
}

console.log(JSON.stringify({
  status: opportunities.status,
  opportunities: opportunities.opportunities?.length || 0,
  generatedAt: opportunities.generatedAt || null
}, null, 2));
