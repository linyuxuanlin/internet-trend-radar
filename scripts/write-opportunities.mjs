import { readFile, writeFile } from 'node:fs/promises';

const dashboardPath = new URL('../public/data/dashboard.json', import.meta.url);
const outputPath = new URL('../public/data/opportunities.json', import.meta.url);

const dashboard = JSON.parse(await readFile(dashboardPath, 'utf8'));
if (dashboard.preview !== false || dashboard.ready !== true) {
  throw new Error('opportunities require real dashboard');
}

const buildSha = String(dashboard.buildSha || '').trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(buildSha)) {
  throw new Error(`opportunities require stamped dashboard buildSha; got: ${buildSha || '<empty>'}`);
}

function usableAI(topic) {
  const summary = String(topic.ai_summary || '').trim();
  const why = String(topic.ai_why_now || '').trim();
  const ideas = Array.isArray(topic.opportunities) ? topic.opportunities : [];
  if (!summary || !why || ideas.length < 1) return false;
  if (summary.includes('正在进入活跃讨论区间，可结合来源扩散和热度增速判断是否形成持续趋势')) return false;
  if (why.includes('当前综合热度') && why.includes('突破指数') && why.includes('覆盖')) return false;
  const signals = Array.isArray(topic.raw_signals) ? topic.raw_signals : [];
  if (!signals.length || signals.some(signal => !signal?.source_id || !signal?.upstream || !signal?.latest_captured_at)) return false;
  return ideas.every(i => String(i.idea || '').trim() && String(i.rationale || '').trim());
}

const topics = [...(dashboard.topics || [])]
  .filter(usableAI)
  .sort((a,b) => Number(b.breakout_score||0)-Number(a.breakout_score||0))
  .slice(0,5);

const opportunities = topics.map(t => ({
  title: t.canonical_title,
  evidence: [
    `${t.source_count || 0} 个真实来源覆盖`,
    `趋势指数 ${Math.round(t.current_score || 0)}（派生指标）`,
    `突破指数 ${Math.round(t.breakout_score || 0)}`
  ],
  provenance: Array.isArray(t.raw_signals) ? t.raw_signals : [],
  analysis: {
    summary: t.ai_summary,
    why_now: t.ai_why_now,
    ideas: t.opportunities.slice(0,3),
    risks: t.ai_risks || ''
  }
}));

const payload = {
  generatedAt: dashboard.generatedAt || new Date().toISOString(),
  buildSha,
  source: 'pages-static',
  status: opportunities.length ? 'healthy' : 'degraded',
  provider: dashboard.ai?.provider || 'cloudflare-workers-ai',
  opportunities
};

await writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n');
console.log(`Wrote ${opportunities.length} quality-filtered opportunities for build ${buildSha}`);
