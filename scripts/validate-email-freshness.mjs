import { readFile } from 'node:fs/promises';

const email = await readFile(new URL('../src/email.js', import.meta.url), 'utf8');
if (!/julianday\(last_seen_at\) >= julianday\('now','-2 hours'\)/.test(email)) {
  throw new Error('email digest must only include topics seen within the 2-hour freshness window');
}
if (!email.includes('未使用旧数据冒充今日实时热点')) {
  throw new Error('email digest must explain the empty fresh-data case truthfully');
}
if (!email.includes('evidence_sources') || !email.includes('证据来源')) {
  throw new Error('email digest must expose the active evidence source IDs');
}
if (!email.includes('evidence_detail') || !email.includes("trendRadarMetrics.heat_path") || !email.includes("trendRadarUpstream") || !email.includes('NULL 表示上游未提供')) {
  throw new Error('email digest must expose raw metric values, field paths, upstream, and NULL semantics');
}
if (!email.includes('趋势指数是派生指标，不是平台原始热度') || !email.includes('heat=') || !email.includes('engagement=')) {
  throw new Error('email digest must distinguish derived trend index from source-native metrics');
}
if (!email.includes("currentSourcePredicate('active_source')") || !email.includes("currentSourcePredicate('current_source')")) {
  throw new Error('email digest must exclude stale or failed sources from both evidence and topic selection');
}
console.log('Email freshness validated: digest never presents older topics as current realtime data');
