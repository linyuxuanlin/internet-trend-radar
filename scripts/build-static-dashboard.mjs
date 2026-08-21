import { mkdir, writeFile } from 'node:fs/promises';
import { categoryFor, fingerprintTitle, scoreItem, topicStatus } from '../src/utils.js';

const OUT = new URL('../public/data/dashboard.json', import.meta.url);
const NOW = new Date();
const nowIso = NOW.toISOString();
const GITHUB_API_TOKEN = String(process.env.GITHUB_API_TOKEN || '').trim();

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
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, init = {}, timeoutMs = 12000) {
  const res = await fetchResponse(url, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers || {}) }
  }, timeoutMs);
  return await res.json();
}

function makeTopic({ sourceId, title, url = '', rank = 1, total = 50, heat = 0, engagement = 0, summary = '' }) {
  const score = scoreItem(rank, total, heat, engagement);
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
    ai_summary: summary || null,
    ai_why_now: null,
    opportunities: [],
    sources: [{ source_id: sourceId, external_id: `${sourceId}:${rank}:${id}`, url, title, rank, captured_at: nowIso }]
  };
}

function healthySource(id, name, region, kind, count) {
  return {
    id, name, region, kind,
    last_success_at: nowIso,
    last_error_at: null,
    last_error: null,
    last_item_count: count
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
    last_item_count: 0
  };
}

async function collectV2EX() {
  const list = await fetchJson('https://www.v2ex.com/api/topics/hot.json');
  if (!Array.isArray(list) || !list.length) throw new Error('empty data');
  const topics = list.slice(0, 20).map((item, i) => {
    const title = String(item?.title || '').trim();
    if (!title) return null;
    const replies = Number(item?.replies || 0);
    const node = String(item?.node?.title || item?.node?.name || '').trim();
    const member = String(item?.member?.username || '').trim();
    const summary = [node && `V2EX · ${node}`, member && `@${member}`, `${replies} replies`].filter(Boolean).join(' · ');
    return makeTopic({
      sourceId: 'v2ex',
      title,
      url: item?.url || (item?.id ? `https://www.v2ex.com/t/${item.id}` : ''),
      rank: i + 1,
      total: list.length,
      heat: replies,
      engagement: replies,
      summary
    });
  }).filter(Boolean);
  if (!topics.length) throw new Error('no usable titles');
  return { topics, source: healthySource('v2ex', 'V2EX', 'cn', 'official-api', topics.length) };
}

async function collectHackerNews() {
  const ids = await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json');
  const selected = Array.isArray(ids) ? ids.slice(0, 18) : [];
  const rows = (await Promise.all(selected.map(id => fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null)))).filter(Boolean);
  const topics = rows.map((item, i) => makeTopic({
    sourceId: 'hackernews',
    title: String(item.title || '').trim(),
    url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
    rank: i + 1,
    total: rows.length,
    heat: Number(item.score || 0),
    engagement: Number(item.descendants || 0),
    summary: item.by ? `Hacker News · ${item.by}` : 'Hacker News'
  })).filter(x => x.canonical_title);
  if (!topics.length) throw new Error('empty data');
  return { topics, source: healthySource('hackernews', 'Hacker News', 'global', 'official-api', topics.length) };
}

async function collectGitHub() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const q = encodeURIComponent(`created:>=${since}`);
  const headers = { 'x-github-api-version': '2022-11-28' };
  if (GITHUB_API_TOKEN) headers.authorization = `Bearer ${GITHUB_API_TOKEN}`;
  const body = await fetchJson(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=20`, { headers });
  const list = Array.isArray(body?.items) ? body.items : [];
  const topics = list.map((repo, i) => makeTopic({
    sourceId: 'github',
    title: repo.full_name,
    url: repo.html_url || '',
    rank: i + 1,
    total: list.length,
    heat: Number(repo.stargazers_count || 0),
    engagement: Number(repo.forks_count || 0),
    summary: String(repo.description || '').slice(0, 180)
  }));
  if (!topics.length) throw new Error('empty data');
  return { topics, source: healthySource('github', 'GitHub', 'global', 'official-api', topics.length) };
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
        last_item_count: 0
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