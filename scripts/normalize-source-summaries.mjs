import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../public/data/dashboard.json', import.meta.url);
const dashboard = JSON.parse(await readFile(path, 'utf8'));
let moved = 0;

for (const topic of dashboard.topics || []) {
  const hasVerifiedAI = topic.ai_provenance?.verified_non_heuristic === true;
  const hasModelShape = Boolean(topic.ai_why_now || topic.ai_updated_at || (Array.isArray(topic.opportunities) && topic.opportunities.length));
  if (!hasVerifiedAI && !hasModelShape && String(topic.ai_summary || '').trim()) {
    topic.source_summary = topic.source_summary || topic.ai_summary;
    topic.ai_summary = null;
    moved++;
  }
}

await writeFile(path, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
console.log(`Normalized ${moved} source descriptions out of ai_summary`);
