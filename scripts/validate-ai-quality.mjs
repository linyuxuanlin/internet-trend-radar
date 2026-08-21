import { readFile } from 'node:fs/promises';

const dashboard = JSON.parse(await readFile(new URL('../public/data/dashboard.json', import.meta.url), 'utf8'));
const topics = Array.isArray(dashboard.topics) ? dashboard.topics : [];
const bad = [];
let checked = 0;

for (const topic of topics) {
  const summary = String(topic.ai_summary || topic.ai?.summary || '').trim();
  const whyNow = String(topic.ai_why_now || topic.ai?.why_now || '').trim();
  const opportunities = Array.isArray(topic.opportunities) ? topic.opportunities : (Array.isArray(topic.ai?.opportunities) ? topic.ai.opportunities : []);
  const updatedAt = String(topic.ai_updated_at || topic.ai?.updated_at || '').trim();
  if (!summary && !whyNow && !opportunities.length && !updatedAt) continue;
  checked++;
  const title = topic.canonical_title || topic.title || 'unknown';
  const reasons = [];
  if (summary.length < 20) reasons.push('summary');
  if (whyNow.length < 20) reasons.push('why_now');
  if (/值得关注|热度较高|持续升温|具有重要意义|前景广阔|机会巨大/.test(`${summary} ${whyNow}`)) reasons.push('template phrase');
  if (!opportunities.length) reasons.push('opportunities');
  if (opportunities.some(o => !String(o?.idea || '').trim() || !String(o?.rationale || '').trim())) reasons.push('opportunity detail');
  if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) reasons.push('updated_at');
  if (reasons.length) bad.push(`${title}: ${reasons.join(', ')}`);
}

if (bad.length) throw new Error(`AI quality check failed: ${bad.slice(0, 8).join(' | ')}`);
const required = Math.max(1, Number(process.env.MIN_VALID_AI_SUMMARIES || 1));
if (checked < required) throw new Error(`AI quality coverage too low: ${checked} < ${required}`);
if (dashboard.ai?.matchedCount != null && Number(dashboard.ai.matchedCount) !== checked) throw new Error(`AI matchedCount mismatch: ${dashboard.ai.matchedCount} != ${checked}`);
console.log(`Validated AI quality for ${checked} AI topics (${topics.length} total topics)`);
