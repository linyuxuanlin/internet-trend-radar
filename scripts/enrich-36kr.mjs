import { readFile, writeFile } from 'node:fs/promises';
import { categoryFor, fingerprintTitle, scoreItem, topicStatus } from '../src/utils.js';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const nowIso = new Date().toISOString();

const FEEDS = [
  ['https://www.36kr.com/feed', '综合资讯'],
  ['https://36kr.com/feed', '综合资讯'],
  ['https://www.36kr.com/feed-article', '文章资讯'],
  ['https://36kr.com/feed-article', '文章资讯'],
  ['https://www.36kr.com/feed-newsflash', '最新快讯'],
  ['https://36kr.com/feed-newsflash', '最新快讯'],
  ['https://www.36kr.com/feed-moment', '动态内容'],
  ['https://36kr.com/feed-moment', '动态内容']
];

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
}

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 trend-radar/1.2',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain;q=0.8, */*;q=0.5',
        referer: 'https://www.36kr.com/rss-center'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
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

function linkValue(block) {
  const text = stripHtml(tagValue(block, 'link'));
  if (text) return text;
  const href = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  return href ? decodeXml(href[1]).trim() : '';
}

function parseFeed(xml) {
  const text = String(xml);
  const itemBlocks = text.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  const entryBlocks = itemBlocks.length ? [] : (text.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || []);
  return [...itemBlocks, ...entryBlocks].map(block => ({
    title: stripHtml(tagValue(block, 'title')),
    link: linkValue(block),
    description: stripHtml(tagValue(block, 'description') || tagValue(block, 'summary') || tagValue(block, 'content')),
    published: stripHtml(tagValue(block, 'pubDate') || tagValue(block, 'published') || tagValue(block, 'updated'))
  })).filter(row => row.title);
}

function makeTopic(row, rank, total, capturedAt) {
  const score = scoreItem(rank, total, 0, 0);
  const breakout = clamp(score * (rank <= 5 ? 0.92 : rank <= 10 ? 0.76 : 0.58));
  const id = fingerprintTitle(row.title);
  return {
    id,
    fingerprint: id,
    canonical_title: row.title,
    category: categoryFor('36kr', row.title),
    language: /[\u3400-\u9fff]/.test(row.title) ? 'zh' : 'en',
    first_seen_at: capturedAt,
    last_seen_at: capturedAt,
    current_score: Number(score.toFixed(1)),
    breakout_score: Number(breakout.toFixed(1)),
    source_count: 1,
    mention_count: 1,
    status: topicStatus(score, breakout),
    ai_summary: [`36氪 · ${row.label}`, row.description ? row.description.slice(0, 140) : ''].filter(Boolean).join(' · '),
    ai_why_now: null,
    opportunities: [],
    sources: [{
      source_id: '36kr',
      external_id: `36kr:${rank}:${id}`,
      url: row.link,
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

async function main() {
  const dashboard = JSON.parse(await readFile(DASHBOARD, 'utf8'));
  const capturedAt = dashboard.generatedAt || nowIso;
  const collected = [];
  const errors = [];
  const seenFeedUrls = new Set();

  for (const [url, label] of FEEDS) {
    if (seenFeedUrls.has(url)) continue;
    seenFeedUrls.add(url);
    try {
      const xml = await fetchText(url);
      const rows = parseFeed(xml);
      if (!rows.length) throw new Error(`parsed zero entries; prefix=${JSON.stringify(xml.slice(0, 120))}`);
      for (const row of rows.slice(0, 20)) collected.push({ ...row, label });
      if (collected.length >= 30) break;
    } catch (error) {
      errors.push(`${url}: ${String(error?.message || error).slice(0, 180)}`);
    }
  }

  const seen = new Set();
  const rows = collected.filter(row => {
    const key = fingerprintTitle(row.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 30);

  if (!rows.length) {
    const message = (errors.join('; ') || 'all official feeds returned no usable items').slice(0, 800);
    setSource(dashboard, {
      id: '36kr', name: '36氪', region: 'cn', kind: 'official-rss',
      last_success_at: null, last_error_at: nowIso, last_error: message, last_item_count: 0
    });
    await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
    console.warn(`FAIL 36kr: ${message}`);
    if (process.env.REQUIRE_36KR === '1') throw new Error(message);
    return;
  }

  const topics = rows.map((row, index) => makeTopic(row, index + 1, rows.length, capturedAt));
  dashboard.topics = mergeTopics(dashboard.topics, topics);
  dashboard.categories = categorySummary(dashboard.topics);
  setSource(dashboard, {
    id: '36kr', name: '36氪', region: 'cn', kind: 'official-rss',
    last_success_at: capturedAt, last_error_at: null, last_error: null, last_item_count: topics.length
  });
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
  console.log(`OK 36kr: ${topics.length}; dashboard topics=${dashboard.topics.length}`);
}

await main();
