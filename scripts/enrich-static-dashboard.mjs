import { readFile, writeFile } from 'node:fs/promises';
import { categoryFor, fingerprintTitle, scoreItem, topicStatus } from '../src/utils.js';
import { metricMetadata } from '../src/source-metadata.js';

const DASHBOARD = new URL('../public/data/dashboard.json', import.meta.url);
const nowIso = new Date().toISOString();

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
}

async function fetchResponse(url, { accept, timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 trend-radar/1.1',
        accept: accept || '*/*',
        referer: url.includes('bilibili.com') ? 'https://www.bilibili.com/' : undefined
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 12000) {
  const res = await fetchResponse(url, {
    timeoutMs,
    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5'
  });
  return await res.text();
}

async function fetchJson(url, timeoutMs = 12000) {
  const res = await fetchResponse(url, { timeoutMs, accept: 'application/json, text/plain, */*' });
  return await res.json();
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
  const tagText = stripHtml(tagValue(block, 'link'));
  if (tagText) return tagText;
  const href = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  return href ? decodeXml(href[1]).trim() : '';
}

function parseFeed(xml) {
  const text = String(xml);
  const rssBlocks = text.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  const atomBlocks = rssBlocks.length ? [] : (text.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || []);
  return [...rssBlocks, ...atomBlocks].map(block => ({
    title: stripHtml(tagValue(block, 'title')),
    link: linkValue(block),
    description: stripHtml(tagValue(block, 'description') || tagValue(block, 'summary') || tagValue(block, 'content')),
    published: stripHtml(tagValue(block, 'pubDate') || tagValue(block, 'published') || tagValue(block, 'updated'))
  })).filter(row => row.title);
}

function makeTopic({ sourceId, title, url = '', summary = '', rank, total, heat = null, engagement = null, capturedAt, upstream = null }) {
  const score = scoreItem(rank, total, 0, 0);
  const breakout = clamp(score * (rank <= 5 ? 0.92 : rank <= 10 ? 0.76 : 0.58));
  const id = fingerprintTitle(title);
  return {
    id,
    fingerprint: id,
    canonical_title: title,
    category: categoryFor(sourceId, title),
    language: /[\u3400-\u9fff]/.test(title) ? 'zh' : 'en',
    first_seen_at: capturedAt,
    last_seen_at: capturedAt,
    current_score: Number(score.toFixed(1)),
    breakout_score: Number(breakout.toFixed(1)),
    source_count: 1,
    mention_count: 1,
    status: topicStatus(score, breakout),
    source_summary: summary || null,
    ai_summary: null,
    ai_why_now: null,
    opportunities: [],
    sources: [{
      source_id: sourceId,
      external_id: `${sourceId}:${rank}:${id}`,
      url,
      title,
      rank,
      captured_at: capturedAt
    }],
    raw_signals: [{
      source_id: sourceId,
      source_kind: sourceId === 'sspai' ? 'official-rss' : 'official-api',
      metric_definition: metricMetadata(sourceId),
      raw_heat_max: heat === null || heat === undefined ? null : Number(heat),
      raw_engagement_max: engagement === null || engagement === undefined ? null : Number(engagement),
      raw_heat_latest: heat === null || heat === undefined ? null : Number(heat),
      raw_engagement_latest: engagement === null || engagement === undefined ? null : Number(engagement),
      best_rank: rank,
      observations: 1,
      latest_captured_at: capturedAt,
      upstream,
      metric_paths: sourceId === 'bilibili'
        ? { heat: 'data.list[].stat.view', engagement: 'stat.like+reply+coin+favorite+share+danmaku' }
        : { heat: null, engagement: null },
      units: 'source-native; not comparable across platforms'
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
    const sourceIds = new Set((old.sources || []).map(s => s.source_id));
    old.sources = [...(old.sources || []), ...(topic.sources || []).filter(s => !sourceIds.has(s.source_id))];
    old.source_count = new Set(old.sources.map(s => s.source_id)).size;
    old.mention_count = Math.max(Number(old.mention_count || 0), old.sources.length);
    old.current_score = Math.max(Number(old.current_score || 0), Number(topic.current_score || 0));
    old.breakout_score = Math.max(Number(old.breakout_score || 0), Number(topic.breakout_score || 0));
    old.status = topicStatus(old.current_score, old.breakout_score);
  }
  return [...byId.values()]
    .sort((a, b) => Number(b.current_score || 0) - Number(a.current_score || 0) || Number(b.breakout_score || 0) - Number(a.breakout_score || 0))
    .slice(0, 180);
}

function categorySummary(topics) {
  const map = new Map();
  for (const topic of topics) {
    const row = map.get(topic.category) || { category: topic.category, count: 0, total: 0 };
    row.count += 1;
    row.total += Number(topic.current_score || 0);
    map.set(topic.category, row);
  }
  return [...map.values()]
    .map(row => ({
      category: row.category,
      count: row.count,
      avg_score: Number((row.total / row.count).toFixed(1))
    }))
    .sort((a, b) => b.count - a.count);
}

function refreshTimeline(dashboard) {
  const topics = dashboard.topics || [];
  const avgScore = topics.length ? topics.reduce((sum, x) => sum + Number(x.current_score || 0), 0) / topics.length : 0;
  const avgBreakout = topics.length ? topics.reduce((sum, x) => sum + Number(x.breakout_score || 0), 0) / topics.length : 0;
  const t = new Date(dashboard.generatedAt || nowIso);
  t.setMinutes(0, 0, 0);
  dashboard.timeline = [{
    t: t.toISOString(),
    score: Number(avgScore.toFixed(1)),
    breakout: Number(avgBreakout.toFixed(1))
  }];
}

function setSource(dashboard, source) {
  dashboard.sources = [
    ...(dashboard.sources || []).filter(existing => existing.id !== source.id),
    source
  ];
}

async function enrichSspai(dashboard, capturedAt) {
  try {
    const xml = await fetchText('https://sspai.com/feed');
    const rows = parseFeed(xml).slice(0, 25);
    if (!rows.length) throw new Error(`feed parsed zero entries; prefix=${JSON.stringify(xml.slice(0, 100))}`);
    const topics = rows.map((row, i) => makeTopic({
      sourceId: 'sspai',
      title: row.title,
      url: row.link,
      summary: row.description ? row.description.slice(0, 180) : '少数派 RSS',
      rank: i + 1,
      total: rows.length,
      capturedAt,
      upstream: 'https://sspai.com/feed'
    }));
    dashboard.topics = mergeTopics(dashboard.topics, topics);
    setSource(dashboard, {
      id: 'sspai',
      name: '少数派',
      region: 'cn',
      kind: 'official-rss',
      last_success_at: capturedAt,
      last_error_at: null,
      last_error: null,
      last_item_count: topics.length,
      latest_upstream: 'https://sspai.com/feed'
    });
    console.log(`OK sspai: ${topics.length}; dashboard topics=${dashboard.topics.length}`);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300);
    setSource(dashboard, {
      id: 'sspai',
      name: '少数派',
      region: 'cn',
      kind: 'official-rss',
      last_success_at: null,
      last_error_at: nowIso,
      last_error: message,
      last_item_count: 0
    });
    console.warn(`FAIL sspai: ${message}`);
    if (process.env.REQUIRE_SSPAI === '1') throw error;
  }
}

async function enrichBilibili(dashboard, capturedAt) {
  try {
    const body = await fetchJson('https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1');
    if (Number(body?.code) !== 0) throw new Error(`API code ${body?.code}: ${body?.message || 'unknown error'}`);
    const rows = Array.isArray(body?.data?.list) ? body.data.list.slice(0, 20) : [];
    if (!rows.length) throw new Error('popular API returned no videos');
    const topics = rows.map((item, i) => {
      const stat = item?.stat || {};
      const heat = stat.view === null || stat.view === undefined ? null : Number(stat.view);
      const presentEngagement = ['like', 'reply', 'coin', 'favorite', 'share', 'danmaku']
        .map(key => stat[key])
        .filter(value => value !== null && value !== undefined && value !== '')
        .map(Number)
        .filter(value => Number.isFinite(value) && value >= 0);
      const engagement = presentEngagement.length ? presentEngagement.reduce((sum, value) => sum + value, 0) : null;
      const owner = String(item?.owner?.name || '').trim();
      const tname = String(item?.tname || '').trim();
      return makeTopic({
        sourceId: 'bilibili',
        title: String(item?.title || '').trim(),
        url: item?.bvid ? `https://www.bilibili.com/video/${item.bvid}` : String(item?.short_link_v2 || ''),
        summary: [tname && `B站 · ${tname}`, owner && `UP ${owner}`].filter(Boolean).join(' · '),
        rank: i + 1,
        total: rows.length,
        heat,
        engagement,
        capturedAt,
        upstream: 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1'
      });
    }).filter(topic => topic.canonical_title);
    if (!topics.length) throw new Error('popular API returned no usable titles');
    dashboard.topics = mergeTopics(dashboard.topics, topics);
    setSource(dashboard, {
      id: 'bilibili',
      name: '哔哩哔哩',
      region: 'cn',
      kind: 'official-api',
      last_success_at: capturedAt,
      last_error_at: null,
      last_error: null,
      last_item_count: topics.length,
      latest_upstream: 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1'
    });
    console.log(`OK bilibili: ${topics.length}; dashboard topics=${dashboard.topics.length}`);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300);
    setSource(dashboard, {
      id: 'bilibili',
      name: '哔哩哔哩',
      region: 'cn',
      kind: 'official-api',
      last_success_at: null,
      last_error_at: nowIso,
      last_error: message,
      last_item_count: 0
    });
    console.warn(`FAIL bilibili: ${message}`);
    if (process.env.REQUIRE_BILIBILI === '1') throw error;
  }
}

async function main() {
  const dashboard = JSON.parse(await readFile(DASHBOARD, 'utf8'));
  const capturedAt = nowIso;

  await enrichSspai(dashboard, capturedAt);
  await enrichBilibili(dashboard, capturedAt);
  dashboard.categories = categorySummary(dashboard.topics || []);
  refreshTimeline(dashboard);
  await writeFile(DASHBOARD, JSON.stringify(dashboard, null, 2) + '\n', 'utf8');
}

await main();
