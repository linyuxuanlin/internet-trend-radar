import { readFile, writeFile } from 'node:fs/promises';
import { categoryFor, fingerprintTitle, scoreItem, topicStatus } from '../src/utils.js';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const API = 'https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed';
const nowIso = new Date().toISOString();

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
}

async function fetchJuejin(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 trend-radar/1.2',
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        origin: 'https://juejin.cn',
        referer: 'https://juejin.cn/'
      },
      body: JSON.stringify({
        id_type: 2,
        client_type: 2608,
        sort_type: 200,
        cursor: '0',
        limit: 20
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRows(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.map(row => {
    const item = row?.item_info || row?.item || row || {};
    const article = item?.article_info || row?.article_info || {};
    const author = item?.author_user_info || row?.author_user_info || {};
    const articleId = String(article?.article_id || item?.article_id || row?.article_id || '').trim();
    const title = String(article?.title || item?.title || row?.title || '').trim();
    const summary = String(article?.brief_content || item?.brief_content || row?.brief_content || '').trim();
    const heat = Number(article?.view_count || item?.view_count || 0);
    const engagement = ['digg_count', 'comment_count', 'collect_count', 'share_count']
      .reduce((sum, key) => sum + Number(article?.[key] || item?.[key] || 0), 0);
    return {
      articleId,
      title,
      summary,
      author: String(author?.user_name || '').trim(),
      heat,
      engagement
    };
  }).filter(row => row.title && row.articleId);
}

function makeTopic(row, rank, total, capturedAt) {
  const score = scoreItem(rank, total, row.heat, row.engagement);
  const breakout = clamp(score * (rank <= 5 ? 0.92 : rank <= 10 ? 0.76 : 0.58));
  const id = fingerprintTitle(row.title);
  return {
    id,
    fingerprint: id,
    canonical_title: row.title,
    category: categoryFor('juejin', row.title),
    language: /[\u3400-\u9fff]/.test(row.title) ? 'zh' : 'en',
    first_seen_at: capturedAt,
    last_seen_at: capturedAt,
    current_score: Number(score.toFixed(1)),
    breakout_score: Number(breakout.toFixed(1)),
    source_count: 1,
    mention_count: 1,
    status: topicStatus(score, breakout),
    ai_summary: [row.summary.slice(0, 160), row.author && `作者 ${row.author}`].filter(Boolean).join(' · ') || null,
    ai_why_now: null,
    opportunities: [],
    sources: [{
      source_id: 'juejin',
      external_id: `juejin:${row.articleId}`,
      url: `https://juejin.cn/post/${row.articleId}`,
      title: row.title,
      rank,
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
  const body = await fetchJuejin();
  if (Number(body?.err_no || 0) !== 0) throw new Error(`API err_no ${body?.err_no}: ${body?.err_msg || 'unknown error'}`);
  const rows = normalizeRows(body).slice(0, 20);
  if (!rows.length) throw new Error(`recommend API returned no usable articles; keys=${Object.keys(body || {}).join(',')}`);
  const topics = rows.map((row, index) => makeTopic(row, index + 1, rows.length, capturedAt));
  dashboard.topics = mergeTopics(dashboard.topics, topics);
  setSource(dashboard, {
    id: 'juejin',
    name: '掘金',
    region: 'cn',
    kind: 'official-api',
    last_success_at: capturedAt,
    last_error_at: null,
    last_error: null,
    last_item_count: topics.length
  });
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.log(`OK juejin: ${topics.length}; dashboard topics=${dashboard.topics.length}`);
} catch (error) {
  const message = String(error?.message || error).slice(0, 300);
  setSource(dashboard, {
    id: 'juejin',
    name: '掘金',
    region: 'cn',
    kind: 'official-api',
    last_success_at: null,
    last_error_at: nowIso,
    last_error: message,
    last_item_count: 0
  });
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.warn(`FAIL juejin: ${message}`);
  if (process.env.REQUIRE_JUEJIN === '1') throw error;
}
