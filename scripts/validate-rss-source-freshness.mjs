const MAX_ITEM_AGE_MS = Number(process.env.MAX_FEED_ITEM_AGE_MS || 7 * 24 * 60 * 60 * 1000);
const FUTURE_SKEW_MS = Number(process.env.MAX_FUTURE_SKEW_MS || 5 * 60 * 1000);
const MIN_FRESH_ITEMS = Number(process.env.MIN_FRESH_RSS_ITEMS || 5);

const SOURCES = [
  { id: 'sspai', feeds: ['https://sspai.com/feed'] },
  {
    id: '36kr',
    feeds: [
      'https://36kr.com/feed',
      'https://36kr.com/feed-article',
      'https://36kr.com/feed-newsflash',
      'https://36kr.com/feed-moment'
    ]
  }
];

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
  const items = text.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  const entries = items.length ? [] : (text.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || []);
  return [...items, ...entries].map(block => ({
    title: stripHtml(tagValue(block, 'title')),
    link: linkValue(block),
    published: stripHtml(tagValue(block, 'pubDate') || tagValue(block, 'published') || tagValue(block, 'updated'))
  })).filter(row => row.title);
}

async function fetchText(url, accept = 'text/html, */*;q=0.5') {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      accept,
      'user-agent': 'Mozilla/5.0 trend-radar-rss-freshness/1.1',
      referer: url.includes('36kr.com') ? 'https://www.36kr.com/rss-center' : undefined
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchFeed(url) {
  return fetchText(url, 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5');
}

function freshTimestamp(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const ageMs = Date.now() - timestamp;
  if (ageMs < -FUTURE_SKEW_MS || ageMs > MAX_ITEM_AGE_MS) return null;
  return timestamp;
}

function timestampFrom36KrPage(html) {
  const text = String(html);
  const isoPatterns = [
    /["']datePublished["']\s*:\s*["']([^"']+)["']/i,
    /property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
    /name=["']article:published_time["'][^>]*content=["']([^"']+)["']/i
  ];
  for (const pattern of isoPatterns) {
    const match = text.match(pattern);
    const timestamp = match ? freshTimestamp(match[1]) : null;
    if (timestamp !== null) return timestamp;
  }

  const epochMatch = text.match(/["'](?:publishTime|publish_time|publishedAt)["']\s*:\s*(\d{10,13})/i);
  if (epochMatch) {
    const raw = Number(epochMatch[1]);
    const timestamp = raw < 1e12 ? raw * 1000 : raw;
    const ageMs = Date.now() - timestamp;
    if (Number.isFinite(timestamp) && ageMs >= -FUTURE_SKEW_MS && ageMs <= MAX_ITEM_AGE_MS) return timestamp;
  }
  return null;
}

async function resolve36KrPageTimestamps(rows, errors) {
  const candidates = rows.filter(row => {
    try {
      const url = new URL(row.link);
      return url.protocol === 'https:' && (url.hostname === '36kr.com' || url.hostname.endsWith('.36kr.com'));
    } catch {
      return false;
    }
  }).slice(0, 12);

  const results = await Promise.allSettled(candidates.map(async row => {
    const html = await fetchText(row.link);
    return { row, timestamp: timestampFrom36KrPage(html) };
  }));

  const resolved = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      errors.push(`article-page: ${String(result.reason?.message || result.reason)}`);
      continue;
    }
    if (result.value.timestamp !== null) resolved.push(result.value);
  }
  return resolved;
}

let failed = false;
const results = [];

for (const source of SOURCES) {
  const fresh = new Map();
  const errors = [];
  for (const url of source.feeds) {
    try {
      const rows = parseFeed(await fetchFeed(url));
      for (const row of rows) {
        const timestamp = freshTimestamp(row.published);
        if (timestamp !== null) fresh.set(`${row.title}\n${timestamp}`, timestamp);
      }

      if (source.id === '36kr' && fresh.size < MIN_FRESH_ITEMS) {
        for (const { row, timestamp } of await resolve36KrPageTimestamps(rows, errors)) {
          fresh.set(`${row.title}\n${timestamp}`, timestamp);
        }
      }
      if (fresh.size >= MIN_FRESH_ITEMS) break;
    } catch (error) {
      errors.push(`${url}: ${String(error?.message || error)}`);
    }
  }

  const timestamps = [...fresh.values()];
  const result = {
    id: source.id,
    freshItems: fresh.size,
    newestPublishedAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    oldestFreshPublishedAt: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    errors
  };
  results.push(result);
  if (fresh.size < MIN_FRESH_ITEMS) {
    failed = true;
    console.error(`RSS_FRESHNESS_FAIL ${source.id}: freshItems=${fresh.size} < ${MIN_FRESH_ITEMS}; ${errors.join('; ')}`);
  }
}

console.log(JSON.stringify({
  ok: !failed,
  maxItemAgeSeconds: Math.round(MAX_ITEM_AGE_MS / 1000),
  minFreshItems: MIN_FRESH_ITEMS,
  sources: results
}, null, 2));

if (failed) process.exitCode = 1;
