import { readFile, writeFile } from 'node:fs/promises';

const dataDir = new URL('../public/data/', import.meta.url);
const dashboard = JSON.parse(await readFile(new URL('dashboard.json', dataDir), 'utf8'));
const health = JSON.parse(await readFile(new URL('health.json', dataDir), 'utf8'));
const opportunities = JSON.parse(await readFile(new URL('opportunities.json', dataDir), 'utf8'));

const buildSha = String(dashboard.buildSha || '').trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(buildSha)) throw new Error(`dashboard missing valid buildSha: ${dashboard.buildSha || '<empty>'}`);
if (String(health.buildSha || '').trim().toLowerCase() !== buildSha) throw new Error('health buildSha does not match dashboard');
if (String(opportunities.buildSha || '').trim().toLowerCase() !== buildSha) throw new Error('opportunities buildSha does not match dashboard');
if (!dashboard.generatedAt || health.generatedAt !== dashboard.generatedAt || opportunities.generatedAt !== dashboard.generatedAt) {
  throw new Error('release assets do not share generatedAt');
}
if (dashboard.preview !== false || dashboard.ready !== true) throw new Error('release receipt requires a real-data ready dashboard');

const sources = Array.isArray(dashboard.sources) ? dashboard.sources : [];
const healthySources = sources.filter(source => source?.last_success_at && Number(source?.last_item_count || 0) > 0);
const directCnSources = healthySources.filter(source => source?.region === 'cn' && ['official-api', 'official-rss', 'official-page'].includes(source?.kind));
const sourceHealth = Array.isArray(health.sourceHealth) ? health.sourceHealth : [];
const socialIds = ['weibo', 'zhihu', 'douyin'];
const fallbackDepth = stage => {
  if (stage === 'official-direct') return 0;
  const match = /^mirror-fallback-(\d+)$/.exec(stage);
  if (!match) throw new Error(`unsupported social upstream stage: ${stage}`);
  const depth = Number(match[1]);
  if (!Number.isInteger(depth) || depth < 1) throw new Error(`invalid social fallback depth: ${stage}`);
  return depth;
};
const socialUpstreams = Object.fromEntries(socialIds.map(id => {
  const row = sourceHealth.find(item => item?.id === id);
  if (!row?.healthy) throw new Error(`${id}: release receipt requires healthy social source`);
  const upstream = String(row.upstream || '').trim();
  const provider = String(row.upstreamProvider || '').trim();
  const stage = String(row.upstreamStage || '').trim();
  if (!/^https:\/\//.test(upstream)) throw new Error(`${id}: release receipt missing HTTPS upstream`);
  if (!provider || provider === 'unknown') throw new Error(`${id}: release receipt missing upstream provider`);
  if (!stage || ['unknown', 'failed'].includes(stage)) throw new Error(`${id}: release receipt missing upstream stage`);
  return [id, { provider, stage, upstream, fallbackDepth: fallbackDepth(stage) }];
}));
const fallbackSocialSources = socialIds.filter(id => socialUpstreams[id].fallbackDepth > 0);
const socialFallbackMaxDepth = Math.max(0, ...socialIds.map(id => socialUpstreams[id].fallbackDepth));
const socialFallbackSeverity = socialFallbackMaxDepth === 0 ? 'none' : socialFallbackMaxDepth === 1 ? 'fallback' : 'deep-fallback';

const receipt = {
  buildSha,
  generatedAt: dashboard.generatedAt,
  preview: false,
  ready: true,
  topics: Array.isArray(dashboard.topics) ? dashboard.topics.length : 0,
  healthySources: healthySources.length,
  directCnSources: directCnSources.length,
  socialUpstreams,
  fallbackSocialSources,
  socialFallbackMaxDepth,
  socialFallbackSeverity,
  aiMatched: Number(dashboard?.ai?.matchedCount || 0),
  opportunitiesStatus: opportunities.status,
  opportunities: Array.isArray(opportunities.opportunities) ? opportunities.opportunities.length : 0
};

if (receipt.topics < 1) throw new Error('release receipt refuses empty dashboard');
await writeFile(new URL('release.json', dataDir), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, ...receipt }));
