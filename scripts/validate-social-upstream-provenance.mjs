import { readFile } from 'node:fs/promises';

const dashboardPath = process.env.DASHBOARD_PATH || new URL('../public/data/dashboard.json', import.meta.url);
const required = String(process.env.REQUIRED_SOCIAL_SOURCES || 'weibo,zhihu')
  .split(',').map(x => x.trim()).filter(Boolean);
const optional = String(process.env.OPTIONAL_SOCIAL_SOURCES || 'douyin')
  .split(',').map(x => x.trim()).filter(Boolean)
  .filter(x => !required.includes(x));
const socialIds = [...required, ...optional];

const dashboard = JSON.parse(await readFile(dashboardPath, 'utf8'));
if (dashboard.preview !== false || dashboard.ready !== true) {
  throw new Error('social upstream provenance requires a real-data ready dashboard');
}

const results = [];
for (const sourceId of socialIds) {
  const source = (dashboard.sources || []).find(item => item?.id === sourceId);
  if (!source) throw new Error(`missing social source health entry: ${sourceId}`);
  const healthy = Boolean(source.last_success_at && !source.last_error);
  if (healthy) {
    if (!source.upstream || !/^https:\/\//.test(String(source.upstream))) {
      throw new Error(`${sourceId}: healthy source missing real upstream URL`);
    }
    if (!source.upstream_provider || source.upstream_provider === 'unknown') {
      throw new Error(`${sourceId}: healthy source missing upstream_provider`);
    }
    if (!source.upstream_stage || ['unknown', 'failed'].includes(source.upstream_stage)) {
      throw new Error(`${sourceId}: healthy source missing upstream_stage`);
    }
    const refs = (dashboard.topics || []).flatMap(topic => (topic.sources || []).filter(ref => ref?.source_id === sourceId));
    if (refs.length < 5) throw new Error(`${sourceId}: only ${refs.length} topic refs carry provenance`);
    const mismatched = refs.filter(ref => ref.upstream !== source.upstream);
    if (mismatched.length) {
      throw new Error(`${sourceId}: ${mismatched.length} topic refs disagree with source upstream ${source.upstream}`);
    }
  } else if (source.upstream_stage !== 'failed') {
    throw new Error(`${sourceId}: degraded source must expose upstream_stage=failed`);
  }
  results.push({
    sourceId,
    healthy,
    count: Number(source.last_item_count || 0),
    provider: source.upstream_provider ?? null,
    stage: source.upstream_stage ?? null,
    upstream: source.upstream ?? null,
    error: source.last_error ?? null
  });
}

console.log(JSON.stringify({ ok: true, preview: false, socialUpstreams: results }, null, 2));
