import { readFile, writeFile } from 'node:fs/promises';
import { categoryFor, fingerprintTitle, scoreItem, topicStatus } from '../src/utils.js';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const ENDPOINT = 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc';
const nowIso = new Date().toISOString();

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
}

async function fetchBoard(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 trend-radar/1.4',
        accept: 'application/json,text/plain,*/*',
        referer: 'https://www.toutiao.com/'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function pickRows(body) {
  const candidates = [body?.data, body?.Data, body?.data?.data, body?.data?.list, body?.list];
  return candidates.find(Array.isArray) || [];
}

function normalizeRows(rows) {
  return rows.map((row, index) => ({
    title: String(row?.Title || row?.title || row?.word || '').trim(),
    url: String(row?.Url || row?.url || row?.Schema || row?.schema || '').trim(),
    heat: Number(row?.HotValue || row?.hot_value || row?.hotValue || row?.Heat || row?.heat || 0) || 0,
    rank: index + 1
  })).filter(row => row.title);
}

function isToutiaoUrl(value) {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'toutiao.com' || hostname.endsWith('.toutiao.com');
  } catch {
    return false;
  }
}

function makeTopic(row, total, capturedAt) {
  const score = scoreItem(row.rank, total, row.heat, 0);
  const breakout = clamp(score * (row.rank <= 5 ? 0.95 : row.rank <= 10 ? 0.8 : 0.62));
  const id = fingerprintTitle(row.title);
  const fallbackUrl = `https://www.toutiao.com/search/?keyword=${encodeURIComponent(row.title)}`;
  const sourceUrl = isToutiaoUrl(row.url) ? row.url : fallbackUrl;
  return {
    id,
    fingerprint: id,
    canonical_title: row.title,
    category: categoryFor('toutiao', row.title),
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
      source_id: 'toutiao',
      external_id: `toutiao:${id}`,
      url: sourceUrl,
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
  const body = await fetchBoard();
  const rows = normalizeRows(pickRows(body)).slice(0, 20);
  if (!rows.length) throw new Error(`Toutiao hot board returned no usable rows; keys=${Object.keys(body || {}).join(',')}`);
  const offDomainCount = rows.filter(row => row.url && !isToutiaoUrl(row.url)).length;
  const topics = rows.map(row => makeTopic(row, rows.length, capturedAt));
  dashboard.topics = mergeTopics(dashboard.topics, topics);
  setSource(dashboard, {
    id: 'toutiao',
    name: '今日头条热榜',
    region: 'cn',
    kind: 'official-api',
    last_success_at: capturedAt,
    last_error_at: null,
    last_error: null,
    last_item_count: topics.length
  });
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.log(`OK toutiao: ${topics.length}; dashboard topics=${dashboard.topics.length}; sanitizedOffDomain=${offDomainCount}`);
} catch (error) {
  const message = String(error?.message || error).slice(0, 300);
  setSource(dashboard, {
    id: 'toutiao',
    name: '今日头条热榜',
    region: 'cn',
    kind: 'official-api',
    last_success_at: null,
    last_error_at: nowIso,
    last_error: message,
    last_item_count: 0
  });
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.warn(`FAIL toutiao: ${message}`);
  if (process.env.REQUIRE_TOUTIAO === '1') throw error;
}
