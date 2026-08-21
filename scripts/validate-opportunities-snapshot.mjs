import { readFile } from 'node:fs/promises';

const opportunitiesPath = new URL('../public/data/opportunities.json', import.meta.url);
const healthPath = new URL('../public/data/health.json', import.meta.url);

const opportunities = JSON.parse(await readFile(opportunitiesPath, 'utf8'));
const health = JSON.parse(await readFile(healthPath, 'utf8'));

if (!['healthy', 'degraded'].includes(opportunities.status)) {
  throw new Error(`invalid opportunities status: ${opportunities.status}`);
}

if (opportunities.status === 'healthy') {
  if (!Array.isArray(opportunities.opportunities) || opportunities.opportunities.length === 0) {
    throw new Error('healthy opportunities snapshot must contain opportunities');
  }
}

if (health.aiAnalysis) {
  if (health.aiAnalysis.status !== opportunities.status) {
    throw new Error(`AI health mismatch: health=${health.aiAnalysis.status} opportunities=${opportunities.status}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  status: opportunities.status,
  opportunities: Array.isArray(opportunities.opportunities) ? opportunities.opportunities.length : 0,
  generatedAt: opportunities.generatedAt || null
}));
