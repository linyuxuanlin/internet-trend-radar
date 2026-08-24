import { validateMetricProvenance, validateRawProvenance } from '../src/collector.js';

validateRawProvenance([{ raw: { trendRadarUpstream: 'https://example.test/source' } }], 'valid-fixture');

let rejected = false;
try {
  validateRawProvenance([{ raw: { item: { id: 'missing-upstream' } } }], 'invalid-fixture');
} catch (error) {
  rejected = String(error?.message || error).includes('raw.trendRadarUpstream is required');
}

if (!rejected) throw new Error('missing raw provenance was not rejected before persistence');

let insecureRejected = false;
try {
  validateRawProvenance([{ raw: { trendRadarUpstream: 'http://example.test/source' } }], 'insecure-fixture');
} catch (error) {
  insecureRejected = String(error?.message || error).includes('must use HTTPS');
}

if (!insecureRejected) throw new Error('non-HTTPS raw provenance was not rejected before persistence');

validateRawProvenance([{ raw: { trendRadarUpstream: 'xiaohongshu-mcp:/api/v1/feeds/search' } }], 'bridge-fixture');

validateMetricProvenance([{
  heat: 0,
  engagement: null,
  raw: { trendRadarMetrics: { heat_path: 'item.score', engagement_path: null } }
}], 'metric-valid-fixture');

let metricRejected = false;
try {
  validateMetricProvenance([{ heat: 12, raw: { trendRadarMetrics: { heat_path: null } } }], 'metric-invalid-fixture');
} catch (error) {
  metricRejected = String(error?.message || error).includes('non-null heat requires');
}

if (!metricRejected) throw new Error('metric provenance without a field path was not rejected before persistence');

let nullContractRejected = false;
try {
  validateMetricProvenance([{ sourceId: 'v2ex', heat: 12, raw: { trendRadarMetrics: { heat_path: 'item.score' } } }], 'null-contract-fixture');
} catch (error) {
  nullContractRejected = String(error?.message || error).includes('declares heat=NULL');
}

if (!nullContractRejected) throw new Error('source metric contract allowed a value for a NULL-defined metric');

validateMetricProvenance([{ sourceId: 'baidu', heat: 123, raw: { trendRadarMetrics: { heat_path: 'item.hot_score' } } }], 'allowed-adapter-field-fixture');
let disallowedPathRejected = false;
try {
  validateMetricProvenance([{ sourceId: 'baidu', heat: 999, raw: { trendRadarMetrics: { heat_path: 'item.score' } } }], 'disallowed-adapter-field-fixture');
} catch (error) {
  disallowedPathRejected = String(error?.message || error).includes('not an allowed adapter field');
}
if (!disallowedPathRejected) throw new Error('source metric contract allowed an undocumented heat path');
console.log('Raw provenance integrity validated: upstream and non-null metric values require explicit provenance');
