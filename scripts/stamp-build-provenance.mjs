import { readFile, writeFile } from 'node:fs/promises';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const buildSha = String(process.env.BUILD_SHA || '').trim();

if (!/^[0-9a-f]{40}$/i.test(buildSha)) {
  throw new Error(`BUILD_SHA must be a full 40-character git SHA; got: ${buildSha || '<empty>'}`);
}

const dashboard = JSON.parse(await readFile(DASHBOARD, 'utf8'));
if (dashboard.preview !== false || dashboard.ready !== true) {
  throw new Error('refusing to stamp provenance on a non-production dashboard');
}

dashboard.buildSha = buildSha.toLowerCase();
await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
console.log(`Stamped dashboard buildSha=${dashboard.buildSha}`);
