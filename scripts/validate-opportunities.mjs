import { readFile } from 'node:fs/promises';

const path = new URL('../public/data/opportunities.json', import.meta.url);
const data = JSON.parse(await readFile(path, 'utf8'));

if (data.status !== 'healthy') throw new Error('opportunities status is not healthy');
if (!Array.isArray(data.opportunities) || data.opportunities.length < 1) throw new Error('no AI opportunities generated');

const banned = [
  '正在进入活跃讨论区间',
  '值得关注',
  '热度较高所以重要',
  '可结合来源扩散和热度增速判断'
];

function meaningful(value) {
  const text = String(value || '').trim();
  return text.length >= 12 && !banned.some(x => text.includes(x));
}

for (const item of data.opportunities) {
  if (!item.title || !item.evidence || !item.analysis) throw new Error('invalid opportunity schema');

  const analysis = item.analysis;
  if (!meaningful(analysis.summary)) throw new Error(`weak AI summary: ${item.title}`);
  if (!meaningful(analysis.why_now)) throw new Error(`weak AI timing analysis: ${item.title}`);
  if (!Array.isArray(analysis.ideas) || analysis.ideas.length < 1) throw new Error(`missing AI ideas: ${item.title}`);

  for (const idea of analysis.ideas) {
    if (!meaningful(idea.idea) || !meaningful(idea.rationale)) {
      throw new Error(`weak AI opportunity detail: ${item.title}`);
    }
  }
}

console.log(`Validated ${data.opportunities.length} high-quality opportunities`);
