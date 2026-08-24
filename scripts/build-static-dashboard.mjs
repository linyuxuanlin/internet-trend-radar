import { mkdir, writeFile } from 'node:fs/promises';
import { categoryFor, fingerprintTitle, scoreItem, topicStatus } from '../src/utils.js';
import { metricMetadata } from '../src/source-metadata.js';

const OUT = new URL('../public/data/dashboard.json', import.meta.url);
const NOW = new Date();
const nowIso = NOW.toISOString();
const GITHUB_API_TOKEN = String(process.env.GITHUB_API_TOKEN || '').trim();
const STATIC_METRIC_PATHS = {
  v2ex: { heat: null, engagement: 'topics[].replies' },
  hackernews: { heat: 'item.score', engagement: 'item.descendants' },
  github: { heat: 'repository.stargazers_count', engagement: 'repository.forks_count' }
};

// These sources still lack independent direct collectors. Their shared DailyHot
// upstream has repeatedly failed DNS resolution in GitHub Actions. Do not spend
// three full collection attempts on a known-dead host; keep them transparently
// degraded and let scripts/probe-degraded-sources.mjs perform one shared live
// diagnostic probe later in the build.
const DEGRADED_DAILYHOT_SOURCES = [
  ['weibo', '微博'], ['zhihu', '知乎'], ['douyin', '抖音']
];

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
}

async function fetchResponse(url, init = {}, timeoutMs = 12000) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'user-agent': 'internet-trend-radar-static-builder/1.2',
          ...(init.headers || {})
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 750));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('request failed');
}

async function fetchJson(url, init = {}, timeoutMs = 12000) {
  const res = await fetchResponse(url, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers || {}) }
  }, timeoutMs);
  return await res.json();
}

function makeTopic({ sourceId, title, url = '', upstream = null, kind = null, rank = 1, total = 50, heat = null, engagement = null, summary = '' }) {
  // Static fallback has no cross-run source percentile history. Use rank only
  // so platform-native counters never become cross-platform score boosts.
  const score = scoreItem(rank, total, 0, 0);
  const breakout = clamp(score * (rank <= 5 ? 0.92 : rank <= 10 ? 0.76 : 0.58));
  const id = fingerprintTitle(title);
  return {
    id,
    fingerprint: id,
    canonical_title: title,
    category: categoryFor(sourceId, title),
    language: /[\u3400-\u9fff]/.test(title) ? 'zh' : 'en',
    first_seen_at: nowIso,
    last_seen_at: nowIso,
    current_score: Number(score.toFixed(1)),
    breakout_score: Number(breakout.toFixed(1)),
    source_count: 1,
    mention_count: 1,
    status: topicStatus(score, breakout),
    trend_score: Number(score.toFixed(1)),
    score_semantics: 'derived trend index; not an upstream platform heat value',
    score_method: 'rank-only (static snapshot; source percentile history unavailable)',
    raw_signals: [{
      source_id: sourceId,
      source_kind: kind || null,
      metric_definition: metricMetadata(sourceId),
      raw_heat_max: heat === null || heat === undefined ? null : Number(heat),
      raw_engagement_max: engagement === null || engagement === undefined ? null : Number(engagement),
      raw_heat_latest: heat === null || heat === undefined ? null : Number(heat),
      raw_engagement_latest: engagement === null || engagement === undefined ? null : Number(engagement),
      best_rank: rank,
      observations: 1,
      observed_upstreams: upstream ? [upstream] : [],
      latest_captured_at: nowIso,
      peak_evidence: {
        heat: heat === null || heat === undefined ? null : { captured_at: nowIso, upstream, source_kind: kind || null },
        engagement: engagement === null || engagement === undefined ? null : { captured_at: nowIso, upstream, source_kind: kind || null }
      },
      upstream,
      metric_paths: STATIC_METRIC_PATHS[sourceId] || { heat: null, engagement: null },
      units: 'source-native; not comparable across platforms'
    }],
    source_summary: summary || null,
    ai_summary: null,
    ai_why_now: null,
    opportunities: [],
    sources: [{ source_id: sourceId, external_id: `${sourceId}:${rank}:${id}`, url, title, rank, captured_at: nowIso }]
  };
}

function healthySource(id, name, region, kind, count, upstream = null) {
  const provenance = upstream ? { provider: new URL(upstream).hostname, stage: kind === 'official-api' ? 'official-direct' : 'custom-upstream' } : { provider: null, stage: null };
  return {
    id, name, region, kind,
    last_success_at: nowIso,
    last_error_at: null,
    last_error: null,
    last_item_count: count,
    latest_upstream: upstream,
    latest_upstream_captured_at: upstream ? nowIso : null,
    upstream,
    upstream_provider: provenance.provider,
    upstream_stage: provenance.stage
  };
}

function degradedDailyHotSource(id, name) {
  return {
    id,
    name,
    region: 'cn',
    kind: 'aggregator',
    last_success_at: null,
    last_error_at: nowIso,
    last_error: 'DailyHot collection skipped after repeated shared-upstream DNS failures; awaiting one shared live diagnostic probe.',
    last_item_count: 0,
    latest_upstream: null,
    latest_upstream_captured_at: null,
    upstream: null,
    upstream_provider: null,
    upstream_stage: 'failed'
  };
}

async function collectV2EX() {
  const list = await fetchJson('https://www.v2ex.com/api/topics/hot.json');
  if (!Array.isArray(list) || !list.length) throw new Error('empty data');
  const topics = list.slice(0, 20).map((item, i) => {
    const title = String(item?.title || '').trim();
    if (!title) return null;
    const replies = item?.replies === null || item?.replies === undefined ? null : Number(item.replies);
    const node = String(item?.node?.title || item?.node?.name || '').trim();
    const member = String(item?.member?.username || '').trim();
    const summary = [node && `V2EX · ${node}`, member && `@${member}`, replies === null ? null : `${replies} replies`].filter(Boolean).join(' · ');
    return makeTopic({
      sourceId: 'v2ex',
      kind: 'official-api',
      title,
      url: item?.url || (item?.id ? `https://www.v2ex.com/t/${item.id}` : ''),
      rank: i + 1,
      total: list.length,
      upstream: 'https://www.v2ex.com/api/topics/hot.json',
      heat: null,
      engagement: replies,
      summary
    });
  }).filter(Boolean);
  if (!topics.length) throw new Error('no usable titles');
  return { topics, source: healthySource('v2ex', 'V2EX', 'cn', 'official-api', topics.length, 'https://www.v2ex.com/api/topics/hot.json') };
}

async function collectHackerNews() {
  const ids = await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json');
  const selected = Array.isArray(ids) ? ids.slice(0, 18) : [];
  const rows = (await Promise.all(selected.map(id => fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null)))).filter(Boolean);
  const topics = rows.map((item, i) => makeTopic({
    sourceId: 'hackernews',
    kind: 'official-api',
    title: String(item.title || '').trim(),
    url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
    rank: i + 1,
    total: rows.length,
    heat: item.score === null || item.score === undefined ? null : Number(item.score),
    engagement: item.descendants === null || item.descendants === undefined ? null : Number(item.descendants),
    upstream: `https://hacker-news.firebaseio.com/v0/item/${item.id}.json`,
    summary: item.by ? `Hacker News · ${item.by}` : 'Hacker News'
  })).filter(x => x.canonical_title);
  if (!topics.length) throw new Error('empty data');
  return { topics, source: healthySource('hackernews', 'Hacker News', 'global', 'official-api', topics.length, 'https://hacker-news.firebaseio.com/v0/topstories.json') };
}

async function collectGitHub() {
  const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
  const q = encodeURIComponent(`created:>=${since}`);
  const upstream = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=30`;
  const headers = { 'x-github-api-version': '2022-11-28' };
  if (GITHUB_API_TOKEN) headers.authorization = `Bearer ${GITHUB_API_TOKEN}`;
  const body = await fetchJson(upstream, { headers });
  const list = Array.isArray(body?.items) ? body.items : [];
  const topics = list.map((repo, i) => makeTopic({
    sourceId: 'github',
    kind: 'official-api',
    title: repo.full_name,
    url: repo.html_url || '',
    rank: i + 1,
    total: list.length,
    heat: repo.stargazers_count === null || repo.stargazers_count === undefined ? null : Number(repo.stargazers_count),
    engagement: repo.forks_count === null || repo.forks_count === undefined ? null : Number(repo.forks_count),
    upstream,
    summary: String(repo.description || '').slice(0, 180)
  }));
  if (!topics.length) throw new Error('empty data');
  return { topics, source: healthySource('github', 'GitHub 新仓库', 'global', 'official-api', topics.length, upstream) };
}

function mergeExactDuplicates(rows) {
  const byId = new Map();
  for (const topic of rows) {
    const existing = byId.get(topic.id);
    if (!existing) {
      byId.set(topic.id, topic);
      continue;
    }
    existing.current_score = Math.max(existing.current_score, topic.current_score);
    existing.breakout_score = Math.max(existing.breakout_score, topic.breakout_score);
    existing.trend_score = existing.current_score;
    existing.raw_signals = [...(existing.raw_signals || []), ...(topic.raw_signals || [])];
    existing.source_count += 1;
    existing.mention_count += 1;
    existing.sources.push(...topic.sources);
    existing.status = topicStatus(existing.current_score, existing.breakout_score);
  }
  return [...byId.values()].sort((a, b) => b.current_score - a.current_score || b.breakout_score - a.breakout_score);
}

function categorySummary(topics) {
  const map = new Map();
  for (const t of topics) {
    const row = map.get(t.category) || { category: t.category, count: 0, total: 0 };
    row.count += 1;
    row.total += Number(t.current_score || 0);
    map.set(t.category, row);
  }
  return [...map.values()]
    .map(x => ({ category: x.category, count: x.count, avg_score: Number((x.total / x.count).toFixed(1)) }))
    .sort((a, b) => b.count - a.count);
}

async function main() {
  const topics = [];
  const sources = DEGRADED_DAILYHOT_SOURCES.map(([id, name]) => degradedDailyHotSource(id, name));
  const jobs = [
    { id: 'v2ex', name: 'V2EX', region: 'cn', kind: 'official-api', run: collectV2EX },
    { id: 'hackernews', name: 'Hacker News', region: 'global', kind: 'official-api', run: collectHackerNews },
    { id: 'github', name: 'GitHub', region: 'global', kind: 'official-api', run: collectGitHub }
  ];

  for (const source of sources) {
    console.warn(`SKIP ${source.id}: ${source.last_error}`);
  }

  for (const job of jobs) {
    try {
      const result = await job.run();
      topics.push(...result.topics);
      sources.push(result.source);
      console.log(`OK ${job.id}: ${result.topics.length}`);
    } catch (error) {
      const message = String(error?.message || error).slice(0, 300);
      console.warn(`FAIL ${job.id}: ${message}`);
      sources.push({
        id: job.id,
        name: job.name,
        region: job.region,
        kind: job.kind,
        last_success_at: null,
        last_error_at: nowIso,
        last_error: message,
        last_item_count: 0,
        latest_upstream: null,
        latest_upstream_captured_at: null,
        upstream: null,
        upstream_provider: null,
        upstream_stage: 'failed'
      });
    }
  }

  const merged = mergeExactDuplicates(topics).slice(0, 180);
  if (!merged.length) throw new Error('No real topics were collected; refusing to publish an empty/preview dashboard.');

  const avgScore = merged.reduce((sum, x) => sum + Number(x.current_score || 0), 0) / merged.length;
  const avgBreakout = merged.reduce((sum, x) => sum + Number(x.breakout_score || 0), 0) / merged.length;
  const hour = new Date(NOW);
  hour.setMinutes(0, 0, 0);

  const dashboard = {
    generatedAt: nowIso,
    ready: true,
    preview: false,
    mode: 'static-real-snapshot',
    coverage: {
      active_sources: sources.length,
      active_cn_sources: sources.filter(source => String(source.region || '').toLowerCase() === 'cn' && source.last_success_at && Number(source.last_item_count || 0) > 0).length,
      active_global_sources: sources.filter(source => String(source.region || '').toLowerCase() !== 'cn' && source.last_success_at && Number(source.last_item_count || 0) > 0).length,
      healthy_active_sources: sources.filter(source => source.last_success_at && Number(source.last_item_count || 0) > 0).length,
      degraded_active_sources: sources.filter(source => !source.last_success_at || Number(source.last_item_count || 0) <= 0).length
    },
    data_contract: {
      raw_fields: ['rank', 'heat', 'engagement', 'captured_at', 'upstream', 'observed_upstreams', 'metric_paths', 'peak_evidence'],
      raw_field_semantics: 'heat and engagement are source-native values; null means the source did not provide that metric',
      derived_fields: ['trend_score', 'current_score', 'breakout_score'],
      derived_score_method: 'rank-only (static snapshot; source percentile history unavailable; no cross-platform raw metric aggregation)',
      breakout_score_method: 'rank-only static breakout approximation; dynamic score deltas and persistence unavailable',
      provenance_requirement: 'every persisted raw item must include a valid HTTPS upstream or a registered external-bridge identifier',
      metric_provenance_requirement: 'a non-null heat or engagement value must include its raw.trendRadarMetrics field path; null means unavailable, not zero',
      source_kind_semantics: 'raw_signals.source_kind and peak_evidence.source_kind identify the observed upstream for that evidence',
      coverage_semantics: 'ready means at least one real topic exists; coverage.active_* reports the actual snapshot source scope'
    },
    topics: merged,
    sources,
    categories: categorySummary(merged),
    timeline: [{ t: hour.toISOString(), score: Number(avgScore.toFixed(1)), breakout: Number(avgBreakout.toFixed(1)) }]
  };

  await mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${merged.length} real topics from ${sources.filter(s => s.last_success_at).length}/${sources.length} healthy sources to ${OUT.pathname}`);
}

await main();
