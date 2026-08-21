import { readFile } from 'node:fs/promises';

const dashboard = JSON.parse(await readFile(new URL('../public/data/dashboard.json', import.meta.url), 'utf8'));

const topics = Array.isArray(dashboard.topics) ? dashboard.topics : [];
const bad = [];

for (const topic of topics) {
  const ai = topic.ai || {};
  const text = `${ai.summary || ''} ${ai.why_now || ''}`;
  if (!ai.summary || !ai.why_now) continue;
  if (text.length < 60) bad.push(topic.canonical_title || topic.title || 'unknown');
  if (/值得关注|热度较高|持续升温|具有重要意义|前景广阔|机会巨大/.test(text)) {
    bad.push(topic.canonical_title || topic.title || 'unknown');
  }
}

if (bad.length) {
  throw new Error(`AI quality check failed: ${bad.slice(0, 10).join(', ')}`);
}

console.log(`Validated AI quality for ${topics.length} topics`);
