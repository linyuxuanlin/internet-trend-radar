import { readFile } from 'node:fs/promises';

const dashboard = JSON.parse(await readFile(new URL('../public/data/dashboard.json', import.meta.url), 'utf8'));
const aiEnricher = await readFile(new URL('./enrich-ai-opportunities.mjs', import.meta.url), 'utf8');
const topics = Array.isArray(dashboard.topics) ? dashboard.topics : [];
const bad = [];
let checked = 0;

for (const topic of topics) {
  if (topic.ai_provenance?.verified_non_heuristic !== true) continue;
  checked++;
  const summary = String(topic.ai_summary || '').trim();
  const whyNow = String(topic.ai_why_now || '').trim();
  const opportunities = Array.isArray(topic.opportunities) ? topic.opportunities : [];
  const updatedAt = String(topic.ai_updated_at || '').trim();
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
const aiAvailable = dashboard.ai?.available === true;
if (aiAvailable && checked < 1) throw new Error('AI marked available but no verified summaries passed quality validation');
if (!aiAvailable && checked !== 0) throw new Error(`AI marked unavailable but ${checked} verified summaries are present`);
if (dashboard.ai?.matchedCount != null && Number(dashboard.ai.matchedCount) !== checked) throw new Error(`AI matchedCount mismatch: ${dashboard.ai.matchedCount} != ${checked}`);
if (!/topic\.raw_signals/.test(aiEnricher) || !/latest_captured_at/.test(aiEnricher) || !/AI source snapshot is stale or invalid/.test(aiEnricher)) {
  throw new Error('AI overlay must validate source evidence freshness, not only AI text freshness');
}
console.log(`Validated AI quality: available=${aiAvailable}, verified=${checked}, totalTopics=${topics.length}`);
