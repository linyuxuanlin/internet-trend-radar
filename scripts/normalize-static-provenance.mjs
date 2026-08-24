import { readFile, writeFile } from 'node:fs/promises';
import { metricMetadata } from '../src/source-metadata.js';

const dashboardPath = new URL('../public/data/dashboard.json', import.meta.url);
const dashboard = JSON.parse(await readFile(dashboardPath, 'utf8'));
const sourceById = new Map((dashboard.sources || []).map(source => [source.id, source]));
const STATIC_SCORE_SEMANTICS = 'derived trend index; not an upstream platform heat value';
const STATIC_SCORE_METHOD = 'rank-only (static snapshot; source percentile history unavailable; no cross-platform raw metric aggregation)';

for (const topic of dashboard.topics || []) {
  topic.trend_score = Number(topic.current_score || 0);
  topic.score_semantics = STATIC_SCORE_SEMANTICS;
  topic.score_method = STATIC_SCORE_METHOD;
  const refs = Array.isArray(topic.sources) ? topic.sources : [];
  const existing = new Map((topic.raw_signals || []).map(signal => [signal.source_id, signal]));
  const sourceIds = [...new Set(refs.map(ref => String(ref?.source_id || '').trim()).filter(Boolean))];
  topic.raw_signals = sourceIds.map(sourceId => {
    const ref = refs.find(item => item?.source_id === sourceId) || {};
    const previous = existing.get(sourceId) || {};
    const source = sourceById.get(sourceId) || {};
    const metricDefinition = source.kind === 'official-rss'
      ? { heat: null, engagement: null, note: 'official RSS feed; publication feed does not expose a native heat or engagement counter' }
      : metricMetadata(sourceId);
    const upstream = ref.upstream || previous.upstream || source.latest_upstream || source.upstream || null;
    const observedUpstreams = [...new Set([
      ...(Array.isArray(previous.observed_upstreams) ? previous.observed_upstreams : []),
      upstream
    ].filter(Boolean))];
    const peakEvidence = previous.peak_evidence && typeof previous.peak_evidence === 'object'
      ? previous.peak_evidence
      : {
          heat: previous.raw_heat_max == null ? null : {
            captured_at: previous.latest_captured_at || ref.captured_at || topic.last_seen_at || null,
            upstream,
            source_kind: previous.source_kind || source.kind || null
          },
          engagement: previous.raw_engagement_max == null ? null : {
            captured_at: previous.latest_captured_at || ref.captured_at || topic.last_seen_at || null,
            upstream,
            source_kind: previous.source_kind || source.kind || null
          }
        };
    return {
      source_id: sourceId,
      source_kind: source.kind || previous.source_kind || null,
      metric_definition: metricDefinition,
      raw_heat_max: metricDefinition.heat === null ? null : previous.raw_heat_max ?? null,
      raw_engagement_max: metricDefinition.engagement === null ? null : previous.raw_engagement_max ?? null,
      raw_heat_latest: metricDefinition.heat === null ? null : previous.raw_heat_latest ?? previous.raw_heat_max ?? null,
      raw_engagement_latest: metricDefinition.engagement === null ? null : previous.raw_engagement_latest ?? previous.raw_engagement_max ?? null,
      best_rank: Number(previous.best_rank || ref.rank || 0),
      observations: Number(previous.observations || 1),
      latest_captured_at: previous.latest_captured_at || ref.captured_at || topic.last_seen_at || null,
      observed_upstreams: observedUpstreams,
      peak_evidence: peakEvidence,
      upstream,
      metric_paths: previous.metric_paths || null,
      units: 'source-native; not comparable across platforms'
    };
  });
}

for (const source of dashboard.sources || []) {
  if (source.id !== '36kr') delete source.latest_upstreams;
  const upstreams = [...new Set((dashboard.topics || [])
    .flatMap(topic => topic.raw_signals || [])
    .filter(signal => signal.source_id === source.id && signal.upstream)
    .map(signal => signal.upstream))];
  if (!source.latest_upstream && !source.upstream && upstreams.length === 1) source.latest_upstream = upstreams[0];
}

await writeFile(dashboardPath, JSON.stringify(dashboard, null, 2) + '\n');
console.log(`Normalized static provenance for ${dashboard.topics?.length || 0} topics`);
