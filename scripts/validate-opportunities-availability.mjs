import { readFile } from 'node:fs/promises';

const file = new URL('../public/data/opportunities.json', import.meta.url);
const data = JSON.parse(await readFile(file, 'utf8'));

if (!data || typeof data !== 'object') throw new Error('opportunities payload missing');
if (!['healthy', 'degraded'].includes(data.status)) throw new Error(`invalid opportunities status: ${data.status}`);
if (data.status === 'healthy') {
  if (!Array.isArray(data.opportunities) || data.opportunities.length === 0) {
    throw new Error('healthy opportunities payload has no items');
  }
}

console.log(JSON.stringify({
  ok: true,
  status: data.status,
  count: Array.isArray(data.opportunities) ? data.opportunities.length : 0,
  generatedAt: data.generatedAt || null
}));
