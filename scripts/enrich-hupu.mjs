import { readFile, writeFile } from 'node:fs/promises';
import { categoryFor, fingerprintTitle, scoreItem, topicStatus } from '../src/utils.js';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const ENDPOINT = 'https://m.hupu.com/hot';
const nowIso = new Date().toISOString();

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
}

function decodeHtml(value = '') {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function fetchHotPage(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 trend-radar/1.5',
        accept: 'text/html,application/xhtml+xml',
        referer: 'https://www.hupu.com/'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractNextData(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Hupu hot page missing __NEXT_DATA__ payload');
  return JSON.parse(decodeHtml(match[1]).trim());
}

function normalizeRows(nextData) {
  const candidates = [
    nextData?.props?.pageProps?.res,
    nextData?.props?.pageProps?.data,
    nextData?.props?.pageProps?.list
  ];
  const rows = candidates.find(Array.isArray) || [];
  return rows.map((row, index) => ({
    title: String(row?.tagName || row?.title || row?.name || '').trim(),
    heat: row?.heat ?? row?.hot ?? row?.hotValue ?? null,
    heat_path: row?.heat !== undefined ? 'item.heat' : row?.hot !== undefined ? 'item.hot' : row?.hotValue !== undefined ? 'item.hotValue' : null,
    rank: Number(row?.rank || index + 1) || index + 1,
    tagId: String(row?.tagId || row?.id || '').trim()
  })).filter(row => row.title);
}

function makeTopic(row, total, capturedAt) {
  const score = scoreItem(row.rank, total, 0, 0);
  const breakout = clamp(score * (row.rank <= 5 ? 0.95 : row.rank <= 10 ? 0.8 : 0.62));
  const id = fingerprintTitle(row.title);
  const url = row.tagId
    ? `https://m.hupu.com/search?q=${encodeURIComponent(row.title)}`
    : ENDPOINT;
  return {
    id,
    fingerprint: id,
    canonical_title: row.title,
    category: categoryFor('hupu', row.title),
    language: /[\u3400-\u9fff]/.test(row.title) ? 'zh' : 'en',
    first_seen_at: capturedAt,
    last_seen_at: capturedAt,
    current_score: Number(score.toFixed(1)),
    breakout_score: Number(breakout.toFixed(1)),
    source_count: 1,
    mention_count: 1,
    status: topicStatus(score, breakout),
    ai_summary: null,
    ai_why_now: null,
    opportunities: [],
    sources: [{
      source_id: 'hupu',
      external_id: `hupu:${row.tagId || id}`,
      url,
      title: row.title,
      rank: row.rank,
      captured_at: capturedAt
    }],
    raw_signals: [{ source_id: 'hupu', raw_heat_max: row.heat === null || row.heat === undefined ? null : Number(row.heat), raw_engagement_max: null, raw_heat_latest: row.heat === null || row.heat === undefined ? null : Number(row.heat), raw_engagement_latest: null, best_rank: row.rank, observations: 1, latest_captured_at: capturedAt, upstream: ENDPOINT, metric_paths: { heat: row.heat_path || null, engagement: null } }]
  };
}

function mergeTopics(existing, incoming) {
  const byId = new Map((existing || []).map(topic => [topic.id, topic]));
  for (const topic of incoming) {
    const old = byId.get(topic.id);
    if (!old) {
      byId.set(topic.id, topic);
      continue;
    }
    const signalBySource = new Map([...(old.raw_signals || []), ...(topic.raw_signals || [])]
      .filter(signal => signal?.source_id)
      .map(signal => [signal.source_id, signal]));
    old.raw_signals = [...signalBySource.values()];
    const sourceByKey = new Map([...(old.sources || []), ...(topic.sources || [])]
      .filter(source => source?.source_id)
      .map(source => [`${source.source_id}:${source.external_id || source.url || source.title || ''}`, source]));
    old.sources = [...sourceByKey.values()];
    old.source_count = new Set(old.sources.map(source => source.source_id)).size;
    old.mention_count = Math.max(Number(old.mention_count || 0), old.sources.length);
    old.current_score = Math.max(Number(old.current_score || 0), Number(topic.current_score || 0));
    old.breakout_score = Math.max(Number(old.breakout_score || 0), Number(topic.breakout_score || 0));
    old.status = topicStatus(old.current_score, old.breakout_score);
  }
  return [...byId.values()]
    .sort((a, b) => Number(b.current_score || 0) - Number(a.current_score || 0) || Number(b.breakout_score || 0) - Number(a.breakout_score || 0))
    .slice(0, 200);
}

function setSource(dashboard, source) {
  dashboard.sources = [...(dashboard.sources || []).filter(existing => existing.id !== source.id), source];
}

const dashboard = JSON.parse(await readFile(DASHBOARD, 'utf8'));
const capturedAt = nowIso;

try {
  const html = await fetchHotPage();
  const rows = normalizeRows(extractNextData(html)).slice(0, 20);
  if (!rows.length) throw new Error('Hupu hot page returned no usable rows');
  const topics = rows.map(row => makeTopic(row, rows.length, capturedAt));
  dashboard.topics = mergeTopics(dashboard.topics, topics);
  setSource(dashboard, {
    id: 'hupu',
    name: '虎扑热榜',
    region: 'cn',
    kind: 'official-page',
    last_success_at: capturedAt,
    last_error_at: null,
    last_error: null,
    last_item_count: topics.length,
    latest_upstream: ENDPOINT
  });
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.log(`OK hupu: ${topics.length}; dashboard topics=${dashboard.topics.length}`);
} catch (error) {
  const message = String(error?.message || error).slice(0, 300);
  setSource(dashboard, {
    id: 'hupu',
    name: '虎扑热榜',
    region: 'cn',
    kind: 'official-page',
    last_success_at: null,
    last_error_at: nowIso,
    last_error: message,
    last_item_count: 0
  });
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.warn(`FAIL hupu: ${message}`);
  if (process.env.REQUIRE_HUPU === '1') throw error;
}
