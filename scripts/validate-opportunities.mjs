import { readFile } from 'node:fs/promises';

const path = new URL('../public/data/opportunities.json', import.meta.url);
const data = JSON.parse(await readFile(path, 'utf8'));

if (data.status !== 'healthy') throw new Error('opportunities status is not healthy');
if (!Array.isArray(data.opportunities) || data.opportunities.length < 1) throw new Error('no AI opportunities generated');
for (const item of data.opportunities) {
  if (!item.title || !item.evidence || !item.analysis) throw new Error('invalid opportunity schema');
}
console.log(`Validated ${data.opportunities.length} opportunities`);
