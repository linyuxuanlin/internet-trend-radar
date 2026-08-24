import { readFile } from 'node:fs/promises';

const dashboard = JSON.parse(await readFile(new URL('../public/data/dashboard.json', import.meta.url), 'utf8'));
const maxAgeMs = Number(process.env.MAX_STATIC_CAPTURE_AGE_MS || 24 * 60 * 60 * 1000);
const futureSkewMs = Number(process.env.MAX_FUTURE_SKEW_MS || 5 * 60 * 1000);
const now = Date.now();
function validUpstream(value) {
  const upstream = String(value || '').trim();
  if (upstream.startsWith('xiaohongshu-mcp:')) return true;
  try {
    return new URL(upstream).protocol === 'https:';
  } catch {
    return false;
  }
}
for (const source of dashboard.sources || []) {
  const healthy = Boolean(source?.last_success_at && Number(source?.last_item_count || 0) > 0);
  if (healthy && !source.latest_upstream && !source.upstream) {
    throw new Error(`healthy static source ${source.id} is missing latest upstream`);
  }
  if (!healthy && source?.last_error && source.upstream_stage !== 'failed') {
    throw new Error(`degraded static source ${source.id} must expose upstream_stage=failed`);
  }
}
for (const topic of dashboard.topics || []) {
  if (topic.score_semantics !== 'derived trend index; not an upstream platform heat value' || !String(topic.score_method || '').includes('rank-only')) {
    throw new Error(`topic ${topic.id || topic.canonical_title} is missing explicit static score semantics`);
  }
  const refs = new Set((topic.sources || []).map(ref => ref?.source_id).filter(Boolean));
  const signals = Array.isArray(topic.raw_signals) ? topic.raw_signals : [];
  const signalIds = new Set(signals.map(signal => signal?.source_id).filter(Boolean));
  if (signalIds.size !== refs.size || [...refs].some(id => !signalIds.has(id))) {
    throw new Error(`topic ${topic.id || topic.canonical_title} raw_signals/source refs mismatch`);
  }
  for (const signal of signals) {
    const source = (dashboard.sources || []).find(item => item?.id === signal.source_id) || {};
    if (source.kind && signal.source_kind && source.kind !== signal.source_kind) {
      throw new Error(`topic ${topic.id} ${signal.source_id} source kind disagrees with source health`);
    }
    if (source.kind === 'official-rss' && (signal.metric_definition?.heat !== null || signal.metric_definition?.engagement !== null || signal.raw_heat_max !== null || signal.raw_engagement_max !== null)) {
      throw new Error(`RSS source ${signal.source_id} must not expose native heat or engagement values`);
    }
    for (const field of ['raw_heat_max', 'raw_engagement_max', 'raw_heat_latest', 'raw_engagement_latest']) {
      if (signal[field] !== null && (!Number.isFinite(Number(signal[field])) || Number(signal[field]) < 0)) {
        throw new Error(`topic ${topic.id} ${field} is not a nonnegative number or NULL`);
      }
    }
    const capturedAt = Date.parse(signal.latest_captured_at);
    if (!Number.isFinite(capturedAt)) throw new Error(`topic ${topic.id} ${signal.source_id} has invalid latest_captured_at`);
    if (capturedAt - now > futureSkewMs) throw new Error(`topic ${topic.id} ${signal.source_id} latest_captured_at is in the future`);
    if (now - capturedAt > maxAgeMs) throw new Error(`topic ${topic.id} ${signal.source_id} latest_captured_at is stale`);
    if (signal.upstream !== null && (!/^https:\/\//.test(String(signal.upstream)) || !URL.canParse(String(signal.upstream)))) {
      throw new Error(`topic ${topic.id} ${signal.source_id} has invalid upstream`);
    }
    if (!Array.isArray(signal.observed_upstreams) || !signal.observed_upstreams.length) {
      throw new Error(`topic ${topic.id} ${signal.source_id} is missing observed_upstreams`);
    }
    if (signal.upstream && !signal.observed_upstreams.includes(signal.upstream)) {
      throw new Error(`topic ${topic.id} ${signal.source_id} latest upstream is absent from observed_upstreams`);
    }
    for (const upstream of signal.observed_upstreams) {
      if (!validUpstream(upstream)) throw new Error(`topic ${topic.id} ${signal.source_id} has invalid observed upstream`);
    }
    if (!signal.peak_evidence || typeof signal.peak_evidence !== 'object') {
      throw new Error(`topic ${topic.id} ${signal.source_id} is missing peak_evidence`);
    }
    const definition = signal.metric_definition || {};
    if (definition.heat === null && signal.raw_heat_max !== null) throw new Error(`topic ${topic.id} ${signal.source_id} reports heat despite NULL metric definition`);
    if (definition.engagement === null && signal.raw_engagement_max !== null) throw new Error(`topic ${topic.id} ${signal.source_id} reports engagement despite NULL metric definition`);
    if (signal.raw_heat_max !== null && !String(signal.metric_paths?.heat || '').trim()) throw new Error(`topic ${topic.id} ${signal.source_id} is missing heat metric path`);
    if (signal.raw_engagement_max !== null && !String(signal.metric_paths?.engagement || '').trim()) throw new Error(`topic ${topic.id} ${signal.source_id} is missing engagement metric path`);
    for (const metric of ['heat', 'engagement']) {
      const value = signal[`raw_${metric}_max`];
      const path = signal.metric_paths?.[metric];
      const allowedPaths = definition[`${metric}_paths`];
      if (value !== null && Array.isArray(allowedPaths) && allowedPaths.length && !allowedPaths.includes(path)) {
        throw new Error(`topic ${topic.id} ${signal.source_id} has ${metric} metric path outside declared adapter contract: ${path}`);
      }
    }
    for (const metric of ['heat', 'engagement']) {
      const evidence = signal.peak_evidence[metric];
      if (signal[`raw_${metric}_max`] !== null) {
        if (!evidence || !validUpstream(evidence.upstream) || !signal.observed_upstreams.includes(evidence.upstream)) {
          throw new Error(`topic ${topic.id} ${signal.source_id} has incomplete ${metric} peak evidence`);
        }
        if (!String(evidence.metric_path || signal.metric_paths?.[metric] || '').trim()) {
          throw new Error(`topic ${topic.id} ${signal.source_id} has ${metric} peak evidence without metric path`);
        }
      }
    }
  }
}
console.log(`Static provenance validated: ${dashboard.topics?.length || 0} topics have aligned raw signal records`);
