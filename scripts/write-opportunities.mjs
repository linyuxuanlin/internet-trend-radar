import { readFile, writeFile } from 'node:fs/promises';

const dashboardPath = new URL('../public/data/dashboard.json', import.meta.url);
const outputPath = new URL('../public/data/opportunities.json', import.meta.url);

const dashboard = JSON.parse(await readFile(dashboardPath, 'utf8'));
if (dashboard.preview !== false || dashboard.ready !== true) {
  throw new Error('opportunities require real dashboard');
}

const topics = [...(dashboard.topics || [])]
  .filter(t => t.ai_summary && Array.isArray(t.opportunities) && t.opportunities.length)
  .sort((a,b) => Number(b.breakout_score||0)-Number(a.breakout_score||0))
  .slice(0,5);

const opportunities = topics.map(t => ({
  title: t.canonical_title,
  evidence: [
    `${t.source_count || 0} 个真实来源覆盖`,
    `综合热度 ${Math.round(t.current_score || 0)}`,
    `突破指数 ${Math.round(t.breakout_score || 0)}`
  ],
  analysis: {
    summary: t.ai_summary,
    why_now: t.ai_why_now,
    ideas: t.opportunities.slice(0,3),
    risks: t.ai_risks || ''
  }
}));

const payload = {
  generatedAt: new Date().toISOString(),
  status: opportunities.length ? 'healthy' : 'degraded',
  provider: dashboard.ai?.provider || 'cloudflare-workers-ai',
  opportunities
};

await writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n');
console.log(`Wrote ${opportunities.length} opportunities`);
