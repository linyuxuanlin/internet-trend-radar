import { readFile, writeFile } from 'node:fs/promises';
import { categoryFor, fingerprintTitle, scoreItem, topicStatus } from '../src/utils.js';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const FEED = 'https://www.ithome.com/rss/';
const nowIso = new Date().toISOString();
const MAX_FEED_ITEM_AGE_MS = Number(process.env.MAX_FEED_ITEM_AGE_MS || 7 * 24 * 60 * 60 * 1000);
const MAX_FUTURE_SKEW_MS = Number(process.env.MAX_FUTURE_SKEW_MS || 5 * 60 * 1000);
const MIN_FRESH_FEED_ITEMS = Number(process.env.MIN_FRESH_FEED_ITEMS || 5);

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
}

async function fetchFeed(timeoutMs = 15000) {
  const response = await fetch(FEED, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 trend-radar/1.8',
      accept: 'application/rss+xml, application/xml, text/xml, */*;q=0.5',
      referer: 'https://www.ithome.com/'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

function decodeXml(text = '') {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripHtml(text = '') {
  return decodeXml(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tagValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

function parsePublishedAt(value) {
  const timestamp = Date.parse(String(value || '').trim());
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseFeed(xml) {
  const blocks = String(xml).match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  return blocks.map((block, index) => ({
    title: stripHtml(tagValue(block, 'title')),
    link: stripHtml(tagValue(block, 'link')),
    description: stripHtml(tagValue(block, 'description')),
    published_at: parsePublishedAt(stripHtml(tagValue(block, 'pubDate'))),
    rank: index + 1
  })).filter(row => row.title && row.link);
}

function freshRows(rows, now = Date.now()) {
  return rows.filter(row => {
    const publishedAt = Date.parse(row.published_at);
    if (!Number.isFinite(publishedAt)) return false;
    const ageMs = now - publishedAt;
    return ageMs >= -MAX_FUTURE_SKEW_MS && ageMs <= MAX_FEED_ITEM_AGE_MS;
  });
}

function makeTopic(row, total, capturedAt) {
  const score = scoreItem(row.rank, total, 0, 0);
  const breakout = clamp(score * (row.rank <= 5 ? 0.92 : row.rank <= 10 ? 0.76 : 0.58));
  const id = fingerprintTitle(row.title);
  return {
    id,
    fingerprint: id,
    canonical_title: row.title,
    category: categoryFor('ithome', row.title),
    language: /[\u3400-\u9fff]/.test(row.title) ? 'zh' : 'en',
    first_seen_at: capturedAt,
    last_seen_at: capturedAt,
    current_score: Number(score.toFixed(1)),
    breakout_score: Number(breakout.toFixed(1)),
    source_count: 1,
    mention_count: 1,
    status: topicStatus(score, breakout),
    ai_summary: row.description ? `IT之家 · ${row.description.slice(0, 140)}` : 'IT之家 RSS 最新资讯',
    ai_why_now: null,
    opportunities: [],
    sources: [{
      source_id: 'ithome',
      external_id: `ithome:${id}`,
      url: row.link,
      title: row.title,
      rank: row.rank,
      captured_at: capturedAt,
      published_at: row.published_at
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
    .slice(0, 220);
}

function setSource(dashboard, source) {
  dashboard.sources = [...(dashboard.sources || []).filter(existing => existing.id !== source.id), source];
}

function categorySummary(topics) {
  const map = new Map();
  for (const topic of topics || []) {
    const row = map.get(topic.category) || { category: topic.category, count: 0, total: 0 };
    row.count += 1;
    row.total += Number(topic.current_score || 0);
    map.set(topic.category, row);
  }
  return [...map.values()]
    .map(row => ({ category: row.category, count: row.count, avg_score: Number((row.total / row.count).toFixed(1)) }))
    .sort((a, b) => b.count - a.count);
}

const dashboard = JSON.parse(await readFile(DASHBOARD, 'utf8'));
const capturedAt = dashboard.generatedAt || nowIso;

try {
  const xml = await fetchFeed();
  const parsedRows = parseFeed(xml);
  if (!parsedRows.length) throw new Error(`RSS returned no usable items; prefix=${JSON.stringify(xml.slice(0, 120))}`);
  const rows = freshRows(parsedRows).slice(0, 20);
  if (rows.length < MIN_FRESH_FEED_ITEMS) {
    throw new Error(`RSS freshness gate failed: fresh=${rows.length} parsed=${parsedRows.length} min=${MIN_FRESH_FEED_ITEMS} maxAgeMs=${MAX_FEED_ITEM_AGE_MS}`);
  }

  const topics = rows.map(row => makeTopic(row, rows.length, capturedAt));
  dashboard.topics = mergeTopics(dashboard.topics, topics);
  dashboard.categories = categorySummary(dashboard.topics);
  setSource(dashboard, {
    id: 'ithome',
    name: 'IT之家',
    region: 'cn',
    kind: 'official-rss',
    last_success_at: capturedAt,
    last_error_at: null,
    last_error: null,
    last_item_count: topics.length
  });
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.log(`OK ithome: ${topics.length} fresh RSS items; dashboard topics=${dashboard.topics.length}`);
} catch (error) {
  const message = String(error?.message || error).slice(0, 300);
  setSource(dashboard, {
    id: 'ithome',
    name: 'IT之家',
    region: 'cn',
    kind: 'official-rss',
    last_success_at: null,
    last_error_at: nowIso,
    last_error: message,
    last_item_count: 0
  });
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.warn(`FAIL ithome: ${message}`);
  if (process.env.REQUIRE_ITHOME === '1') throw error;
}
