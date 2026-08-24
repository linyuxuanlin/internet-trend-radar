import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const scoring = await readFile(new URL('../src/scoring.js', import.meta.url), 'utf8');
const staticBuilder = await readFile(new URL('./build-static-dashboard.mjs', import.meta.url), 'utf8');
const staticEnricher = await readFile(new URL('./enrich-static-dashboard.mjs', import.meta.url), 'utf8');
const ai = await readFile(new URL('../src/ai.js', import.meta.url), 'utf8');
const api = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');
const qualityBlock = index.match(/const provenance = await env\.DB\.prepare\(`([\s\S]*?)`\)/)?.[1] || '';
if (!qualityBlock) throw new Error('data-quality provenance query not found');
if (!/CASE WHEN heat IS NULL THEN 1/.test(qualityBlock)) throw new Error('missing_heat must count NULL only');
if (!/CASE WHEN engagement IS NULL THEN 1/.test(qualityBlock)) throw new Error('missing_engagement must count NULL only');
if (/heat IS NULL OR heat <= 0|engagement IS NULL OR engagement <= 0/.test(qualityBlock)) {
  throw new Error('data-quality query still conflates zero with missing');
}
if (/heat IS NOT NULL AND heat > 0|engagement IS NOT NULL AND engagement > 0/.test(scoring)) {
  throw new Error('score query still excludes observed zero values');
}
if (!/MAX\(r\.heat\) AS max_heat/.test(scoring) || !/MAX\(r\.engagement\) AS max_engagement/.test(scoring)) {
  throw new Error('score query still converts all-missing metrics to zero');
}
if ((scoring.match(/currentSourcePredicate\('active_source'\)/g) || []).length < 2) {
  throw new Error('score rebuild and topic-source evidence must share the current-source freshness gate');
}
if (!/r\.id IS NOT NULL AND r\.heat IS NULL/.test(index) || !/r\.id IS NOT NULL AND r\.engagement IS NULL/.test(index)) {
  throw new Error('per-source quality query counts LEFT JOIN placeholders as missing metrics');
}
if (!/heat = null, engagement = null/.test(staticBuilder)) {
  throw new Error('static adapter defaults must preserve missing metrics as NULL');
}
if (!/heat = null, engagement = null/.test(staticEnricher)) {
  throw new Error('static enrichment defaults must preserve missing metrics as NULL');
}
if (!/old\.raw_signals = \[\.\.\.signalBySource\.values\(\)\]/.test(staticEnricher) || !/old\.source_count = new Set\(old\.sources\.map\(s => s\.source_id\)\)\.size/.test(staticEnricher)) {
  throw new Error('static enrichment must merge per-source evidence and derive unique source_count');
}
if (!/existing\.raw_signals = \[\.\.\.signalBySource\.values\(\)\]/.test(staticBuilder) || !/existing\.source_count = new Set\(existing\.sources\.map\(source => source\.source_id\)\)\.size/.test(staticBuilder)) {
  throw new Error('static duplicate merge must preserve per-source evidence without summing platform metrics');
}
if (!/CASE[\s\S]*AS source_kind/.test(ai) || !/trendRadarMetrics\.heat_path/.test(ai) || !/trendRadarMetrics\.engagement_path/.test(ai)) {
  throw new Error('AI evidence must derive source kind from the observed upstream and retain metric paths');
}
if (!/currentSourcePredicate\('active_source'\)/.test(ai)) {
  throw new Error('AI evidence must exclude stale or failed sources');
}
if (!/raw_heat_latest/.test(api) || !/raw_engagement_latest/.test(api)) {
  throw new Error('public raw signals must distinguish latest metrics from 24-hour maxima');
}
if (!/observed_upstreams/.test(api) || !/json_group_array\(DISTINCT/.test(api)) {
  throw new Error('public raw signals must retain the upstream history within the trend window');
}
if ((api.match(/currentSourcePredicate\('active_source'\)/g) || []).length < 2) {
  throw new Error('dashboard and topic evidence must exclude stale or failed sources');
}
if (!/heat_peak_captured_at/.test(api) || !/heat_peak_upstream/.test(api) || !/engagement_peak_captured_at/.test(api) || !/engagement_peak_upstream/.test(api)) {
  throw new Error('public raw signals must identify the evidence behind each 24-hour metric peak');
}
if (!/definition_heat_path_violations/.test(index) || !/definition_engagement_path_violations/.test(index) || !/definition_heat_path_violations/.test(api)) {
  throw new Error('runtime data quality must validate exact source metric paths, not only path presence');
}
if (!/json_each\(s\.metadata_json,'\$\.heat_paths'\)/.test(index) || !/json_each\(s\.metadata_json,'\$\.heat_paths'\)/.test(api)) {
  throw new Error('runtime data quality must accept only declared alternative heat paths');
}
if (!/heat_peak_metric_path/.test(api) || !/engagement_peak_metric_path/.test(api) || !/metric_path: row\.heat_peak_metric_path/.test(api)) {
  throw new Error('public peak evidence must retain the metric path that produced the peak');
}
console.log('Data-quality null semantics validated: zero is observed, NULL is missing');
