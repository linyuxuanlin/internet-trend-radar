import { readFile, writeFile } from 'node:fs/promises';
import { categoryFor, fingerprintTitle, scoreItem, topicStatus } from '../src/utils.js';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const API = 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=20&desktop=true';
const nowIso = new Date().toISOString();

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
}

async function fetchZhihu(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 trend-radar/1.3',
        accept: 'application/json, text/plain, */*',
        referer: 'https://www.zhihu.com/hot'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRows(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.map((row, index) => {
    const target = row?.target || {};
    const title = String(target?.title || target?.question?.title || '').trim();
    const id = String(target?.id || target?.question?.id || '').trim();
    const excerpt = String(target?.excerpt || target?.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const detail = String(row?.detail_text || '').trim();
    const heatMatch = detail.match(/([\d,.]+)\s*(万|亿)?\s*热度/);
    let heat = 0;
    if (heatMatch) {
      heat = Number(heatMatch[1].replace(/,/g, '')) || 0;
      if (heatMatch[2] === '万') heat *= 10000;
      if (heatMatch[2] === '亿') heat *= 100000000;
    }
    return { id, title, excerpt, detail, heat, rank: index + 1 };
  }).filter(row => row.id && row.title);
}

function makeTopic(row, total, capturedAt) {
  const score = scoreItem(row.rank, total, row.heat, 0);
  const breakout = clamp(score * (row.rank <= 5 ? 0.95 : row.rank <= 10 ? 0.8 : 0.62));
  const fingerprint = fingerprintTitle(row.title);
  return {
    id: fingerprint,
    fingerprint,
    canonical_title: row.title,
    category: categoryFor('zhihu', row.title),
    language: /[\u3400-\u9fff]/.test(row.title) ? 'zh' : 'en',
    first_seen_at: capturedAt,
    last_seen_at: capturedAt,
    current_score: Number(score.toFixed(1)),
    breakout_score: Number(breakout.toFixed(1)),
    source_count: 1,
    mention_count: 1,
    status: topicStatus(score, breakout),
    ai_summary: [row.excerpt.slice(0, 180), row.detail].filter(Boolean).join(' · ') || null,
    ai_why_now: null,
    opportunities: [],
    sources: [{
      source_id: 'zhihu',
      external_id: `zhihu:${row.id}`,
      url: `https://www.zhihu.com/question/${row.id}`,
      title: row.title,
      rank: row.rank,
      captured_at: capturedAt
    }]
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
    const sourceIds = new Set((old.sources || []).map(source => source.source_id));
    old.sources = [...(old.sources || []), ...(topic.sources || []).filter(source => !sourceIds.has(source.source_id))];
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
const capturedAt = dashboard.generatedAt || nowIso;

try {
  const body = await fetchZhihu();
  const rows = normalizeRows(body).slice(0, 20);
  if (!rows.length) throw new Error(`hot-list API returned no usable topics; keys=${Object.keys(body || {}).join(',')}`);
  const topics = rows.map(row => makeTopic(row, rows.length, capturedAt));
  dashboard.topics = mergeTopics(dashboard.topics, topics);
  setSource(dashboard, {
    id: 'zhihu',
    name: '知乎热榜',
    region: 'cn',
    kind: 'official-api',
    last_success_at: capturedAt,
    last_error_at: null,
    last_error: null,
    last_item_count: topics.length
  });
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.log(`OK zhihu: ${topics.length}; dashboard topics=${dashboard.topics.length}`);
} catch (error) {
  const message = String(error?.message || error).slice(0, 300);
  setSource(dashboard, {
    id: 'zhihu',
    name: '知乎热榜',
    region: 'cn',
    kind: 'official-api',
    last_success_at: null,
    last_error_at: nowIso,
    last_error: message,
    last_item_count: 0
  });
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.warn(`FAIL zhihu: ${message}`);
  if (process.env.REQUIRE_ZHIHU === '1') throw error;
}
