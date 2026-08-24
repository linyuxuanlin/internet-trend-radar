import { readFile, writeFile } from 'node:fs/promises';
import { categoryFor, fingerprintTitle, scoreItem, topicStatus } from '../src/utils.js';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const PAGE = 'https://top.baidu.com/board?tab=realtime';
const nowIso = new Date().toISOString();

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
}

async function fetchHtml(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(PAGE, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 trend-radar/1.3',
        accept: 'text/html,application/xhtml+xml',
        referer: 'https://www.baidu.com/'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(text = '') {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseEmbeddedData(html) {
  const patterns = [
    /<!--s-data:([\s\S]*?)-->/,
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    try {
      const parsed = JSON.parse(decodeHtml(match[1]).trim());
      const candidates = [
        parsed?.data?.cards?.[0]?.content,
        parsed?.props?.pageProps?.data?.cards?.[0]?.content,
        parsed?.props?.pageProps?.cards?.[0]?.content
      ];
      const rows = candidates.find(Array.isArray);
      if (rows?.length) return rows;
    } catch {}
  }
  return [];
}

function parseFallback(html) {
  const rows = [];
  const blocks = html.match(/<div[^>]+class=["'][^"']*category-wrap_iQLoo[^"']*["'][\s\S]*?(?=<div[^>]+class=["'][^"']*category-wrap_iQLoo|$)/g) || [];
  for (const block of blocks) {
    const title = decodeHtml((block.match(/class=["'][^"']*c-single-text-ellipsis[^"']*["'][^>]*>([\s\S]*?)<\//) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
    const desc = decodeHtml((block.match(/class=["'][^"']*hot-desc[^"']*["'][^>]*>([\s\S]*?)<\//) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const heatText = (block.match(/hot-index[^>]*>([\d,]+)/) || [])[1] || '0';
    const url = decodeHtml((block.match(/href=["']([^"']+)["']/) || [])[1] || '').trim();
    if (title) rows.push({ word: title, desc, hotScore: heatText ? Number(heatText.replace(/,/g, '')) : null, url });
  }
  return rows;
}

function normalizeRows(raw) {
  return raw.map((row, index) => ({
    title: String(row?.word || row?.query || row?.title || '').trim(),
    desc: String(row?.desc || row?.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    // `index` is a ranking/index field in Baidu payloads, not a heat counter.
    // Never promote it to raw heat when the upstream omits hotScore.
    heat: row?.hotScore ?? row?.hot_score ?? null,
    heat_path: row?.hotScore !== undefined ? 'item.hotScore' : row?.hot_score !== undefined ? 'item.hot_score' : null,
    url: String(row?.url || row?.rawUrl || row?.appUrl || '').trim(),
    rank: index + 1
  })).filter(row => row.title);
}

function makeTopic(row, total, capturedAt) {
  const score = scoreItem(row.rank, total, 0, 0);
  const breakout = clamp(score * (row.rank <= 5 ? 0.95 : row.rank <= 10 ? 0.8 : 0.62));
  const id = fingerprintTitle(row.title);
  const fallbackUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(row.title)}`;
  return {
    id,
    fingerprint: id,
    canonical_title: row.title,
    category: categoryFor('baidu', row.title),
    language: /[\u3400-\u9fff]/.test(row.title) ? 'zh' : 'en',
    first_seen_at: capturedAt,
    last_seen_at: capturedAt,
    current_score: Number(score.toFixed(1)),
    breakout_score: Number(breakout.toFixed(1)),
    source_count: 1,
    mention_count: 1,
    status: topicStatus(score, breakout),
    source_summary: row.desc.slice(0, 180) || null,
    ai_summary: null,
    ai_why_now: null,
    opportunities: [],
    sources: [{
      source_id: 'baidu',
      external_id: `baidu:${id}`,
      url: row.url || fallbackUrl,
      title: row.title,
      rank: row.rank,
      captured_at: capturedAt
    }],
    raw_signals: [{ source_id: 'baidu', raw_heat_max: row.heat === null || row.heat === undefined ? null : Number(row.heat), raw_engagement_max: null, raw_heat_latest: row.heat === null || row.heat === undefined ? null : Number(row.heat), raw_engagement_latest: null, best_rank: row.rank, observations: 1, latest_captured_at: capturedAt, upstream: PAGE, metric_paths: { heat: row.heat_path || null, engagement: null } }]
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
    .slice(0, 180);
}

function setSource(dashboard, source) {
  dashboard.sources = [...(dashboard.sources || []).filter(existing => existing.id !== source.id), source];
}

const dashboard = JSON.parse(await readFile(DASHBOARD, 'utf8'));
const capturedAt = nowIso;

try {
  const html = await fetchHtml();
  const raw = parseEmbeddedData(html);
  const rows = normalizeRows(raw.length ? raw : parseFallback(html)).slice(0, 20);
  if (!rows.length) throw new Error(`Baidu board returned no usable rows; htmlBytes=${html.length}`);
  const topics = rows.map(row => makeTopic(row, rows.length, capturedAt));
  dashboard.topics = mergeTopics(dashboard.topics, topics);
  setSource(dashboard, {
    id: 'baidu',
    name: '百度热搜',
    region: 'cn',
    kind: 'official-page',
    last_success_at: capturedAt,
    last_error_at: null,
    last_error: null,
    last_item_count: topics.length,
    latest_upstream: PAGE
  });
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.log(`OK baidu: ${topics.length}; dashboard topics=${dashboard.topics.length}`);
} catch (error) {
  const message = String(error?.message || error).slice(0, 300);
  setSource(dashboard, {
    id: 'baidu',
    name: '百度热搜',
    region: 'cn',
    kind: 'official-page',
    last_success_at: null,
    last_error_at: nowIso,
    last_error: message,
    last_item_count: 0
  });
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.warn(`FAIL baidu: ${message}`);
  if (process.env.REQUIRE_BAIDU === '1') throw error;
}
