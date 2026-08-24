const DEFAULT_DASHBOARD_URL = 'https://radar.wiki-power.com/data/dashboard.json';
const DEFAULT_RELEASE_URL = 'https://radar.wiki-power.com/data/release.json';

function isVerified(topic) {
  const summary = String(topic?.ai_summary || '').trim();
  const whyNow = String(topic?.ai_why_now || '').trim();
  const opportunities = Array.isArray(topic?.opportunities) ? topic.opportunities : [];
  return summary.length >= 20 && whyNow.length >= 20 && opportunities.some(o => String(o?.idea || '').trim() && String(o?.rationale || '').trim());
}

function freshnessBucket(topic, nowMs) {
  const lastSeenMs = Date.parse(topic?.last_seen_at || topic?.lastSeenAt || '');
  if (!Number.isFinite(lastSeenMs)) return 'unknown';
  const ageHours = Math.max(0, (nowMs - lastSeenMs) / 3600000);
  if (ageHours <= 6) return 'fresh_0_6h';
  if (ageHours <= 24) return 'recent_6_24h';
  return 'backlog_24h_plus';
}

function dashboardAgeHours(data, nowMs) {
  const generatedMs = Date.parse(data?.generatedAt || '');
  if (!Number.isFinite(generatedMs)) return null;
  return Math.max(0, Math.round(((nowMs - generatedMs) / 3600000) * 100) / 100);
}

export function validateReleaseReceipt(data, receipt) {
  const dashboardSha = String(data?.buildSha || '').trim().toLowerCase();
  const releaseSha = String(receipt?.buildSha || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(dashboardSha)) throw new Error(`dashboard missing valid buildSha: ${data?.buildSha || '<empty>'}`);
  if (releaseSha !== dashboardSha) throw new Error(`release/dashboard buildSha mismatch: release=${releaseSha || '<empty>'} dashboard=${dashboardSha}`);
  if (!data?.generatedAt || receipt?.generatedAt !== data.generatedAt) throw new Error('release/dashboard generatedAt mismatch');
  if (receipt?.preview !== false || receipt?.ready !== true) throw new Error('release receipt is not real-data ready');
  const topicCount = Array.isArray(data?.topics) ? data.topics.length : 0;
  if (Number(receipt?.topics) !== topicCount) throw new Error(`release/dashboard topic count mismatch: release=${receipt?.topics} dashboard=${topicCount}`);
  return true;
}

export function analyzeFreshnessCoverage(data, now = new Date()) {
  if (data?.preview !== false || data?.ready !== true || !Array.isArray(data?.topics)) {
    throw new Error('freshness analysis requires a real-data ready dashboard');
  }
  const nowMs = now.getTime();
  const eligible = data.topics.filter(topic => Number(topic?.current_score || 0) >= 45);
  const order = ['fresh_0_6h', 'recent_6_24h', 'backlog_24h_plus', 'unknown'];
  const buckets = Object.fromEntries(order.map(bucket => [bucket, { bucket, eligible: 0, verified: 0, pending: 0, coverage_pct: 0 }]));

  for (const topic of eligible) {
    const bucket = freshnessBucket(topic, nowMs);
    const item = buckets[bucket];
    item.eligible++;
    if (isVerified(topic)) item.verified++;
  }

  for (const item of Object.values(buckets)) {
    item.pending = Math.max(0, item.eligible - item.verified);
    item.coverage_pct = item.eligible ? Math.round((item.verified / item.eligible) * 1000) / 10 : 0;
  }

  const totalVerified = Object.values(buckets).reduce((sum, item) => sum + item.verified, 0);
  const latestEligible = buckets.fresh_0_6h.eligible + buckets.recent_6_24h.eligible;
  const latestVerified = buckets.fresh_0_6h.verified + buckets.recent_6_24h.verified;
  return {
    generated_at: new Date().toISOString(),
    dashboard_generated_at: data.generatedAt || null,
    dashboard_age_hours: dashboardAgeHours(data, nowMs),
    build_sha: data.buildSha || null,
    eligible_topics: eligible.length,
    verified_topics: totalVerified,
    overall_coverage_pct: eligible.length ? Math.round((totalVerified / eligible.length) * 1000) / 10 : 0,
    latest_24h_eligible: latestEligible,
    latest_24h_verified: latestVerified,
    latest_24h_coverage_pct: latestEligible ? Math.round((latestVerified / latestEligible) * 1000) / 10 : 0,
    buckets: order.map(bucket => buckets[bucket])
  };
}

function selfTest() {
  const now = new Date('2026-08-23T00:00:00Z');
  const valid = (id, lastSeen, verified) => ({
    id,
    current_score: 60,
    last_seen_at: lastSeen,
    ai_summary: verified ? '这是一个长度足够且基于真实证据生成的事件总结，用于验证新鲜度覆盖统计。' : null,
    ai_why_now: verified ? '多个来源在当前时间窗口同步出现变化，因此需要在配额内优先完成分析。' : null,
    opportunities: verified ? [{ idea: '验证一个具体需求', rationale: '使用真实来源和用户反馈验证需求强度' }] : []
  });
  const dashboard = {
    ready: true,
    preview: false,
    generatedAt: '2026-08-22T23:00:00Z',
    buildSha: 'a'.repeat(40),
    topics: [
      valid('fresh-ok', '2026-08-22T22:00:00Z', true),
      valid('fresh-pending', '2026-08-22T20:00:00Z', false),
      valid('recent-ok', '2026-08-22T12:00:00Z', true),
      valid('old-pending', '2026-08-20T00:00:00Z', false),
      { ...valid('below-threshold', '2026-08-22T23:00:00Z', true), current_score: 30 }
    ]
  };
  validateReleaseReceipt(dashboard, {
    buildSha: 'a'.repeat(40),
    generatedAt: dashboard.generatedAt,
    preview: false,
    ready: true,
    topics: dashboard.topics.length
  });
  let rejectedMismatch = false;
  try {
    validateReleaseReceipt(dashboard, { buildSha: 'b'.repeat(40), generatedAt: dashboard.generatedAt, preview: false, ready: true, topics: dashboard.topics.length });
  } catch {
    rejectedMismatch = true;
  }
  if (!rejectedMismatch) throw new Error('release mismatch was not rejected');
  const result = analyzeFreshnessCoverage(dashboard, now);
  const byBucket = Object.fromEntries(result.buckets.map(item => [item.bucket, item]));
  if (result.eligible_topics !== 4 || result.verified_topics !== 2) throw new Error(`unexpected totals: ${JSON.stringify(result)}`);
  if (result.dashboard_age_hours !== 1 || result.build_sha !== 'a'.repeat(40)) throw new Error('dashboard provenance mismatch');
  if (byBucket.fresh_0_6h.eligible !== 2 || byBucket.fresh_0_6h.verified !== 1 || byBucket.fresh_0_6h.coverage_pct !== 50) throw new Error('fresh bucket mismatch');
  if (byBucket.recent_6_24h.eligible !== 1 || byBucket.recent_6_24h.verified !== 1) throw new Error('recent bucket mismatch');
  if (byBucket.backlog_24h_plus.eligible !== 1 || byBucket.backlog_24h_plus.verified !== 0) throw new Error('backlog bucket mismatch');
  if (result.latest_24h_coverage_pct !== 66.7) throw new Error(`latest coverage mismatch: ${result.latest_24h_coverage_pct}`);
  console.log('AI freshness coverage self-test passed');
  console.log(JSON.stringify(result, null, 2));
}

async function fetchJson(urlString, timeoutMs, cacheBustKey) {
  const url = new URL(urlString);
  url.searchParams.set(cacheBustKey, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`${url.pathname} HTTP ${response.status}`);
  return response.json();
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const dashboardUrl = process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL;
  const releaseUrl = process.env.RELEASE_URL || DEFAULT_RELEASE_URL;
  const timeoutMs = Math.max(1000, Number(process.env.FETCH_TIMEOUT_MS || 15000));
  const maxDashboardAgeHours = Number(process.env.MAX_DASHBOARD_AGE_HOURS || 0);
  const [data, receipt] = await Promise.all([
    fetchJson(dashboardUrl, timeoutMs, '_radar_freshness'),
    fetchJson(releaseUrl, timeoutMs, '_radar_release')
  ]);
  validateReleaseReceipt(data, receipt);
  const result = analyzeFreshnessCoverage(data, new Date());
  if (maxDashboardAgeHours > 0 && (result.dashboard_age_hours == null || result.dashboard_age_hours > maxDashboardAgeHours)) {
    throw new Error(`dashboard snapshot is stale: age=${result.dashboard_age_hours ?? 'unknown'}h max=${maxDashboardAgeHours}h build=${result.build_sha || 'unknown'}`);
  }
  console.log(JSON.stringify({ ...result, release_receipt_verified: true }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
